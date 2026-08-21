import { n as CodexSandboxMode, r as CodexThreadId, t as CodexApprovalPolicy } from "./types-DaVVofvL.js";
import z from "@deepseek-ai/schemastery";
import { Agent, AgentCancelCause, AgentOptions, AgentStatus, CancelOptions, Inbox, InboxTarget } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, UserMessage } from "@deepseek-ai/dsh-session";
import { TokenUsage } from "@deepseek-ai/dsh-llm";
import { Scope } from "@deepseek-ai/dsh-scope";
import { Context } from "@deepseek-ai/cordis";
import { Readable, Writable } from "node:stream";
//#region src/wire.d.ts
/** Stream callbacks for one Codex turn. */
interface CodexTurnObserver {
  /** Observe final-answer text bytes in order. */
  delta(text: string): void;
  /** Observe the latest per-turn token accounting. */
  usage(usage: TokenUsage): void;
}
/** Terminal facts returned by one Codex turn. */
interface CodexTurnResult {
  readonly status: 'completed' | 'interrupted';
  readonly text: string;
  readonly usage?: TokenUsage;
}
/** Thread creation inputs supported by the public app-server protocol. */
interface StartThreadOptions {
  readonly cwd: string;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandbox: CodexSandboxMode;
  readonly model?: string;
  readonly developerInstructions?: string;
}
/** One initialized app-server connection with one active thread and at most one active turn. */
declare class CodexAppServerWire {
  private readonly transport;
  private readonly fatal;
  private threadId;
  private turnId;
  private active;
  private closed;
  constructor(input: Readable, output: Writable);
  /** Begin reading app-server frames. */
  start(): void;
  /**
   * Perform the required initialize/initialized handshake.
   * @param signal - Cancels the handshake and pending protocol request.
   * @returns The app-server version, or `unknown` when the server omits it.
   */
  initialize(signal: AbortSignal): Promise<string>;
  /**
   * Create and retain a durable Codex thread.
   * @param options - Thread workspace, policy, model, and developer instructions.
   * @param signal - Cancels the thread creation request.
   * @returns The durable thread identity returned by app-server.
   */
  startThread(options: StartThreadOptions, signal: AbortSignal): Promise<CodexThreadId>;
  /**
   * Resume one user-managed Codex thread and verify its identity.
   * @param threadId - Durable Codex thread identity recorded by Harness.
   * @param signal - Cancels the resume request.
   */
  resumeThread(threadId: CodexThreadId, signal: AbortSignal): Promise<void>;
  /**
   * Start one text turn and await its authoritative terminal notification.
   * @param texts - Ordered non-empty user text blocks for the turn.
   * @param observer - Receives final-answer deltas and latest token usage.
   * @param signal - Cancels the active turn wait.
   * @returns Terminal turn status, assembled text, and optional usage.
   */
  runTurn(texts: readonly string[], observer: CodexTurnObserver, signal: AbortSignal): Promise<CodexTurnResult>;
  /**
   * Add user text to the active Codex turn.
   * @param texts - Ordered non-empty user text blocks to steer with.
   * @param signal - Cancels the steering request.
   */
  steer(texts: readonly string[], signal: AbortSignal): Promise<void>;
  /** Best-effort interruption of the active remote turn. */
  interrupt(): void;
  /** Close framing and reject outstanding protocol requests. */
  close(): void;
  private requireThread;
  private guarded;
  private fail;
  private validateIds;
  private handleRequest;
  private handleNotification;
}
//#endregion
//#region src/agent.d.ts
/** One live Harness Agent backed by one Codex thread and app-server process. */
declare class CodexAgent implements Agent {
  private readonly runtimeCtx;
  readonly id: SessionId;
  readonly options: AgentOptions;
  readonly session: Session;
  private readonly wire;
  readonly inbox: Inbox;
  /** Per-Agent registration scope disposed with the Agent handle. */
  readonly scope: Scope;
  readonly ctx: Context;
  private readonly dispatch;
  private phase;
  private activityDone;
  private steering;
  constructor(runtimeCtx: Context, id: SessionId, options: AgentOptions, session: Session, wire: CodexAppServerWire);
  get status(): AgentStatus;
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
  followup(message: UserMessage): void;
  steer(message: UserMessage): void;
  inject(message: UserMessage): void;
  cancel(cause: AgentCancelCause, options?: CancelOptions): void;
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  whenIdle(): Promise<void>;
  private setPhase;
  private wake;
  private drive;
  private flushSteering;
  private runTurn;
}
//#endregion
//#region src/index.d.ts
/** Cordis plugin name. */
declare const name = "agent-codex";
/** Services required by the bridge. Deliberately excludes LLM and Harness tool services. */
declare const inject: string[];
/** User-owned process selection and Codex thread policy. */
interface Config {
  /** User-managed Codex executable path or PATH name. */
  command?: string;
  /** Arguments that start app-server over stdio. */
  args?: string[];
  /** Explicit child environment layered after Harness credential scrubbing. */
  env?: Record<string, string>;
  /** Fallback workspace when a Session has no `cwd`. */
  cwd?: string;
  /** Codex approval policy for newly created threads. */
  approvalPolicy?: CodexApprovalPolicy;
  /** Codex sandbox policy for newly created threads. */
  sandbox?: CodexSandboxMode;
  /** Process-tree termination grace in milliseconds. */
  disposeGraceMs?: number;
}
/** Runtime schema for the Codex AgentFactory bridge. */
declare const Config: z<Config>;
/** Register the Codex bridge as the sole AgentFactory for this composition. */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { CodexAgent, CodexAppServerWire, type CodexApprovalPolicy, type CodexSandboxMode, CodexThreadId, Config, apply, inject, name };