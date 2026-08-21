/** Public and wire-facing types for the user-managed Codex bridge. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque thread identity issued and persisted by Codex. */
export type CodexThreadId = Branded<'CodexThreadId'>

/**
 * Cast a validated non-empty app-server thread id at the wire boundary.
 * @param value - Non-empty thread id returned by app-server.
 * @returns The branded durable Codex thread identity.
 */
export const CodexThreadId = (value: string): CodexThreadId => value as CodexThreadId

/** Codex sandbox policy fixed when a thread is created. */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** Codex approval policy fixed when a thread is created. */
export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Links one Harness session to the durable Codex thread it resumes. */
    'codex/thread-linked': {
      threadId: CodexThreadId
      appServerVersion: string
    }
  }
}
