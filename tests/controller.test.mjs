/**
 * Client edit-layer tests.
 *
 * The reported failure this file exists for: the editor opened, but Cancel did
 * nothing. The controller's verbs were prototype methods handed to the view as
 * bare callbacks, so `this` was lost and every call threw. Every verb is now an
 * arrow property, and these tests invoke them **detached** — exactly how the
 * editor does — so the regression cannot come back silently.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { MessageEditorController } = await import('../src/client/controller.ts')

/** A channel double that records calls and replays canned envelopes. */
function makeChannel(routes) {
  const calls = []
  return {
    calls,
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      const handler = routes[endpoint]
      if (handler === undefined) return { ok: false, error: { code: 'unknown-endpoint' } }
      return handler(payload)
    },
  }
}

const T = (key) => key

function makeController(routes) {
  const channel = makeChannel(routes)
  const controller = new MessageEditorController(
    (endpoint, payload) => channel.call(endpoint, payload),
    'session-1',
    T,
  )
  return { controller, channel }
}

test('ensure seeds the edit table from the host list', async () => {
  const { controller } = makeController({
    list: () => ({ ok: true, value: { edits: [{ originSeq: 3, messageId: 'a1', kind: 'assistant', text: 'edited', removed: [], editedAt: 1, deferred: false }] } }),
  })
  assert.equal(controller.getSnapshot().status, 'cold')
  assert.equal((await controller.ensure()).ok, true)
  assert.equal(controller.getSnapshot().status, 'ready')
  assert.equal(controller.getSnapshot().edits.get(3).text, 'edited')
})

test('failure codes become readable messages', async () => {
  const { controller } = makeController({ list: () => ({ ok: false, error: { code: 'session-cold' } }) })
  const result = await controller.ensure()
  assert.equal(result.ok, false)
  assert.equal(result.error, 'error.session-cold')
})

test('beginForMessage reads the message from the host and opens the editor', async () => {
  const { controller, channel } = makeController({
    list: () => ({ ok: true, value: { edits: [] } }),
    read: () => ({ ok: true, value: { originSeq: 7, kind: 'assistant', text: 'original answer', attachments: [] } }),
  })
  await controller.ensure()
  const result = await controller.beginForMessage('a1')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(channel.calls.map((call) => call.endpoint), ['list', 'read'])
  const editing = controller.getSnapshot().editing
  assert.equal(editing.originSeq, 7)
  assert.equal(editing.kind, 'assistant')
  assert.equal(editing.text, 'original answer')
})

test('beginForMessage reuses a known edit instead of re-reading', async () => {
  const { controller, channel } = makeController({
    list: () => ({ ok: true, value: { edits: [{ originSeq: 3, messageId: 'a1', kind: 'assistant', text: 'edited once', removed: [], editedAt: 1, deferred: false }] } }),
  })
  await controller.ensure()
  await controller.beginForMessage('a1')
  assert.deepEqual(channel.calls.map((call) => call.endpoint), ['list'])
  assert.equal(controller.getSnapshot().editing.text, 'edited once')
})

test('a detached cancel closes the editor', async () => {
  const { controller } = makeController({ list: () => ({ ok: true, value: { edits: [] } }) })
  controller.begin({ originSeq: 1, kind: 'user', text: 'hello', attachments: [] })
  assert.notEqual(controller.getSnapshot().editing, null)

  // Detached on purpose: this is how the view holds it.
  const { cancel } = controller
  cancel()
  assert.equal(controller.getSnapshot().editing, null)
})

test('a detached setText updates the draft', async () => {
  const { controller } = makeController({ list: () => ({ ok: true, value: { edits: [] } }) })
  controller.begin({ originSeq: 1, kind: 'user', text: 'hello', attachments: [] })
  const { setText } = controller
  setText('hello again')
  assert.equal(controller.getSnapshot().editing.text, 'hello again')
})

test('a detached toggleAttachment marks and unmarks an attachment', async () => {
  const { controller } = makeController({ list: () => ({ ok: true, value: { edits: [] } }) })
  controller.begin({
    originSeq: 1,
    kind: 'user',
    text: 'look',
    attachments: [{ id: 'i1', name: 'a.png' }, { id: 'i2', name: 'b.png' }],
  })
  const { toggleAttachment } = controller
  toggleAttachment('i1')
  assert.deepEqual([...controller.getSnapshot().editing.removed], ['i1'])
  toggleAttachment('i1')
  assert.deepEqual([...controller.getSnapshot().editing.removed], [])
})

test('a detached save commits the draft and closes the editor', async () => {
  const { controller, channel } = makeController({
    list: () => ({ ok: true, value: { edits: [] } }),
    apply: () => ({ ok: true, value: { deferred: false, record: { originSeq: 1, messageId: 'u1', kind: 'user', text: 'fixed', removed: [], editedAt: 9, deferred: false } } }),
  })
  controller.begin({ originSeq: 1, kind: 'user', text: 'first', attachments: [] })
  const { setText, save } = controller
  setText('fixed')
  assert.equal((await save()).ok, true)

  const apply = channel.calls.find((call) => call.endpoint === 'apply')
  assert.deepEqual(apply.payload, { sessionId: 'session-1', originSeq: 1, text: 'fixed', removed: [] })
  assert.equal(controller.getSnapshot().editing, null)
  assert.equal(controller.getSnapshot().edits.get(1).text, 'fixed')
  assert.equal(controller.getSnapshot().notice, 'notice.saved')
})

test('save refuses an empty draft without calling the host', async () => {
  const { controller, channel } = makeController({ list: () => ({ ok: true, value: { edits: [] } }) })
  controller.begin({ originSeq: 1, kind: 'user', text: '', attachments: [] })
  const { save } = controller
  const result = await save()
  assert.equal(result.ok, false)
  assert.equal(result.error, 'editor.empty')
  assert.equal(channel.calls.some((call) => call.endpoint === 'apply'), false)
  assert.equal(controller.getSnapshot().editing.text, '')
})

test('a host refusal keeps the editor open and shows the reason', async () => {
  const { controller } = makeController({
    list: () => ({ ok: true, value: { edits: [] } }),
    apply: () => ({ ok: false, error: { code: 'target-not-found' } }),
  })
  controller.begin({ originSeq: 1, kind: 'user', text: 'x', attachments: [] })
  const { save } = controller
  const result = await save()
  assert.equal(result.ok, false)
  assert.equal(result.error, 'error.target-not-found')
  assert.notEqual(controller.getSnapshot().editing, null)
  assert.equal(controller.getSnapshot().error, 'error.target-not-found')
})

test('a detached revert drops the record and calls the host', async () => {
  const { controller, channel } = makeController({
    list: () => ({ ok: true, value: { edits: [{ originSeq: 1, messageId: 'u1', kind: 'user', text: 'edited', removed: [], editedAt: 1, deferred: false }] } }),
    revert: () => ({ ok: true, value: { reverted: true } }),
  })
  await controller.ensure()
  const { revert } = controller
  assert.equal((await revert(1)).ok, true)
  assert.equal(channel.calls.some((call) => call.endpoint === 'revert'), true)
  assert.equal(controller.getSnapshot().edits.size, 0)
  assert.equal(controller.getSnapshot().notice, 'notice.reverted')
})

test('a transport throw settles as a failure instead of rejecting', async () => {
  const controller = new MessageEditorController(
    async () => { throw new Error('network down') },
    'session-1',
    T,
  )
  const result = await controller.ensure()
  assert.equal(result.ok, false)
  assert.match(result.error, /network down/)
})

// ---- regenerate and error reporting ---------------------------------------

test('regenerateTurn resolves the reply id on the host and asks for a fresh answer', async () => {
  const { controller, channel } = makeController({
    list: () => ({ ok: true, value: { edits: [] } }),
    read: () => ({
      ok: true,
      value: { originSeq: 3, messageId: 'a1', kind: 'assistant', text: 'answer', attachments: [] },
    }),
    apply: () => ({
      ok: true,
      value: {
        regenerated: true,
        hidden: [3],
        record: {
          originSeq: 2, messageId: 'u1', kind: 'user', text: 'question',
          removed: [], editedAt: 9, hiddenSeqs: [3],
        },
      },
    }),
  })
  const { regenerateTurn } = controller
  assert.equal((await regenerateTurn('a1')).ok, true)

  // The strip is handed an id, so the host owns the id → seq resolution.
  const read = channel.calls.find((call) => call.endpoint === 'read')
  assert.equal(read.payload.messageId, 'a1')
  const apply = channel.calls.find((call) => call.endpoint === 'apply')
  assert.equal(apply.payload.regenerate, true)
  assert.equal(apply.payload.originSeq, 3)
  // No text: naming a turn without rewriting it means "answer this again", and
  // the host reuses the question exactly as it stands.
  assert.equal('text' in apply.payload, false)
  assert.equal(controller.getSnapshot().notice, 'notice.regenerating')
  // The replies the regenerate replaced are published as hidden.
  assert.deepEqual([...controller.getSnapshot().hidden], [3])
})

test('saveAndRegenerate asks the host to regenerate and sends the instruction', async () => {
  const { controller, channel } = makeController({
    list: () => ({ ok: true, value: { edits: [] } }),
    apply: () => ({
      ok: true,
      value: {
        regenerated: true,
        hidden: [2],
        record: { originSeq: 1, messageId: 'u1', kind: 'user', text: 'fixed', removed: [], editedAt: 9, deferred: false, hiddenSeqs: [2] },
      },
    }),
  })
  controller.begin({ originSeq: 1, kind: 'user', text: 'first', attachments: [] })
  const { setText, saveAndRegenerate } = controller
  setText('fixed')
  assert.equal((await saveAndRegenerate()).ok, true)

  const apply = channel.calls.find((call) => call.endpoint === 'apply')
  assert.equal(apply.payload.regenerate, true)
  assert.equal(apply.payload.instruction, 'regenerate.instruction')
  assert.equal(controller.getSnapshot().notice, 'notice.regenerating')
  // The replies the regenerate replaced are published as hidden.
  assert.deepEqual([...controller.getSnapshot().hidden], [2])
})

test('a plain save sends no regenerate fields and hides nothing', async () => {
  const { controller, channel } = makeController({
    list: () => ({ ok: true, value: { edits: [] } }),
    apply: () => ({ ok: true, value: { record: { originSeq: 1, kind: 'user', text: 'fixed', removed: [], editedAt: 9, deferred: false } } }),
  })
  controller.begin({ originSeq: 1, kind: 'user', text: 'first', attachments: [] })
  const { save } = controller
  await save()
  const apply = channel.calls.find((call) => call.endpoint === 'apply')
  assert.equal('regenerate' in apply.payload, false)
  assert.equal('instruction' in apply.payload, false)
  assert.equal(controller.getSnapshot().hidden.size, 0)
})

test('hidden replies are rebuilt from a reload, and cleared by a revert', async () => {
  const routes = {
    list: () => ({
      ok: true,
      value: {
        edits: [
          { originSeq: 1, messageId: 'u1', kind: 'user', text: 'edited', removed: [], editedAt: 1, deferred: false, hiddenSeqs: [2, 3] },
          { originSeq: 5, messageId: 'u2', kind: 'user', text: 'other', removed: [], editedAt: 2, deferred: false },
        ],
      },
    }),
    revert: () => ({ ok: true, value: { reverted: true } }),
  }
  const { controller } = makeController(routes)
  await controller.ensure()
  assert.deepEqual([...controller.getSnapshot().hidden].sort((a, b) => a - b), [2, 3])
  const { revert } = controller
  await revert(1)
  assert.equal(controller.getSnapshot().hidden.size, 0)
})

test('a stale host is named instead of collapsing to a generic failure', async () => {
  // This is what an older host module answers a newer browser half with.
  const { controller } = makeController({ list: () => ({ ok: false, error: { code: 'unknown-endpoint' } }) })
  const result = await controller.ensure()
  assert.equal(result.error, 'error.staleHost')
})

test('an unrecognized failure keeps the host message for diagnosis', async () => {
  const { controller } = makeController({
    list: () => ({ ok: false, error: { code: 'internal', message: 'message-editor: the target event could not be read' } }),
  })
  const result = await controller.ensure()
  // The plugin's own prefix is stripped; the reason survives.
  assert.match(result.error, /^error\.generic/)
  assert.match(result.error, /the target event could not be read/)
  assert.doesNotMatch(result.error, /message-editor:/)
})

test('a known compaction conflict reads as itself', async () => {
  const { controller } = makeController({
    list: () => ({ ok: true, value: { edits: [] } }),
    apply: () => ({ ok: false, error: { code: 'compaction-busy' } }),
  })
  controller.begin({ originSeq: 1, kind: 'user', text: 'x', attachments: [] })
  const { save } = controller
  assert.equal((await save()).error, 'error.compactionBusy')
})

test('a disposed controller stops publishing', async () => {
  const { controller } = makeController({ list: () => ({ ok: true, value: { edits: [] } }) })
  let notified = 0
  controller.subscribe(() => { notified += 1 })
  await controller.ensure()
  assert.ok(notified > 0)
  const seen = notified
  controller.dispose()
  controller.begin({ originSeq: 1, kind: 'user', text: 'x', attachments: [] })
  assert.equal(notified, seen)
})
