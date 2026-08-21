/** Harness Agent driver whose model/tool iteration is owned by Codex app-server. */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { CodexAppServerWire } from './wire.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const causes: string[] = [error.message]
    let cause = error.cause
    while (cause instanceof Error) {
      causes.push(cause.message)
      cause = cause.cause
    }
    return causes.join(': ')
  }
  return String(error)
}

function messageTexts(messages: readonly UserMessage[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'text') {
        throw new Error(`agent-codex: user message ${String(message.id)} contains unsupported ${JSON.stringify(block.type)} content`)
      }
      texts.push(block.text)
    }
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('agent-codex: a Codex turn requires non-empty text input')
  }
  return texts
}

/** One live Harness Agent backed by one Codex thread and app-server process. */
export class CodexAgent implements Agent {
  readonly inbox: Inbox
  readonly scope: Scope
  readonly ctx: Context
  private readonly dispatch: AgentEventDispatch
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()
  private steering: Promise<void> = Promise.resolve()

  constructor(
    private readonly runtimeCtx: Context,
    readonly id: SessionId,
    readonly options: AgentOptions,
    readonly session: Session,
    private readonly wire: CodexAppServerWire,
  ) {
    this.dispatch = agentEvents(runtimeCtx, this)
    this.inbox = new Inbox(session, {
      inserted: message => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: message => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(runtimeCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'running' ? 'running' : 'idle'
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const afterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    this.inbox.append(afterAbort ? 'next-turn' : target, message)
    if (!wakeup) return
    if (target === 'next-step' && this.phase.kind === 'running' && !afterAbort) {
      this.steering = this.steering.then(() => this.flushSteering()).catch((error: unknown) => {
        this.runtimeCtx.logger.warn(`agent-codex "${this.id}": steering failed: ${errorMessage(error)}`)
      })
    }
    this.wake(afterAbort)
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind === 'idle') return
    this.phase.abort.abort(cause)
    if (this.phase.kind === 'running') this.wire.interrupt()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Extract<Phase, { kind: 'maintenance' }> = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.phase = maintenance
    this.activityDone = done.promise
    return (async () => {
      try {
        return await task(maintenance.abort.signal)
      } finally {
        this.phase = { kind: 'idle', lastTurn: maintenance.lastTurn }
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wake()
        done.resolve()
      }
    })()
  }

  async whenIdle(): Promise<void> {
    let observed: Promise<void>
    do {
      await (observed = this.activityDone)
    } while (observed !== this.activityDone)
  }

  private setPhase(next: Phase): void {
    const previous = this.status
    this.phase = next
    if (previous !== this.status) this.dispatch.emit('agent/status', { status: this.status })
  }

  private wake(afterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const cause = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (cause?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || afterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const done = Promise.withResolvers<void>()
    this.activityDone = done.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    void this.runtimeCtx.agents.withInitiator(this, () => this.drive()).finally(done.resolve)
  }

  private async drive(): Promise<void> {
    try {
      while (this.inbox.hasPending && this.phase.kind === 'running') await this.runTurn()
    } catch {
      // runTurn reports the error at the live Agent boundary and closes its durable turn.
    } finally {
      if (this.phase.kind !== 'running') return
      const { turn, wakeRequested } = this.phase
      this.setPhase({ kind: 'idle', lastTurn: turn })
      if (wakeRequested && this.inbox.hasPending) this.wake()
    }
  }

  private async flushSteering(): Promise<void> {
    if (this.phase.kind !== 'running' || this.phase.abort.signal.aborted || this.inbox.nextStep.length === 0) return
    const phase = this.phase
    const messages = this.inbox.claim('next-step', phase.turn)
    try {
      await this.wire.steer(messageTexts(messages), phase.abort.signal)
      for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
    } catch (error: unknown) {
      for (const message of messages.toReversed()) this.inbox.prepend('next-step', message)
      throw error
    }
  }

  private async runTurn(): Promise<void> {
    if (this.phase.kind !== 'running') throw new Error(`agent-codex "${this.id}": turn outside running phase`)
    const phase = this.phase
    const turn = phase.turn + 1
    const step = 1
    phase.turn = turn
    phase.step = step
    this.session.append('turn/start', { turn })
    let reason: TurnEndReason = { kind: 'completed' }
    let stepStarted = false
    let assistantLogged = false
    let streamedText = ''
    let usage: TokenUsage | undefined
    const chunkSeqs: number[] = []
    try {
      const messages = this.inbox.claim('next-turn', turn)
      if (messages.length === 0) return
      const texts = messageTexts(messages)
      this.session.append('step/start', { turn, step })
      stepStarted = true
      for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
      chunkSeqs.push(this.session.append('assistant/chunk', {
        turn,
        step,
        chunk: { type: 'block-start', index: 0, blockType: 'text' },
      }).seq)
      const result = await this.wire.runTurn(texts, {
        delta: (text) => {
          streamedText += text
          chunkSeqs.push(this.session.append('assistant/chunk', {
            turn,
            step,
            chunk: { type: 'text-delta', index: 0, text },
          }).seq)
        },
        usage: value => { usage = value },
      }, phase.abort.signal)
      if (result.text.length > 0) {
        chunkSeqs.push(this.session.append('assistant/chunk', {
          turn,
          step,
          chunk: { type: 'block-end', index: 0, block: { type: 'text', text: result.text } },
        }).seq)
        if (usage !== undefined) {
          chunkSeqs.push(this.session.append('assistant/chunk', {
            turn,
            step,
            chunk: { type: 'usage', usage },
          }).seq)
        }
        this.session.append('assistant/message', {
          turn,
          step,
          message: createAssistantMessage({
            content: [{ type: 'text', text: result.text }],
            source: { provider: this.options.provider ?? 'codex', model: this.options.model ?? 'codex-default' },
          }),
          ...(usage === undefined ? {} : { usage }),
          ...(result.status === 'interrupted' ? { interrupted: true as const } : {}),
        }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
        assistantLogged = true
      }
      if (result.status === 'interrupted') {
        const cancel = phase.abort.signal.reason as AgentCancelCause | undefined
        reason = { kind: 'aborted', reason: cancel ?? { kind: 'user' } }
      }
    } catch (error: unknown) {
      if (phase.abort.signal.aborted) {
        reason = { kind: 'aborted', reason: phase.abort.signal.reason as AgentCancelCause }
        if (stepStarted && !assistantLogged && streamedText.length > 0) {
          chunkSeqs.push(this.session.append('assistant/chunk', {
            turn,
            step,
            chunk: { type: 'block-end', index: 0, block: { type: 'text', text: streamedText } },
          }).seq)
          if (usage !== undefined) {
            chunkSeqs.push(this.session.append('assistant/chunk', {
              turn,
              step,
              chunk: { type: 'usage', usage },
            }).seq)
          }
          this.session.append('assistant/message', {
            turn,
            step,
            message: createAssistantMessage({
              content: [{ type: 'text', text: streamedText }],
              source: { provider: this.options.provider ?? 'codex', model: this.options.model ?? 'codex-default' },
            }),
            interrupted: true,
            ...(usage === undefined ? {} : { usage }),
          }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
        }
      } else {
        reason = { kind: 'error', error: { code: 'CODEX_APP_SERVER', message: errorMessage(error) } }
      }
      this.dispatch.emit('agent/error', { turn, step, error })
      throw error
    } finally {
      await this.steering
      if (stepStarted) this.session.append('step/end', { turn, step })
      this.session.append('turn/end', { turn, reason })
    }
    if (this.inbox.hasPending) {
      phase.abort = new AbortController()
      phase.step = 0
      phase.wakeRequested = false
    }
  }
}
