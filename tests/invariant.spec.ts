import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import * as CodexInvariant from '../src/invariant.ts'
import { CodexThreadId } from '../src/types.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(CodexInvariant)
  return ctx
}

describe('Codex Agent stream invariant', () => {
  it('accepts one early thread link and rejects a duplicate', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('codex-invariant'))
    session.append('codex/thread-linked', {
      threadId: CodexThreadId('thread-1'),
      appServerVersion: '1.2.3',
    })

    expect(() => {
      session.append('codex/thread-linked', {
        threadId: CodexThreadId('thread-2'),
        appServerVersion: '1.2.3',
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-experimental-agent-codex',
    }))
    expect(session.events).toHaveLength(1)
  })

  it('rejects a thread link appended after a turn starts', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('codex-late-link'))
    session.append('turn/start', { turn: 1 })
    expect(() => {
      session.append('codex/thread-linked', {
        threadId: CodexThreadId('thread-1'),
        appServerVersion: '1.2.3',
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({ code: 'INVARIANT' }))
  })
})
