import { PassThrough } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexAppServerWire } from '../src/wire.ts'

interface Pair {
  readonly wire: CodexAppServerWire
  readonly server: JsonRpcLineTransport
  close(): void
}

const pairs: Pair[] = []

function pair(handler: (method: string, params: Record<string, unknown>, server: JsonRpcLineTransport) => Promise<unknown>): Pair {
  const clientInput = new PassThrough()
  const serverInput = new PassThrough()
  const wire = new CodexAppServerWire(clientInput, serverInput)
  const server = new JsonRpcLineTransport(serverInput, clientInput)
  server.onRequest((method, params) => handler(method, params, server))
  server.start()
  wire.start()
  const value = {
    wire,
    server,
    close(): void {
      wire.close()
      server.close()
      clientInput.destroy()
      serverInput.destroy()
    },
  }
  pairs.push(value)
  return value
}

afterEach(() => {
  for (const value of pairs.splice(0)) value.close()
})

describe('CodexAppServerWire', () => {
  it('initializes, creates a durable thread, and projects streamed output and disjoint usage', async () => {
    const observed: string[] = []
    const { wire } = pair(async (method, params, server) => {
      switch (method) {
        case 'initialize':
          return { serverInfo: { version: '1.2.3' } }
        case 'thread/start':
          expect(params).toMatchObject({ cwd: 'C:/repo', ephemeral: false, approvalPolicy: 'never' })
          return { thread: { id: 'thread-1' } }
        case 'turn/start':
          server.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } })
          server.notify('item/started', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { id: 'item-1', type: 'agentMessage', phase: 'final_answer' },
          })
          server.notify('item/agentMessage/delta', {
            threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'hello',
          })
          server.notify('thread/tokenUsage/updated', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            tokenUsage: {
              last: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 12, reasoningOutputTokens: 3 },
            },
          })
          server.notify('item/completed', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { id: 'item-1', type: 'agentMessage', phase: 'final_answer', text: 'hello' },
          })
          server.notify('turn/completed', {
            threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
          })
          return { turn: { id: 'turn-1' } }
        default:
          throw new Error(`unexpected ${method}`)
      }
    })

    const signal = new AbortController().signal
    await expect(wire.initialize(signal)).resolves.toBe('1.2.3')
    const threadId = await wire.startThread({
      cwd: 'C:/repo', approvalPolicy: 'never', sandbox: 'workspace-write',
    }, signal)
    expect(threadId).toBe('thread-1')
    await expect(wire.runTurn(['task'], {
      delta: text => { observed.push(text) },
      usage: () => {},
    }, signal)).resolves.toEqual({
      status: 'completed',
      text: 'hello',
      usage: { inputTokens: 75, outputTokens: 12, cacheReadTokens: 25, reasoningTokens: 3 },
    })
    expect(observed).toEqual(['hello'])
  })

  it('resumes the exact thread and declines an incoming approval request', async () => {
    let approval: unknown
    const { wire } = pair(async (method, _params, server) => {
      switch (method) {
        case 'initialize': return {}
        case 'thread/resume': return { thread: { id: 'thread-existing' } }
        case 'turn/start':
          server.notify('turn/started', { threadId: 'thread-existing', turn: { id: 'turn-2' } })
          approval = await server.request('item/commandExecution/requestApproval', {
            threadId: 'thread-existing',
            turnId: 'turn-2',
            availableDecisions: ['accept', 'decline'],
          })
          server.notify('turn/completed', {
            threadId: 'thread-existing', turn: { id: 'turn-2', status: 'completed' },
          })
          return { turn: { id: 'turn-2' } }
        default: throw new Error(`unexpected ${method}`)
      }
    })

    const signal = new AbortController().signal
    await wire.initialize(signal)
    await wire.resumeThread('thread-existing' as never, signal)
    await wire.runTurn(['task'], { delta: () => {}, usage: () => {} }, signal)
    expect(approval).toEqual({ decision: 'decline' })
  })

  it('rejects a turn wait when its local signal is aborted', async () => {
    const { wire } = pair(async (method) => {
      if (method === 'initialize') return {}
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') return { turn: { id: 'turn-never-completes' } }
      throw new Error(`unexpected ${method}`)
    })
    const startup = new AbortController().signal
    await wire.initialize(startup)
    await wire.startThread({ cwd: 'C:/repo', approvalPolicy: 'never', sandbox: 'read-only' }, startup)
    const turn = new AbortController()
    const pending = wire.runTurn(['task'], { delta: () => {}, usage: () => {} }, turn.signal)
    turn.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
  })
})
