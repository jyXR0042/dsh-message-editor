/**
 * End-to-end host-half test against a faithful in-memory stand-in for the
 * session store.
 *
 * The plugin's only host surface is the `apply(ctx)` body plus the RPC handler
 * it registers, so this harness supplies exactly the services it injects 鈥? * `sessions`, `connection` 鈥?and a `Session` double that enforces the real
 * append contract: a surface-eligible event must carry a marker, a replacement
 * must name a range that is currently on the surface, and it must cite the node
 * it shadows.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const plugin = await import('../lib/host.js')

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/** A session double that folds its own surface exactly like the host does. */
class FakeSession {
  constructor(id = 'session-1') {
    this.id = id
    this.header = { id, version: 1, createdAt: 0, isSeeded: false }
    this.log = []
    this.nodes = []
    this.assistantWritesAllowed = true
  }

  get events() { return this.log }
  snapshotEvents() { return this.log }
  eventAt(seq) { return this.log[seq] }
  get surface() { return { nodes: [...this.nodes], replaceGeneration: 0 } }

  append(type, data, intent) {
    const seq = this.log.length
    const isSurface = SURFACE_TYPES.has(type)
    if (isSurface && intent?.surfaceOp === undefined) {
      throw new Error(`session event "${type}" is surface-eligible and requires a surfaceOp marker`)
    }
    if (isSurface && type === 'assistant/message' && !this.assistantWritesAllowed) {
      // Mirrors the opt-in relational invariant: an assistant replacement is
      // step-scoped, so an idle session refuses it.
      throw new Error(`assistant/message names turn ${data.turn}/step ${data.step} but open is turn null/step null`)
    }
    if (isSurface && intent.surfaceOp !== 'append') {
      const start = intent.surfaceOp.startSeq ?? intent.surfaceOp.start
      const end = intent.surfaceOp.endSeq ?? intent.surfaceOp.end
      const startIdx = this.nodes.indexOf(start)
      const endIdx = this.nodes.indexOf(end)
      if (startIdx === -1) throw new Error(`surface replace: start seq ${start} not found in surface`)
      if (endIdx === -1) throw new Error(`surface replace: end seq ${end} not found in surface`)
      const shadowed = this.nodes.slice(startIdx, endIdx + 1)
      const cited = intent.sourceEventSeqs ?? []
      for (const seq2 of shadowed) {
        if (!cited.includes(seq2)) {
          throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${seq2}`)
        }
      }
      this.nodes.splice(startIdx, endIdx - startIdx + 1, seq)
    } else if (isSurface) {
      this.nodes.push(seq)
    }
    const event = {
      type,
      seq,
      time: 1000 + seq,
      data,
      ...(isSurface ? { surfaceOp: intent.surfaceOp } : {}),
      ...(intent?.sourceEventSeqs !== undefined ? { sourceEventSeqs: [...intent.sourceEventSeqs] } : {}),
    }
    this.log.push(event)
    return event
  }
}

/** A ctx double exposing only what the plugin injects. */
function makeCtx(session) {
  const listeners = new Map()
  const flushed = []
  const followups = []
  let route
  const ctx = {
    sessions: {
      get: (id) => (session !== undefined && session.id === id ? session : undefined),
      flush: async (target) => { flushed.push(target.id); return true },
    },
    agents: {
      get: (id) => (session !== undefined && session.id === id
        ? { session, followup: (message) => { followups.push(message) } }
        : undefined),
    },
    connection: {
      // The exact Fetch-route registry — the working sibling of this build's
      // `rpc.handle`, which reads `webServer` off the wrong context.
      fetch: {
        register: (registered) => { route = registered; return () => {} },
      },
    },
    effect: (execute) => execute(),
    on: (name, listener) => {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
    logger: { warn: () => {} },
  }
  return {
    ctx,
    flushed,
    followups,
    routeOf: () => route,
    call: async (endpoint, payload) => {
      assert.ok(route !== undefined, 'the plugin registered no fetch route')
      const request = new Request('http://127.0.0.1:3080/api/dsh-message-editor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      })
      const response = await route.fetch(request)
      assert.equal(response.status, 200)
      return await response.json()
    },
    emit: (name, payload, next) => {
      const listener = listeners.get(name)
      assert.ok(listener !== undefined, `no listener registered for ${name}`)
      return listener(payload, next)
    },
    hasHandler: () => route !== undefined,
  }
}

/** Seed a session with one user turn and one assistant reply. */
function seed() {
  const session = new FakeSession()
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [{ type: 'text', text: 'original question' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'original answer' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}' },
      ],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 11, outputTokens: 22 },
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  session.append('step/end', { turn: 1, step: 1 })
  return session
}

test('apply mounts one exact, authenticated /api route', () => {
  const harness = makeCtx(seed())
  plugin.apply(harness.ctx)
  assert.equal(harness.hasHandler(), true)
  const route = harness.routeOf()
  // The route must live under /api: that is what puts it behind the shared
  // Host/Origin fence and browser authentication.
  assert.equal(route.path, '/api/dsh-message-editor')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
})

test('list reports no edits on a pristine log', async () => {
  const harness = makeCtx(seed())
  plugin.apply(harness.ctx)
  const result = await harness.call('list', { sessionId: 'session-1' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value.edits, [])
})

test('apply rewrites a user message in place and leaves the original in the log', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  const applied = await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: 'edited question' })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.value.deferred, false)
  assert.equal(applied.value.record.text, 'edited question')
  assert.equal(applied.value.record.kind, 'user')

  // The original event is untouched and still addressable.
  assert.equal(session.log[2].data.content[0].text, 'original question')
  // The replacement now stands in for it.
  const replacement = session.log.at(-1)
  assert.equal(replacement.type, 'user/message')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
  assert.deepEqual(replacement.sourceEventSeqs, [2])
  assert.equal(replacement.data.id, 'u1')
  assert.deepEqual(replacement.data.source, { kind: 'user' })
  assert.equal(replacement.data.content[0].text, 'edited question')
  // Durability was requested.
  assert.deepEqual(harness.flushed, ['session-1'])
})

test('apply preserves an assistant message tool calls and drops its usage', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  const applied = await harness.call('apply', { sessionId: 'session-1', originSeq: 3, text: 'edited answer' })
  assert.equal(applied.ok, true, JSON.stringify(applied))

  const replacement = session.log.at(-1)
  assert.equal(replacement.type, 'assistant/message')
  assert.equal(replacement.data.message.content[0].text, 'edited answer')
  // The tool call survives byte for byte, or its tool/result becomes an orphan.
  assert.deepEqual(replacement.data.message.content[1], {
    type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{}',
  })
  assert.equal(replacement.data.message.id, 'a1')
  assert.deepEqual(replacement.data.message.source, { kind: 'model', provider: 'p', model: 'm' })
  // Re-stating a past step's usage would bill it twice.
  assert.equal('usage' in replacement.data, false)
})

test('a second edit chains onto the first replacement', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: 'first edit' })
  const second = await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: 'second edit' })
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.value.record.text, 'second edit')

  const last = session.log.at(-1)
  const previous = session.log.at(-2)
  // The second edit shadows the first replacement, not the original.
  assert.deepEqual(last.surfaceOp, { op: 'replace', startSeq: previous.seq, endSeq: previous.seq })
  // And `list` still reports it under the append-origin seq the UI keys on.
  const listed = await harness.call('list', { sessionId: 'session-1' })
  assert.equal(listed.value.edits.length, 1)
  assert.equal(listed.value.edits[0].originSeq, 2)
  assert.equal(listed.value.edits[0].text, 'second edit')
})

test('revert restores the original content from the log', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: 'edited question' })
  const reverted = await harness.call('revert', { sessionId: 'session-1', originSeq: 2 })
  assert.equal(reverted.ok, true, JSON.stringify(reverted))

  const last = session.log.at(-1)
  assert.equal(last.data.content[0].text, 'original question')
  const listed = await harness.call('list', { sessionId: 'session-1' })
  assert.deepEqual(listed.value.edits, [])
})

test('removing an attachment drops only that block', async () => {
  const session = new FakeSession()
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', attachment: { attachmentId: 'i1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
      { type: 'image', attachment: { attachmentId: 'i2', mediaType: 'image/png', bytes: 10, width: 1, height: 1 } },
    ],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  const applied = await harness.call('apply', {
    sessionId: 'session-1', originSeq: 2, text: 'look', removed: ['i1'],
  })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.deepEqual(applied.value.record.removed, ['i1'])
  const content = session.log.at(-1).data.content
  assert.deepEqual(content.map((block) => block.attachment?.attachmentId ?? block.text), ['look', 'i2'])
})

test('an idle assistant edit is staged and flushed from agent/request', async () => {
  const session = seed()
  session.assistantWritesAllowed = false
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  const applied = await harness.call('apply', { sessionId: 'session-1', originSeq: 3, text: 'staged answer' })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.value.deferred, true)
  assert.equal(applied.value.record.text, 'staged answer')

  // Reported as a pending edit while it waits for a model step.
  const before = await harness.call('list', { sessionId: 'session-1' })
  assert.equal(before.value.edits.length, 1)
  assert.equal(before.value.edits[0].deferred, true)

  // The next step opens: the flush lands it with the open step's coordinates.
  session.assistantWritesAllowed = true
  await harness.emit('agent/request', { agent: { session }, turn: 2, step: 1 }, () => Promise.resolve(undefined))

  const last = session.log.at(-1)
  assert.equal(last.type, 'assistant/message')
  assert.equal(last.data.turn, 2)
  assert.equal(last.data.step, 1)
  assert.equal(last.data.message.content[0].text, 'staged answer')

  const after = await harness.call('list', { sessionId: 'session-1' })
  assert.equal(after.value.edits.length, 1)
  assert.equal(after.value.edits[0].deferred, false)
  assert.equal(after.value.edits[0].text, 'staged answer')
})

test('a compaction bracket blocks an edit instead of corrupting it', async () => {
  const session = seed()
  session.append('compaction/start', { compactionId: 'c1' })
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  const applied = await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: 'nope' })
  assert.equal(applied.ok, false)
  assert.equal(applied.error.code, 'compaction-busy')
})

test('a cold session is refused with an actionable code', async () => {
  const harness = makeCtx(undefined)
  plugin.apply(harness.ctx)
  const applied = await harness.call('apply', { sessionId: 'session-9', originSeq: 0, text: 'x' })
  assert.equal(applied.ok, false)
  assert.equal(applied.error.code, 'session-cold')
})

test('malformed input is rejected before touching the log', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)
  const length = session.log.length

  assert.equal((await harness.call('apply', { sessionId: 'session-1', text: 'x' })).error.code, 'bad-request')
  assert.equal((await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: '' })).error.code, 'bad-request')
  assert.equal((await harness.call('apply', { sessionId: 'session-1', originSeq: -1, text: 'x' })).error.code, 'bad-request')
  assert.equal((await harness.call('nope', {})).error.code, 'unknown-endpoint')
  assert.equal(session.log.length, length)
})

test('a target that left the surface is reported, not silently rewritten', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)
  const applied = await harness.call('apply', { sessionId: 'session-1', originSeq: 999, text: 'x' })
  assert.equal(applied.ok, false)
  assert.equal(applied.error.code, 'target-not-found')
})

// The assistant action strip is handed a durable `messageId` and nothing else,
// so the id → surface-coordinate resolution has to work on the host.

test('read resolves a message id to its append-origin seq and current text', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  const user = await harness.call('read', { sessionId: 'session-1', messageId: 'u1' })
  assert.equal(user.ok, true, JSON.stringify(user))
  assert.equal(user.value.originSeq, 2)
  assert.equal(user.value.kind, 'user')
  assert.equal(user.value.text, 'original question')

  const assistant = await harness.call('read', { sessionId: 'session-1', messageId: 'a1' })
  assert.equal(assistant.ok, true, JSON.stringify(assistant))
  assert.equal(assistant.value.originSeq, 3)
  assert.equal(assistant.value.kind, 'assistant')
  assert.equal(assistant.value.text, 'original answer')
})

test('read reports the edited text once the message has been rewritten', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)
  await harness.call('apply', { sessionId: 'session-1', originSeq: 3, text: 'corrected answer' })

  const after = await harness.call('read', { sessionId: 'session-1', messageId: 'a1' })
  assert.equal(after.ok, true, JSON.stringify(after))
  // The origin seq is stable across the rewrite, so the same id keeps resolving.
  assert.equal(after.value.originSeq, 3)
  assert.equal(after.value.text, 'corrected answer')
})

test('read lists an attachment chip for every removable block', async () => {
  const session = new FakeSession()
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'u1',
    role: 'user',
    content: [
      { type: 'text', text: 'see' },
      { type: 'image', attachment: { attachmentId: 'i1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'a.png' } },
    ],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  const read = await harness.call('read', { sessionId: 'session-1', messageId: 'u1' })
  assert.deepEqual(read.value.attachments, [{ id: 'i1', name: 'a.png' }])
})

test('every edit record carries the message id it belongs to', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)
  await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: 'edited question' })

  const listed = await harness.call('list', { sessionId: 'session-1' })
  assert.equal(listed.value.edits.length, 1)
  assert.equal(listed.value.edits[0].messageId, 'u1')
  assert.equal(listed.value.edits[0].originSeq, 2)
})

test('read refuses an unknown message id', async () => {
  const harness = makeCtx(seed())
  plugin.apply(harness.ctx)
  const read = await harness.call('read', { sessionId: 'session-1', messageId: 'nope' })
  assert.equal(read.ok, false)
  assert.equal(read.error.code, 'target-not-found')
  assert.equal((await harness.call('read', { sessionId: 'session-1' })).error.code, 'bad-request')
})

// ---- regenerate -----------------------------------------------------------

test('a regenerate edit spans the stale reply and wakes the session', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)

  const applied = await harness.call('apply', {
    sessionId: 'session-1',
    originSeq: 2,
    text: 'edited question',
    regenerate: true,
    instruction: 'answer again please',
  })
  assert.equal(applied.ok, true, JSON.stringify(applied))

  // One replacement covers the question AND the answer that followed it, so the
  // model is not asked to redo an answer it can still see. The trigger itself
  // only enters the inbox, so the replacement is the log's last event.
  const replacement = session.log.at(-1)
  assert.equal(replacement.type, 'user/message')
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 })
  assert.deepEqual([...replacement.sourceEventSeqs].sort((a, b) => a - b), [2, 3])
  assert.equal(replacement.data.content[0].text, 'edited question')

  // The record tells the transcript which replies to drop.
  assert.deepEqual(applied.value.record.hiddenSeqs, [3])
  assert.deepEqual(applied.value.hidden, [3])

  // And the session was woken with a produced trigger, which the client's
  // `context` renderer hides.
  assert.equal(harness.followups.length, 1)
  const trigger = harness.followups[0]
  assert.equal(trigger.role, 'user')
  // Session format v4 rejects a bare `plugin` kind ("requires a producer-owned
  // source kind"), and the log would refuse the message, failing the turn that
  // claims it.
  assert.notEqual(trigger.source.kind, 'plugin')
  assert.equal(trigger.source.kind, 'plugin:dsh-message-editor')
  assert.equal(trigger.content[0].text, 'answer again please')
})

test('a regenerate without a live agent is refused, not half-applied', async () => {
  const harness = makeCtx(undefined)
  plugin.apply(harness.ctx)
  const applied = await harness.call('apply', {
    sessionId: 'session-1', originSeq: 2, text: 'x', regenerate: true,
  })
  assert.equal(applied.ok, false)
  assert.equal(applied.error.code, 'session-cold')
})

test('a plain edit never wakes the session and hides nothing', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)
  const applied = await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: 'only an edit' })
  assert.equal(applied.ok, true)
  assert.deepEqual(applied.value.hidden, [])
  assert.equal(applied.value.record.hiddenSeqs, undefined)
  assert.equal(harness.followups.length, 0)
  const listed = await harness.call('list', { sessionId: 'session-1' })
  assert.equal(listed.value.edits[0].hiddenSeqs, undefined)
})

test('list reports the hidden replies of a regenerate after a reload', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)
  await harness.call('apply', { sessionId: 'session-1', originSeq: 2, text: 'edited', regenerate: true })

  const listed = await harness.call('list', { sessionId: 'session-1' })
  assert.equal(listed.value.edits.length, 1)
  assert.equal(listed.value.edits[0].originSeq, 2)
  assert.equal(listed.value.edits[0].text, 'edited')
  assert.deepEqual(listed.value.edits[0].hiddenSeqs, [3])
})

test('regenerate is ignored for an assistant message', async () => {
  const session = seed()
  const harness = makeCtx(session)
  plugin.apply(harness.ctx)
  const applied = await harness.call('apply', {
    sessionId: 'session-1', originSeq: 3, text: 'edited answer', regenerate: true,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  // An assistant message has no reply run to replace, so the edit stays single-node.
  assert.deepEqual(session.log.at(-1).surfaceOp, { op: 'replace', startSeq: 3, endSeq: 3 })
  assert.equal(harness.followups.length, 0)
})
