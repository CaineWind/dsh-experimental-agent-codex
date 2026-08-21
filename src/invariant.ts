/** Package-owned relational checks for Codex thread links. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-agent-codex'

/** Cordis companion plugin name. */
export const name = 'agent-codex-invariant'
/** Invariant registry required by the companion. */
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'codex/thread-linked') return
    if (session.events.some(candidate => candidate.type === 'codex/thread-linked')) {
      fail(`session "${session.id}" contains more than one Codex thread link`)
    }
    if (event.data.threadId.trim().length === 0 || event.data.appServerVersion.trim().length === 0) {
      fail(`session "${session.id}" contains an empty Codex thread link field`)
    }
    if (session.events.some(candidate => candidate.type === 'turn/start')) {
      fail(`session "${session.id}" linked its Codex thread after turns had started`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
