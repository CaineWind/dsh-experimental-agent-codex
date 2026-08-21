import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it } from 'vitest'
import * as AgentCodex from '../src/index.ts'

const mockServer = fileURLToPath(new URL('./mock-codex-app-server.mjs', import.meta.url))
const loader = Object.create(Loader.prototype) as Loader
const plugin = loader.unwrapExports(AgentCodex) as typeof AgentCodex

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: 'You are the test deployment.' })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(plugin, {
    command: process.execPath,
    args: [mockServer],
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
  })
  return ctx
}

describe('Codex Agent composition', () => {
  it('keeps the function-plugin namespace intact through Loader normalization', () => {
    expect('default' in AgentCodex).toBe(false)
    expect(plugin).toBe(AgentCodex)
    expect(plugin.inject).toEqual(['agents', 'sessions', 'subprocess', 'systemPrompt'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('creates through AgentRegistry and emits the standard text-turn projection', async () => {
    const ctx = await harness()
    const id = SessionId('codex-composition')
    const handle = await ctx.agents.create({
      sessionId: id,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: 'codex', model: 'mock-model' },
    })

    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'run the task' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    const eventTypes = handle.agent.session.events.map(event => event.type)
    expect(eventTypes).toEqual([
      'codex/thread-linked',
      'request/header',
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'step/start',
      'user/message',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const answer = handle.agent.session.events.find(event => event.type === 'assistant/message')
    expect(answer?.data.message.content).toEqual([{ type: 'text', text: 'mock Codex response' }])
    expect(answer?.data.usage).toEqual({ inputTokens: 6, outputTokens: 3, cacheReadTokens: 4 })

    await handle.dispose()
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('fails at first Agent creation when the user-managed executable is missing', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(plugin, { command: 'codex-command-that-does-not-exist' })

    await expect(ctx.agents.create({
      sessionId: SessionId('missing-codex'),
      meta: { cwd: process.cwd() },
    })).rejects.toThrow()
    expect(ctx.agents.get(SessionId('missing-codex'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('missing-codex'))).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
