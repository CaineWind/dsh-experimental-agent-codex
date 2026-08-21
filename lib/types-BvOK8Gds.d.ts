import { Branded } from "@deepseek-ai/dsh-brand";
//#region src/types.d.ts
/** Opaque thread identity issued and persisted by Codex. */
type CodexThreadId = Branded<'CodexThreadId'>;
/** Cast a validated non-empty app-server thread id at the wire boundary. */
declare const CodexThreadId: (value: string) => CodexThreadId;
/** Codex sandbox policy fixed when a thread is created. */
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
/** Codex approval policy fixed when a thread is created. */
type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Links one Harness session to the durable Codex thread it resumes. */
    'codex/thread-linked': {
      threadId: CodexThreadId;
      appServerVersion: string;
    };
  }
}
//#endregion
export { CodexSandboxMode as n, CodexThreadId as r, CodexApprovalPolicy as t };