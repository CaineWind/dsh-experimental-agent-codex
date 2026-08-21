/** Codex app-server JSON-RPC adapter for one long-lived Harness Agent. */

import type { Readable, Writable } from 'node:stream'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { CodexThreadId, type CodexApprovalPolicy, type CodexSandboxMode, type CodexThreadId as ThreadId } from './types.ts'

type JsonObject = Record<string, unknown>

/** Stream callbacks for one Codex turn. */
export interface CodexTurnObserver {
  /** Observe final-answer text bytes in order. */
  delta(text: string): void
  /** Observe the latest per-turn token accounting. */
  usage(usage: TokenUsage): void
}

/** Terminal facts returned by one Codex turn. */
export interface CodexTurnResult {
  readonly status: 'completed' | 'interrupted'
  readonly text: string
  readonly usage?: TokenUsage
}

/** Thread creation inputs supported by the public app-server protocol. */
export interface StartThreadOptions {
  readonly cwd: string
  readonly approvalPolicy: CodexApprovalPolicy
  readonly sandbox: CodexSandboxMode
  readonly model?: string
  readonly developerInstructions?: string
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`agent-codex: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`agent-codex: app-server returned invalid ${label}`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function tokenUsage(value: unknown): TokenUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fields = value as JsonObject
  const rawInput = count(fields.inputTokens)
  const outputTokens = count(fields.outputTokens)
  if (rawInput === undefined || outputTokens === undefined) return undefined
  const cacheReadTokens = count(fields.cachedInputTokens ?? fields.cacheReadTokens) ?? 0
  const cacheWriteTokens = count(fields.cacheWriteTokens) ?? 0
  const reasoningTokens = count(fields.reasoningOutputTokens ?? fields.reasoningTokens)
  return {
    inputTokens: Math.max(0, rawInput - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    ...(cacheReadTokens === 0 ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === 0 ? {} : { cacheWriteTokens }),
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

function unattendedDecision(params: JsonObject): 'cancel' | 'decline' {
  const available = params.availableDecisions
  if (!Array.isArray(available)) return 'decline'
  if (available.includes('cancel')) return 'cancel'
  if (available.includes('decline')) return 'decline'
  throw new Error('agent-codex: app-server offered no safe unattended approval decision')
}

/** One initialized app-server connection with one active thread and at most one active turn. */
export class CodexAppServerWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private threadId: ThreadId | undefined
  private turnId: string | undefined
  private active: {
    readonly observer: CodexTurnObserver
    readonly completion: PromiseWithResolvers<CodexTurnResult>
    readonly itemPhases: Map<string, unknown>
    text: string
    usage?: TokenUsage
  } | undefined
  private closed = false

  constructor(input: Readable, output: Writable) {
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fail(error)
      }
    })
    input.on('end', () => { this.fail(new Error('agent-codex: app-server protocol stream closed')) })
    input.on('error', error => { this.fail(error) })
    output.on('error', error => { this.fail(error) })
  }

  /** Begin reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /** Perform the required initialize/initialized handshake and return the observed server version. */
  async initialize(signal: AbortSignal): Promise<string> {
    const response = object(await this.guarded(this.transport.request('initialize', {
      clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }, signal)), 'initialize response')
    const serverInfo = response.serverInfo === undefined ? undefined : object(response.serverInfo, 'serverInfo')
    const version = optionalString(serverInfo?.version) ?? optionalString(response.version) ?? 'unknown'
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
    return version
  }

  /** Create and retain a durable Codex thread. */
  async startThread(options: StartThreadOptions, signal: AbortSignal): Promise<ThreadId> {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
      ephemeral: false,
      ...options.model === undefined ? {} : { model: options.model },
      ...options.developerInstructions === undefined || options.developerInstructions.length === 0
        ? {}
        : { developerInstructions: options.developerInstructions },
    }, signal)), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    const id = CodexThreadId(string(thread.id, 'thread/start thread id'))
    this.threadId = id
    return id
  }

  /** Resume one user-managed Codex thread and verify its identity. */
  async resumeThread(threadId: ThreadId, signal: AbortSignal): Promise<void> {
    const response = object(await this.guarded(this.transport.request('thread/resume', {
      threadId,
    }, signal)), 'thread/resume response')
    const thread = object(response.thread, 'thread/resume thread')
    if (string(thread.id, 'thread/resume thread id') !== threadId) {
      throw new Error('agent-codex: app-server resumed a different thread')
    }
    this.threadId = threadId
  }

  /** Start one text turn and await its authoritative terminal notification. */
  async runTurn(texts: readonly string[], observer: CodexTurnObserver, signal: AbortSignal): Promise<CodexTurnResult> {
    if (this.active !== undefined) throw new Error('agent-codex: a Codex turn is already active')
    const threadId = this.requireThread()
    const completion = Promise.withResolvers<CodexTurnResult>()
    this.active = { observer, completion, itemPhases: new Map(), text: '' }
    try {
      const response = object(await this.guarded(this.transport.request('turn/start', {
        threadId,
        input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
      }, signal)), 'turn/start response')
      const turn = object(response.turn, 'turn/start turn')
      this.turnId = string(turn.id, 'turn/start turn id')
      return await this.guarded(completion.promise, signal)
    } finally {
      this.active = undefined
      this.turnId = undefined
    }
  }

  /** Add user text to the active Codex turn. */
  async steer(texts: readonly string[], signal: AbortSignal): Promise<void> {
    const threadId = this.requireThread()
    if (this.turnId === undefined) throw new Error('agent-codex: no active turn to steer')
    await this.guarded(this.transport.request('turn/steer', {
      threadId,
      turnId: this.turnId,
      input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
    }, signal))
  }

  /** Best-effort interruption of the active remote turn. */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => {})
  }

  /** Close framing and reject outstanding protocol requests. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.transport.close()
  }

  private requireThread(): ThreadId {
    if (this.threadId === undefined) throw new Error('agent-codex: no Codex thread is attached')
    return this.threadId
  }

  private guarded<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    const guarded = Promise.race([pending, this.fatal.promise])
    if (signal === undefined) return guarded
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error
      ? signal.reason
      : new Error(`agent-codex: app-server request aborted: ${String(signal.reason)}`))
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(signal.reason instanceof Error
          ? signal.reason
          : new Error(`agent-codex: app-server request aborted: ${String(signal.reason)}`))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      guarded.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort)
      })
    })
  }

  private fail(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value))
    this.active?.completion.reject(error)
    this.fatal.reject(error)
  }

  private validateIds(params: JsonObject, nullableTurn = false): void {
    if (params.threadId !== this.threadId) throw new Error('agent-codex: app-server request referenced another thread')
    if (nullableTurn && params.turnId === null) return
    if (this.turnId !== undefined && params.turnId !== this.turnId) {
      throw new Error('agent-codex: app-server request referenced another turn')
    }
  }

  private handleRequest(method: string, params: JsonObject): Promise<unknown> {
    this.validateIds(params, method === 'mcpServer/elicitation/request')
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return Promise.resolve({ decision: unattendedDecision(params) })
      case 'item/permissions/requestApproval':
        return Promise.resolve({ permissions: {}, scope: 'turn' })
      case 'item/tool/requestUserInput':
        return Promise.resolve({ answers: {} })
      case 'mcpServer/elicitation/request':
        return Promise.resolve({ action: 'decline', content: null, _meta: null })
      default:
        return Promise.reject(new Error(`agent-codex: unsupported app-server request ${JSON.stringify(method)}`))
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (params.threadId !== undefined && params.threadId !== this.threadId) return
    const active = this.active
    if (active === undefined) return
    if (method === 'turn/started') {
      const turn = object(params.turn, 'turn/started turn')
      this.turnId ??= string(turn.id, 'turn/started turn id')
      return
    }
    if (params.turnId !== undefined && this.turnId !== undefined && params.turnId !== this.turnId) return
    if (method === 'item/started') {
      const item = object(params.item, 'item/started item')
      const id = optionalString(item.id)
      if (id !== undefined && item.type === 'agentMessage') active.itemPhases.set(id, item.phase)
      return
    }
    if (method === 'item/agentMessage/delta') {
      const itemId = optionalString(params.itemId)
      const phase = itemId === undefined ? undefined : active.itemPhases.get(itemId)
      if (phase === 'commentary') return
      const delta = string(params.delta, 'agent message delta')
      active.text += delta
      active.observer.delta(delta)
      return
    }
    if (method === 'item/completed') {
      const item = object(params.item, 'item/completed item')
      if (item.type !== 'agentMessage' || item.phase === 'commentary') return
      const text = string(item.text, 'completed agent message text')
      if (active.text.length === 0) active.text = text
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const container = object(params.tokenUsage, 'token usage')
      const usage = tokenUsage(container.last ?? container)
      if (usage !== undefined) {
        active.usage = usage
        active.observer.usage(usage)
      }
      return
    }
    if (method !== 'turn/completed') return
    const turn = object(params.turn, 'turn/completed turn')
    const status = turn.status
    if (status === 'completed' || status === 'interrupted') {
      active.completion.resolve({
        status,
        text: active.text,
        ...active.usage === undefined ? {} : { usage: active.usage },
      })
      return
    }
    const error = turn.error === undefined ? '' : `: ${JSON.stringify(turn.error)}`
    active.completion.reject(new Error(`agent-codex: Codex turn ended with status ${String(status)}${error}`))
  }
}
