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
  surfaceOpOf, buildSurfaceIndex, applyText, alignReplay, dropAttachments, textOfContent,
  attachmentIds, listEdits, isEditReplacement, appendReplacement, replacementData,
  regenerateRange, regenerateTrigger, assertAdmissibleTrigger,
} = internals

/** One assistant step carrying provider replay metadata, as the adapter writes it. */
function replayAssistantEvent(seq, content, blocks) {
  return {
    type: 'assistant/message',
    seq,
    time: 1,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `a${seq}`,
        role: 'assistant',
        content,
        source: {
          kind: 'model',
          provider: 'deepseek-account',
          model: 'deepseek-flash',
          replayState: { response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-flash' }, blocks },
        },
      },
      usage: { inputTokens: 7, outputTokens: 9 },
    },
  }
}

/** The adapter's own acceptance rule for replay metadata, mirrored: index-aligned. */
function replayIsUsable(message) {
  const blocks = message.source.replayState.blocks
  if (blocks.length !== message.content.length) return false
  return blocks.every((block, index) => block.type === message.content[index].type)
}

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

test('listEdits reports only what the log actually holds', () => {
  // There is no staged tier any more: a replacement either lands in the log or the
  // call fails, so a record can never describe an edit the model cannot see.
  assert.deepEqual(listEdits([userEvent(0)]), [])
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
  const event = appendReplacement(session, 4, 4, [], 'assistant/message', { turn: 1, step: 1 })
  assert.equal(event.seq, 99)
  assert.equal(attempts.length, 2)
  assert.deepEqual(attempts[0].surfaceOp, { op: 'replace', startSeq: 4, endSeq: 4 })
  assert.equal(attempts[1].sourceEventSeqs, undefined)
})

test('appendReplacement cites every shadowed node of a range', () => {
  let seen
  const session = { append: (type, data, intent) => { seen = intent; return { type, seq: 9, time: 1, data } } }
  appendReplacement(session, 4, 7, [5, 6], 'user/message', {})
  assert.deepEqual(seen.surfaceOp, { op: 'replace', startSeq: 4, endSeq: 7 })
  // Provenance must include both endpoints and everything between them.
  assert.deepEqual([...seen.sourceEventSeqs].sort((a, b) => a - b), [4, 5, 6, 7])
})

test('appendReplacement reports the host error when every spelling fails', () => {
  const session = { append() { throw new Error('surface replace: start seq 4 not found in surface') } }
  assert.throws(() => appendReplacement(session, 4, 4, [], 'user/message', {}), /start seq 4 not found/)
})

// ---- regenerate -----------------------------------------------------------

test('regenerateRange spans the reply run and nothing beyond it', () => {
  // A question, a tool loop answering it, then the next user turn.
  const toolResult = {
    type: 'tool/result',
    seq: 4,
    time: 4,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { id: 't1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }], source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1' },
    },
  }
  const events = [
    userEvent(0, { text: 'question' }),
    assistantEvent(1, { text: 'partial', withToolCall: true }),
    toolResult,
    assistantEvent(2, { text: 'answer' }),
    userEvent(3, { text: 'next question' }),
  ]
  const range = regenerateRange(events, 0)
  assert.equal(range.startSeq, 0)
  // Ends at the answering step, not at the following user message.
  assert.equal(range.endSeq, 2)
  assert.deepEqual(range.hidden, [1, 4, 2])
})

test('regenerateRange crosses the context rows a turn splices in', () => {
  // The shape every real turn has: the reader's message, the runtime-context and
  // skill-catalog rows the harness injects behind it, then the answer. Those rows
  // are `user/message` events with a producer kind, and treating them as the next
  // turn is what made a first version of this regenerate nothing at all.
  const contextRow = userEvent(1, { id: 'ctx1', text: 'runtime context' })
  contextRow.data.source = { kind: 'runtime-context', form: 'snapshot' }
  const catalogRow = userEvent(2, { id: 'ctx2', text: 'skills' })
  catalogRow.data.source = { kind: 'skill-catalog', form: 'catalog' }
  const events = [
    userEvent(0, { text: 'question' }),
    contextRow,
    catalogRow,
    assistantEvent(3, { text: 'answer' }),
  ]
  const range = regenerateRange(events, 0)
  assert.equal(range.startSeq, 0)
  assert.equal(range.endSeq, 3)
  assert.deepEqual(range.hidden, [1, 2, 3])
})

test('regenerateRange stops at the next message the reader wrote', () => {
  const events = [
    userEvent(0, { text: 'question' }),
    assistantEvent(1, { text: 'answer' }),
    userEvent(2, { text: 'next question' }),
    assistantEvent(3, { text: 'next answer' }),
  ]
  const range = regenerateRange(events, 0)
  assert.equal(range.endSeq, 1)
  assert.deepEqual(range.hidden, [1])
})

test('regenerateRange stops at a node it cannot classify', () => {
  const events = [
    userEvent(0, { text: 'question' }),
    { type: 'system/message', seq: 1, time: 1, surfaceOp: 'append', data: { message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } } } },
    assistantEvent(2, { text: 'answer' }),
  ]
  const range = regenerateRange(events, 0)
  assert.equal(range.endSeq, 0)
  assert.deepEqual(range.hidden, [])
})

test('regenerateRange reports a message that is no longer on the surface', () => {
  assert.equal(regenerateRange([userEvent(0)], 42), undefined)
})

test('regenerateTrigger carries a source kind session format v4 accepts', () => {
  const trigger = regenerateTrigger('please answer again', 3)
  assert.equal(trigger.role, 'user')
  // v4 refuses the bare `plugin` wrapper outright ("format v4 message requires a
  // producer-owned source kind"); `plugin:<id>` is what its migrator writes.
  assert.notEqual(trigger.source.kind, 'plugin')
  assert.equal(trigger.source.kind, 'plugin:dsh-message-editor')
  assert.equal('plugin' in trigger.source, false)
  assert.equal(trigger.content[0].text, 'please answer again')
  assert.equal(typeof trigger.id, 'string')
  assert.notEqual(regenerateTrigger('x', 4).id, trigger.id)
  // The guard the host applies before enqueueing must accept it.
  assert.doesNotThrow(() => assertAdmissibleTrigger(trigger))
})

test('assertAdmissibleTrigger refuses exactly what the format refuses', () => {
  // The shape that killed a real turn: v4's retired v3 plugin wrapper.
  assert.throws(
    () => assertAdmissibleTrigger({ source: { kind: 'plugin', plugin: 'message-editor' } }),
    /producer-owned source kind/,
  )
  assert.throws(() => assertAdmissibleTrigger({ source: { kind: '' } }), /producer-owned/)
  assert.throws(() => assertAdmissibleTrigger({}), /producer-owned/)
  assert.doesNotThrow(() => assertAdmissibleTrigger({ source: { kind: 'user' } }))
  assert.doesNotThrow(() => assertAdmissibleTrigger({ source: { kind: 'plugin:anything' } }))
})

test('listEdits reports the nodes a regenerate hid', () => {
  const original = userEvent(0, { text: 'question' })
  const reply = assistantEvent(1, { text: 'answer' })
  const regenerated = replacement(5, 'user/message', {
    ...original.data,
    content: [{ type: 'text', text: 'edited question' }],
  }, 0, { endSeq: 1 })
  const record = listEdits([original, reply, regenerated], new Map())[0]
  assert.equal(record.originSeq, 0)
  assert.equal(record.text, 'edited question')
  assert.deepEqual(record.hiddenSeqs, [1])
})

test('textOfContent joins only text blocks', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(textOfContent(undefined), '')
})

// ---- provider replay metadata --------------------------------------------
//
// The DeepSeek adapter validates `source.replayState.blocks` by INDEX against
// `message.content` and throws the whole envelope away on any mismatch. The text
// never lives there — only thinking signatures do — so an edit that changes the
// block count without realigning that array silently costs the model the native
// reasoning continuity of the edited turn.

test('an assistant edit keeps replay metadata index-aligned', () => {
  const content = [
    { type: 'text', text: 'first' },
    { type: 'reasoning', text: 'because' },
    { type: 'text', text: 'second' },
  ]
  const event = replayAssistantEvent(9, content, [
    { type: 'text' },
    { type: 'reasoning', signature: 'sig-1' },
    { type: 'text' },
  ])
  const kept = []
  const next = applyText(content, 'edited', kept)
  // Two text blocks collapse to one; the reasoning block survives in place.
  assert.deepEqual(kept, [0, 1])
  const data = replacementData(event, next, undefined, kept)

  assert.deepEqual(data.message.content, [
    { type: 'text', text: 'edited' },
    { type: 'reasoning', text: 'because' },
  ])
  assert.equal(replayIsUsable(data.message), true)
  // The signature is what realignment exists to preserve.
  assert.equal(data.message.source.replayState.blocks[1].signature, 'sig-1')
  // And the accounting rule still holds.
  assert.equal('usage' in data, false)
})

test('an assistant edit that has to synthesise a text block stays aligned', () => {
  const content = [{ type: 'reasoning', text: 'because' }]
  const event = replayAssistantEvent(4, content, [{ type: 'reasoning', signature: 'sig-2' }])
  const kept = []
  const next = applyText(content, 'now with words', kept)
  assert.deepEqual(kept, [-1, 0])
  const data = replacementData(event, next, undefined, kept)
  assert.deepEqual(data.message.content.map((block) => block.type), ['text', 'reasoning'])
  assert.equal(replayIsUsable(data.message), true)
  assert.equal(data.message.source.replayState.blocks[1].signature, 'sig-2')
})

test('an edit that drops no blocks leaves the signatures exactly as they were', () => {
  const content = [{ type: 'text', text: 'only one' }]
  const blocks = [{ type: 'text' }]
  const event = replayAssistantEvent(2, content, blocks)
  const kept = []
  const next = applyText(content, 'changed', kept)
  const data = replacementData(event, next, undefined, kept)
  assert.equal(data.message.content[0].text, 'changed')
  assert.deepEqual(data.message.source.replayState.blocks, blocks)
})

test('a user message carries no replay metadata to realign', () => {
  const kept = []
  const content = applyText([{ type: 'text', text: 'hi' }], 'edited', kept)
  const data = replacementData(userEvent(0), content, undefined, kept)
  assert.equal('replayState' in (data.source ?? {}), false)
  assert.equal(data.content[0].text, 'edited')
})

test('alignReplay refuses to invent signatures for a mismatched kind', () => {
  const source = {
    kind: 'model',
    replayState: { response: { kind: 'deepseek-messages', version: 1 }, blocks: [{ type: 'reasoning', signature: 'sig-x' }] },
  }
  // Position 0 is now a text block, so the reasoning signature must not ride along.
  const aligned = alignReplay(source, [0], [{ type: 'text', text: 'x' }])
  assert.deepEqual(aligned.replayState.blocks, [{ type: 'text' }])
  assert.equal(alignReplay({ kind: 'model' }, [0], [{ type: 'text', text: 'x' }]), undefined)
})

test('a v4 compaction checkpoint is not mistaken for an edit', () => {
  const checkpoint = replacement(11, 'user/message', {
    id: 'checkpoint',
    role: 'user',
    content: [{ type: 'text', text: 'summary of the conversation so far' }],
    source: { kind: 'compact-checkpoint' },
  }, 0)
  assert.equal(isEditReplacement(checkpoint), false)
  assert.deepEqual(listEdits([userEvent(0), checkpoint], new Map()), [])
})

/** A neutral filler event so seq numbering in the listing test stays honest. */
function edits_placeholder() {
  return { type: 'step/end', seq: 0.5, time: 1, data: { turn: 1, step: 1 } }
}
