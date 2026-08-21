/**
 * Experimental replacement AgentFactory backed by the user's Codex CLI.
 * The plugin never installs, upgrades, authenticates, or configures Codex.
 * @module @deepseek-ai/dsh-experimental-agent-codex
 */

import type { Context } from '@deepseek-ai/cordis'
import { extname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type {
  AgentFactory,
  AgentHandle,
  AgentSetup,
  AgentOptions,
  CreateAgentOptions,
  ResumeAgentOptions,
  SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { canonicalHeader, SessionPreparation, type SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { CodexAgent } from './agent.ts'
import type { CodexApprovalPolicy, CodexSandboxMode } from './types.ts'
import { CodexAppServerWire } from './wire.ts'
import './types.ts'

export { CodexAgent } from './agent.ts'
export { CodexAppServerWire } from './wire.ts'
export { CodexThreadId } from './types.ts'
export type { CodexApprovalPolicy, CodexSandboxMode } from './types.ts'

/** Cordis plugin name. */
export const name = 'agent-codex'
/** Services required by the bridge. Deliberately excludes LLM and Harness tool services. */
export const inject = ['agents', 'sessions', 'subprocess', 'systemPrompt']

const DEFAULT_COMMAND = 'codex'
const DEFAULT_ARGS = ['app-server', '--listen', 'stdio://']
const WINDOWS_COMMAND_INTERPRETER = 'cmd.exe'
const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** User-owned process selection and Codex thread policy. */
export interface Config {
  /** User-managed Codex executable path or PATH name. */
  command?: string
  /** Arguments that start app-server over stdio. */
  args?: string[]
  /** Explicit child environment layered after Harness credential scrubbing. */
  env?: Record<string, string>
  /** Fallback workspace when a Session has no `cwd`. */
  cwd?: string
  /** Codex approval policy for newly created threads. */
  approvalPolicy?: CodexApprovalPolicy
  /** Codex sandbox policy for newly created threads. */
  sandbox?: CodexSandboxMode
  /** Process-tree termination grace in milliseconds. */
  disposeGraceMs?: number
}

/** Runtime schema for the Codex AgentFactory bridge. */
export const Config: z<Config> = z.object({
  command: z.string().min(1).default(DEFAULT_COMMAND),
  args: z.array(z.string()).default(DEFAULT_ARGS),
  env: z.dict(z.string()).default({}),
  cwd: z.string().min(1),
  approvalPolicy: z.union(['untrusted', 'on-failure', 'on-request', 'never']).default('never'),
  sandbox: z.union(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  disposeGraceMs: z.number().min(1).max(2_147_483_647).default(DEFAULT_DISPOSE_GRACE_MS),
})

interface ResolvedConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Record<string, string>
  readonly cwd?: string
  readonly approvalPolicy: CodexApprovalPolicy
  readonly sandbox: CodexSandboxMode
  readonly disposeGraceMs: number
}

function abortError(signal: AbortSignal, id: SessionId): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`agent-codex: agent "${id}" creation aborted`, { cause: signal.reason })
}

function isWindowsCommandShim(executable: string): boolean {
  const extension = extname(executable).toLowerCase()
  return extension === '.bat' || extension === '.cmd'
}

async function raceAbort<T>(pending: Promise<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  if (signal.aborted) throw abortError(signal, id)
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(abortError(signal, id)) }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(pending).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

async function disposeProcess(wire: CodexAppServerWire | undefined, child: SubprocessHandle | undefined): Promise<void> {
  wire?.close()
  if (child === undefined) return
  try {
    child.stdin?.end()
  } catch {
    // Concurrent app-server exit can close stdin before lifecycle teardown.
  }
  child.terminate()
  await child.waitForExit()
  await child.done.catch(() => {})
}

/** Factory implementation retained only by its Cordis registration effect. */
class CodexAgentFactory implements AgentFactory {
  private readonly shutdown = new AbortController()
  private readonly active = new Set<() => Promise<void>>()

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  /** Stop and drain every app-server process created by this factory. */
  async dispose(): Promise<void> {
    this.shutdown.abort(new Error('agent-codex: provider disposed'))
    await Promise.all([...this.active].map(dispose => dispose()))
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...options.seed === undefined ? {} : { seed: options.seed },
      ...options.meta === undefined ? {} : { meta: options.meta },
    }))
    return this.prepareAndPublish(
      ownerCtx,
      preparation,
      options.sessionId,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      'startup',
    )
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('agent-codex: cannot resume without a session-persistence provider')
    }
    const ownerAbort = new AbortController()
    const unfollow = ownerCtx.effect(() => () => {
      ownerAbort.abort(new Error(`agent-codex: owner disposed while loading "${options.resumeSessionId}"`))
    }, `agentCodex.resumeLoad(${options.resumeSessionId})`)
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ownerAbort.signal,
      ...options.signal === undefined ? [] : [options.signal],
    ])
    let preparation: SessionPreparation | undefined
    try {
      preparation = await raceAbort(persistence.prepare(options.resumeSessionId, signal), signal, options.resumeSessionId)
    } finally {
      await unfollow()
    }
    if (preparation === undefined) {
      throw new Error(`agent-codex: persistence returned no session preparation for "${options.resumeSessionId}"`)
    }
    return this.prepareAndPublish(
      ownerCtx,
      preparation,
      options.resumeSessionId,
      options.agentOptions ?? {},
      options.setup,
      options.signal,
      'resume',
    )
  }

  private async prepareAndPublish(
    ownerCtx: Context,
    preparation: SessionPreparation,
    id: SessionId,
    agentOptions: AgentOptions,
    setup: AgentSetup | undefined,
    callerSignal: AbortSignal | undefined,
    source: SessionStartSource,
  ): Promise<AgentHandle> {
    using ownedPreparation = preparation
    ownerCtx.fiber.assertActive()
    const ownerAbort = new AbortController()
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ownerAbort.signal,
      ...callerSignal === undefined ? [] : [callerSignal],
    ])
    const session = ownedPreparation.session
    const cwd = session.header.cwd ?? this.config.cwd
    if (cwd === undefined) {
      throw new Error(`agent-codex: session "${id}" has no cwd and the plugin has no fallback cwd`)
    }

    let child: SubprocessHandle | undefined
    let wire: CodexAppServerWire | undefined
    let agent: CodexAgent | undefined
    let detachAgent: (() => void) | undefined
    let detachSession: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      ownerAbort.abort(new Error(`agent-codex: agent "${id}" disposed`))
      if (agent !== undefined) {
        agent.cancel({ kind: 'disposed' })
        await agent.whenIdle()
      }
      await disposeProcess(wire, child)
      await agent?.scope.dispose()
      detachAgent?.()
      detachSession?.()
      this.active.delete(dispose)
    })())
    this.active.add(dispose)
    const unfollowOwner = ownerCtx.effect(() => () => dispose(), `agentCodex.lifecycle(${id})`)

    try {
      const executable = await raceAbort(
        this.ctx.subprocess.resolveExecutable(this.config.command, this.config.env, signal),
        signal,
        id,
      )
      let argv = [executable, ...this.config.args]
      if (isWindowsCommandShim(executable)) {
        const interpreter = await raceAbort(
          this.ctx.subprocess.resolveExecutable(WINDOWS_COMMAND_INTERPRETER, this.config.env, signal),
          signal,
          id,
        )
        if (isWindowsCommandShim(interpreter)) {
          throw new Error('agent-codex: cmd.exe resolved to a command shim instead of a native executable')
        }
        argv = [interpreter, '/d', '/s', '/c', executable, ...this.config.args]
      }
      child = this.ctx.subprocess.spawn({
        argv,
        cwd,
        env: this.config.env,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: this.config.disposeGraceMs,
        signal,
      })
      void child.done.catch(() => {})
      if (child.stdin === undefined || child.stdout === undefined) {
        throw new Error('agent-codex: subprocess provider did not expose app-server stdio')
      }
      wire = new CodexAppServerWire(child.stdout, child.stdin)
      agent = new CodexAgent(this.ctx, id, agentOptions, session, wire)
      const commit = await raceAbort(setup?.(agent.ctx), signal, id)
      commit?.commit()
      signal.throwIfAborted()

      wire.start()
      const appServerVersion = await wire.initialize(signal)
      const link = session.events.findLast(event => event.type === 'codex/thread-linked')
      const adoptBlankSession = source === 'resume'
        && link === undefined
        && !session.events.some(event => event.type === 'turn/start')
      if (source === 'startup' || adoptBlankSession) {
        const assembly = await this.ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
        const developerInstructions = renderPrompt(assembly)
        const threadId = await wire.startThread({
          cwd,
          approvalPolicy: this.config.approvalPolicy,
          sandbox: this.config.sandbox,
          ...agentOptions.model === undefined ? {} : { model: agentOptions.model },
          ...developerInstructions.length === 0 ? {} : { developerInstructions },
        }, signal)
        session.append('codex/thread-linked', { threadId, appServerVersion })
        session.append('request/header', {
          header: canonicalHeader({
            config: {
              provider: agentOptions.provider ?? 'codex',
              model: agentOptions.model ?? 'codex-default',
            },
            ...developerInstructions.length === 0 ? {} : { system: developerInstructions },
          }),
          reason: session.requestHeader() === undefined ? 'initial' : 'change',
        })
      } else {
        if (link === undefined) {
          throw new Error(
            `agent-codex: session "${id}" started without a codex/thread-linked event and cannot be adopted`,
          )
        }
        await wire.resumeThread(link.data.threadId, signal)
      }
      signal.throwIfAborted()

      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
      agent.ctx.sessions.announce(session)
      this.ctx.agents.announce(agent)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', { source })
      signal.throwIfAborted()

      return {
        agent,
        dispose: async () => { await unfollowOwner() },
      }
    } catch (error: unknown) {
      await dispose()
      await unfollowOwner()
      throw error
    }
  }
}

/** Register the Codex bridge as the sole AgentFactory for this composition. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved: ResolvedConfig = {
    command: config.command ?? DEFAULT_COMMAND,
    args: config.args ?? DEFAULT_ARGS,
    env: config.env ?? {},
    ...config.cwd === undefined ? {} : { cwd: config.cwd },
    approvalPolicy: config.approvalPolicy ?? 'never',
    sandbox: config.sandbox ?? 'workspace-write',
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
  if (resolved.command.trim().length === 0) throw new Error('agent-codex: command must be non-empty')
  if (!Number.isFinite(resolved.disposeGraceMs) || resolved.disposeGraceMs <= 0) {
    throw new Error('agent-codex: disposeGraceMs must be positive and finite')
  }
  const factory = new CodexAgentFactory(ctx, resolved)
  ctx.effect(() => () => factory.dispose(), 'agentCodex.agents()')
  ctx.effect(() => ctx.agents.setFactory(factory), 'agentCodex.setFactory()')
  ctx.systemPrompt.variable('provider', context => context.agent?.options.provider)
  ctx.systemPrompt.variable('model', context => context.agent?.options.model)
  ctx.systemPrompt.variable('cwd', context => context.agent?.session.header.cwd)
}
