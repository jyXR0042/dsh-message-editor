/**
 * Unit tests for the host half's pure surface logic.
 *
 * The interesting parts of this plugin are all in how it reads and rewrites the
 * append-only session log, and every one of them is a pure function over plain
 * event objects 鈥?so they are exercised directly against synthetic logs here,
 * with no Cordis context and no live session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { internals } = await import('../lib/host.js')

const {
  surfaceOpOf, buildSurfaceIndex, applyText, dropAttachments, textOfContent,
  attachmentIds, listEdits, isEditReplacement, appendReplacement,
} = internals

/** A minimal append-origin user message event. */
function userEvent(seq, { text = 'hello', id = `m${seq}`, attachments = [] } = {}) {
  const content = [{ type: 'text', text }]
  for (const attachmentId of attachments) {
    content.push({ type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 1 } })
  }
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    surfaceOp: 'append',
    data: { id, role: 'user', content, source: { kind: 'user' } },
  }
}

/** A minimal append-origin assistant step event, optionally owning a tool call. */
function assistantEvent(seq, { text = 'answer', withToolCall = false, usage = { inputTokens: 5 } } = {}) {
  const content = [{ type: 'text', text }]
  if (withToolCall) content.push({ type: 'tool-call', id: `call${seq}`, name: 'bash', arguments: '{}' })
  return {
    type: 'assistant/message',
    seq,
    time: 2000 + seq,
    surfaceOp: 'append',
    data: { turn: 1, step: seq, message: { id: `a${seq}`, role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } }, usage },
  }
}

/** A single-node replacement event. */
function replacement(seq, type, data, targetSeq, { startSeq, endSeq } = {}) {
  return {
    type,
    seq,
    time: 3000 + seq,
    surfaceOp: { op: 'replace', startSeq: startSeq ?? targetSeq, endSeq: endSeq ?? targetSeq },
    sourceEventSeqs: [targetSeq],
    data,
  }
}

test('surfaceOpOf normalizes both shipped spellings and rejects junk', () => {
  assert.deepEqual(surfaceOpOf({ surfaceOp: 'append' }), { op: 'append' })
  assert.deepEqual(
    surfaceOpOf({ surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }),
    { op: 'replace', startSeq: 3, endSeq: 3 },
  )
  // The pre-rename spelling must still be understood.
  assert.deepEqual(
    surfaceOpOf({ surfaceOp: { op: 'replace', start: 4, end: 9 } }),
    { op: 'replace', startSeq: 4, endSeq: 9 },
  )
  assert.equal(surfaceOpOf({}), undefined)
  assert.equal(surfaceOpOf({ surfaceOp: { op: 'replace' } }), undefined)
  assert.equal(surfaceOpOf({ surfaceOp: 42 }), undefined)
})

test('applyText collapses text blocks into one and preserves every other block in order', () => {
  const original = [
    { type: 'text', text: 'a' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    { type: 'text', text: 'b' },
    { type: 'reasoning', text: 'why' },
  ]
  const next = applyText(original, 'rewritten')
  assert.deepEqual(next, [
    { type: 'text', text: 'rewritten' },
    { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
    { type: 'reasoning', text: 'why' },
  ])
  // The tool call survives byte for byte: dropping it would orphan its result.
  assert.deepEqual(next[1], original[1])
})

test('applyText injects a text block when the content had none', () => {
  const next = applyText([{ type: 'image', attachment: { attachmentId: 'i1' } }], 'new')
  assert.equal(next.length, 2)
  assert.deepEqual(next[0], { type: 'text', text: 'new' })
})

test('dropAttachments removes only the named attachment blocks', () => {
  const content = [
    { type: 'text', text: 'see' },
    { type: 'image', attachment: { attachmentId: 'i1' } },
    { type: 'image', attachment: { attachmentId: 'i2' } },
    { type: 'file', attachment: { attachmentId: 'f1', name: 'a.txt' } },
  ]
  const kept = dropAttachments(content, new Set(['i1']))
  assert.deepEqual(kept.map((block) => block.attachment?.attachmentId ?? block.text), ['see', 'i2', 'f1'])
  assert.deepEqual(attachmentIds(content), ['i1', 'i2', 'f1'])
})

test('buildSurfaceIndex chains origins across successive edits', () => {
  const first = replacement(10, 'user/message', userEvent(0).data, 0)
  const second = replacement(20, 'user/message', userEvent(0).data, 10)
  const events = [userEvent(0), assistantEvent(1), first, second]
  const { current, originOf, bySeq } = buildSurfaceIndex(events)
  // The browser keys an edit by the append-origin seq; the host must resolve it
  // to whatever node currently stands in for it.
  assert.equal(current.get(0), 20)
  assert.equal(originOf.get(20), 0)
  assert.equal(originOf.get(10), 0)
  assert.equal(bySeq.get(1).type, 'assistant/message')
})

test('buildSurfaceIndex drops every origin shadowed by a wider range replacement', () => {
  const compaction = replacement(30, 'user/message', userEvent(0).data, 0, { startSeq: 0, endSeq: 1 })
  const { current } = buildSurfaceIndex([userEvent(0), assistantEvent(1), compaction])
  assert.equal(current.get(0), undefined)
  assert.equal(current.get(1), undefined)
})

test('listEdits reports one record per edited origin and ignores compaction checkpoints', () => {
  const edited = replacement(10, 'user/message', {
    ...userEvent(0).data,
    content: [{ type: 'text', text: 'edited text' }],
  }, 0)
  const checkpoint = replacement(11, 'user/message', {
    id: 'checkpoint',
    role: 'user',
    content: [{ type: 'text', text: 'summary' }],
    source: { kind: 'plugin', plugin: 'compact' },
  }, 0)
  assert.equal(isEditReplacement(edited), true)
  assert.equal(isEditReplacement(checkpoint), false)

  const records = listEdits([userEvent(0), edits_placeholder(), edited], new Map())
  assert.equal(records.length, 1)
  assert.equal(records[0].originSeq, 0)
  assert.equal(records[0].kind, 'user')
  assert.equal(records[0].text, 'edited text')
  assert.deepEqual(records[0].removed, [])
})

test('listEdits reports removed attachments by diffing against the original', () => {
  const original = userEvent(0, { text: 'with files', attachments: ['i1', 'i2'] })
  const edited = replacement(10, 'user/message', {
    ...original.data,
    content: [
      { type: 'text', text: 'keep one' },
      { type: 'image', attachment: { attachmentId: 'i2', mediaType: 'image/png', bytes: 1 } },
    ],
  }, 0)
  const records = listEdits([original, edited], new Map())
  assert.deepEqual(records[0].removed, ['i1'])
  assert.equal(records[0].text, 'keep one')
})

test('listEdits surfaces staged edits that are not in the log yet', () => {
  const staged = new Map([
    ['s1\u00000', { originSeq: 0, text: 'pending', removed: [], editedAt: 5 }],
  ])
  const records = listEdits([userEvent(0)], staged)
  assert.equal(records.length, 1)
  assert.equal(records[0].deferred, true)
  assert.equal(records[0].text, 'pending')
})

test('appendReplacement falls back across the shipped surface-op spellings', () => {
  const attempts = []
  const session = {
    append(type, data, intent) {
      attempts.push(intent)
      // Accept only the modern no-sourceEventSeqs spelling, like a host that
      // refuses provenance on assistant replacements.
      if (intent.sourceEventSeqs !== undefined) throw new Error('sourceEventSeqs must be absent')
      return { type, seq: 99, time: 1, data }
    },
  }
  const event = appendReplacement(session, 4, 'assistant/message', { turn: 1, step: 1 })
  assert.equal(event.seq, 99)
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0].surfaceOp, { op: 'replace', startSeq: 4, endSeq: 4 })
  assert.equal(attempts[1].sourceEventSeqs, undefined)
})

test('appendReplacement reports the host error when every spelling fails', () => {
  const session = { append() { throw new Error('surface replace: start seq 4 not found in surface') } }
  assert.throws(() => appendReplacement(session, 4, 'user/message', {}), /start seq 4 not found/)
})

test('textOfContent joins only text blocks', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOfContent(undefined), '')
})

/** A neutral filler event so seq numbering in the listing test stays honest. */
function edits_placeholder() {
  return { type: 'step/end', seq: 0.5, time: 1, data: { turn: 1, step: 1 } }
}
