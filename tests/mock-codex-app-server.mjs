import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize':
      result(message.id, { serverInfo: { version: 'mock-1.0.0' } })
      break
    case 'thread/start':
      result(message.id, { thread: { id: 'mock-thread-1' } })
      break
    case 'thread/resume':
      result(message.id, { thread: { id: message.params.threadId } })
      break
    case 'turn/start':
      result(message.id, { turn: { id: 'mock-turn-1' } })
      setImmediate(() => {
        notify('turn/started', { threadId: 'mock-thread-1', turn: { id: 'mock-turn-1' } })
        notify('item/started', {
          threadId: 'mock-thread-1',
          turnId: 'mock-turn-1',
          item: { id: 'mock-item-1', type: 'agentMessage', phase: 'final_answer' },
        })
        notify('item/agentMessage/delta', {
          threadId: 'mock-thread-1', turnId: 'mock-turn-1', itemId: 'mock-item-1', delta: 'mock Codex response',
        })
        notify('thread/tokenUsage/updated', {
          threadId: 'mock-thread-1',
          turnId: 'mock-turn-1',
          tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 } },
        })
        notify('item/completed', {
          threadId: 'mock-thread-1',
          turnId: 'mock-turn-1',
          item: { id: 'mock-item-1', type: 'agentMessage', phase: 'final_answer', text: 'mock Codex response' },
        })
        notify('turn/completed', {
          threadId: 'mock-thread-1', turn: { id: 'mock-turn-1', status: 'completed' },
        })
      })
      break
    case 'turn/steer':
    case 'turn/interrupt':
      result(message.id, {})
      break
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } })
  }
})
