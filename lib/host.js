/**
 * dsh-message-editor — host half.
 *
 * Lets the browser half rewrite one past message in place. The rewrite is a
 * durable, append-only **surface replacement**: the host appends a fresh
 * `user/message` / `assistant/message` event carrying
 * `surfaceOp: { op: 'replace', startSeq, endSeq }`, so the model-visible
 * surface fold shadows the original node while the original stays in the log.
 * Nothing is regenerated and no message is ever mutated in place — this is the
 * same mechanism compaction and the tool-result pruner use.
 *
 * Why this is the only correct seam (verified against the running app):
 *   - `agent/request` carries `LlmCallConfig` only; it cannot carry messages.
 *   - `llm/stream` receives the frozen request but cannot replace it.
 *   - `Session.deriveMessages()` re-folds the log's surface at the top of every
 *     step, so ONE appended replacement governs every later model request.
 *
 * The browser half never sees the replacement as a transcript node (the chat
 * builder admits append-origin surface events only), so this channel is also
 * how the UI learns the edited text.
 *
 * Transport: an exact Fetch route on the connection's authenticated `/api`
 * surface. No generated Remote artifact, no zod contribution, no codegen.
 *
 * @module dsh-message-editor
 */

/** Cordis plugin name. */
export const name = 'dsh-message-editor'

/**
 * Services this plugin needs before `apply` may run.
 *
 * `sessions` is the live session store; `connection` owns the authenticated
 * `/api` surface the browser half calls through; `agents` is how a regenerate
 * wakes the session's driver for one more turn.
 */
export const inject = ['sessions', 'connection', 'agents']

/**
 * The exact Fetch route this plugin mounts.
 *
 * Two registries sit on the connection's authenticated `/api` surface. The
 * generic channel one, `ctx.connection.rpc.handle()`, mounts a physical route
 * through `owner.webServer`, so it requires the caller to declare `webServer` in
 * its inject as well. The exact Fetch-route registry used here needs no extra
 * service: `createSharedFetchHandler('/api')` matches this pathname before the
 * shared fallback and hands over the request only after the same Host/Origin
 * fence and browser authentication that every other `/api` call passes.
 */
const CHANNEL = '/api/dsh-message-editor'

/** Longest accepted replacement text, in UTF-16 code units. */
const MAX_TEXT = 400_000

/**
 * The request sent when a caller does not supply its own localized one.
 *
 * It reaches the model and is hidden from the transcript, so it only has to be
 * unambiguous about what changed.
 */
const DEFAULT_REGENERATE_INSTRUCTION =
  'I edited the previous message. Please answer it again from scratch, and ignore any earlier reply of yours to it.'

/** Surface-eligible event types (these are the only ones that may carry `surfaceOp`). */
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** Block types that carry an attachment the editor may drop. */
const ATTACHMENT_BLOCK_TYPES = new Set(['image', 'file'])

// ---------------------------------------------------------------------------
// Surface log helpers.
//
// These read the log defensively: the host half ships against several DSH
// releases, and the surface-op key names changed between them
// (`start`/`end` → `startSeq`/`endSeq`). Every reader accepts both.
// ---------------------------------------------------------------------------

/**
 * Normalize one event's surface operation.
 * @param {object} event - a session event.
 * @returns {{op: 'append'} | {op: 'replace', startSeq: number, endSeq: number} | undefined}
 *   the normalized operation, or undefined when the event is not on the surface.
 */
function surfaceOpOf(event) {
  const raw = event?.surfaceOp
  if (raw === undefined || raw === null) return undefined
  if (raw === 'append') return { op: 'append' }
  if (typeof raw !== 'object' || raw.op !== 'replace') return undefined
  const startSeq = raw.startSeq ?? raw.start
  const endSeq = raw.endSeq ?? raw.end
  if (!Number.isSafeInteger(startSeq) || !Number.isSafeInteger(endSeq)) return undefined
  return { op: 'replace', startSeq, endSeq }
}

/**
 * Read a session's complete event log through whichever accessor this DSH
 * release exposes.
 * @param {object} session - live session.
 * @returns {ReadonlyArray<object>} the log in seq order.
 */
function eventsOf(session) {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents() ?? []
  if (Array.isArray(session.events)) return session.events
  return []
}

/**
 * Index the log's replacement chains.
 *
 * The browser half keys an edit by the **append-origin** seq — the only stable
 * coordinate, because a replacement's own seq changes on every further edit.
 * This walks the whole log once and maps origin → current surface seq, which is
 * exactly what a further edit must target.
 * @param {ReadonlyArray<object>} events - the session log.
 * @returns {{current: Map<number, number>, originOf: Map<number, number>, bySeq: Map<number, object>, nodes: number[]}}
 *   current surface seq per origin, origin per surface seq, seq → event, and the
 *   ordered surface node seqs.
 */
function buildSurfaceIndex(events) {
  const current = new Map()
  const originOf = new Map()
  const bySeq = new Map()
  const nodes = []
  const shadowedBy = new Map()
  const anchorOf = new Map()
  for (const event of events) {
    if (typeof event?.seq === 'number') bySeq.set(event.seq, event)
    const op = surfaceOpOf(event)
    if (op === undefined) continue
    if (op.op === 'append') {
      if (!SURFACE_TYPES.has(event.type)) continue
      originOf.set(event.seq, event.seq)
      current.set(event.seq, event.seq)
      nodes.push(event.seq)
      continue
    }
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1) continue
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    shadowedBy.set(event.seq, shadowed)
    // The append-origin the first shadowed node stands for: a wide replacement
    // speaks for the message it began at, which is what lets a regenerate stay
    // addressable by the same origin. Compaction ignores this on purpose.
    anchorOf.set(event.seq, originOf.get(shadowed[0]) ?? shadowed[0])
    if (op.startSeq === op.endSeq) {
      const origin = originOf.get(op.startSeq) ?? op.startSeq
      originOf.set(event.seq, origin)
      current.set(origin, event.seq)
    } else {
      // A wider replacement (context compaction, or this plugin's regenerate)
      // shadows a whole run: every shadowed origin leaves the surface.
      for (const seq of shadowed) {
        const origin = originOf.get(seq)
        if (origin === undefined) continue
        originOf.delete(seq)
        current.delete(origin)
      }
    }
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
  }
  return { current, originOf, bySeq, nodes, shadowedBy, anchorOf }
}

/**
 * The surface seq currently standing in for one append-origin message.
 *
 * A single-node replacement maps straight through. A wide replacement — this
 * plugin's regenerate — leaves the generic fold with no mapping on purpose, so
 * that context compaction keeps reporting its swallowed messages as gone; the
 * anchor recorded during the fold is what re-attaches this plugin's own case.
 * @param {ReturnType<typeof buildSurfaceIndex>} index - the folded index.
 * @param {number} originSeq - the append-origin seq.
 * @returns {number | undefined} the current surface seq.
 */
function currentSeqOf(index, originSeq) {
  const direct = index.current.get(originSeq)
  if (direct !== undefined) return direct
  for (const [seq, anchor] of index.anchorOf) {
    if (anchor === originSeq) return seq
  }
  return undefined
}

/** Concatenate every `text` block of a content list. */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Collect the attachment ids referenced by a content list. */
function attachmentIds(content) {
  const ids = []
  if (!Array.isArray(content)) return ids
  for (const block of content) {
    if (!ATTACHMENT_BLOCK_TYPES.has(block?.type)) continue
    const id = block.attachment?.attachmentId
    if (typeof id === 'string') ids.push(id)
  }
  return ids
}

/**
 * Rewrite a content list so its text blocks read as one `nextText`, leaving
 * every other block — tool calls above all — byte-for-byte untouched.
 *
 * Collapsing several text blocks into the first one preserves the relative
 * order of the non-text blocks, which is what keeps an assistant message's
 * `tool-call` blocks paired with their `tool/result` events.
 * @param {ReadonlyArray<object>} content - the original content blocks.
 * @param {string} nextText - the replacement text.
 * @returns {Array<object>} the new content list.
 */
function applyText(content, nextText) {
  const blocks = Array.isArray(content) ? content : []
  let written = false
  const out = []
  for (const block of blocks) {
    if (block?.type === 'text') {
      if (written) continue
      written = true
      out.push({ ...block, text: nextText })
      continue
    }
    out.push(block)
  }
  if (!written) out.unshift({ type: 'text', text: nextText })
  return out
}

/** Drop the named attachment blocks from a content list. */
function dropAttachments(content, removed) {
  if (removed.size === 0) return Array.isArray(content) ? [...content] : []
  return (Array.isArray(content) ? content : []).filter((block) => {
    if (!ATTACHMENT_BLOCK_TYPES.has(block?.type)) return true
    return !removed.has(block.attachment?.attachmentId)
  })
}

/** Whether a surface event is a context-compaction checkpoint rather than an edit. */
function isCompactionCheckpoint(event) {
  const source = event?.data?.source
  return source?.kind === 'plugin' && source?.plugin === 'compact'
}

/** Whether a single-node replacement is one of this plugin's edits. */
function isEditReplacement(event) {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
  if (isCompactionCheckpoint(event)) return false
  return true
}

// ---------------------------------------------------------------------------
// Applying an edit.
// ---------------------------------------------------------------------------

/**
 * Append one surface replacement, tolerating both shipped surface-op shapes.
 *
 * `session.append` validates before it writes, so a rejected attempt leaves the
 * log untouched and the next spelling can be tried safely.
 * @param {object} session - live session.
 * @param {number} startSeq - first surface seq to shadow.
 * @param {number} endSeq - last surface seq to shadow; equal to `startSeq` for a
 *   single-node edit.
 * @param {number[]} cite - every shadowed surface seq, for the provenance gate.
 * @param {string} type - the surface event type.
 * @param {object} data - the replacement event data.
 * @returns {object} the appended event.
 * @throws when every accepted spelling was rejected by the host.
 */
function appendReplacement(session, startSeq, endSeq, cite, type, data) {
  const sources = [...new Set([startSeq, ...(cite ?? []), endSeq])]
  const shapes = [
    { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: sources },
    { surfaceOp: { op: 'replace', startSeq, endSeq } },
    { surfaceOp: { op: 'replace', start: startSeq, end: endSeq }, sourceEventSeqs: sources },
    { surfaceOp: { op: 'replace', start: startSeq, end: endSeq } },
  ]
  let lastError
  for (const intent of shapes) {
    try {
      return session.append(type, data, intent)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * The surface run a regenerate replaces: the edited message plus every reply
 * standing after it, up to the next message the reader actually wrote.
 *
 * Two kinds of node extend the run: the replies themselves (`assistant/message`,
 * `tool/result`) and the context rows the harness splices in behind a turn — a
 * runtime-context snapshot, a skill catalog, a session reference. Those are
 * `user/message` events too, but they carry a producer kind rather than `user`,
 * and on a real turn they land between the question and its answer. Stopping at
 * them would make every regenerate a single-node no-op.
 * @param {ReadonlyArray<object>} events - the session log.
 * @param {number} originSeq - the append-origin seq of the edited message.
 * @returns {{startSeq: number, endSeq: number, hidden: number[]} | undefined}
 *   the range to shadow, or undefined when the message is not on the surface.
 */
function regenerateRange(events, originSeq) {
  const index = buildSurfaceIndex(events)
  const target = currentSeqOf(index, originSeq)
  if (target === undefined) return undefined
  const { bySeq, nodes } = index
  const startIdx = nodes.indexOf(target)
  if (startIdx === -1) return undefined
  let endIdx = startIdx
  for (let cursor = startIdx + 1; cursor < nodes.length; cursor += 1) {
    if (!extendsReplyRun(bySeq.get(nodes[cursor]))) break
    endIdx = cursor
  }
  return {
    startSeq: nodes[startIdx],
    endSeq: nodes[endIdx],
    hidden: nodes.slice(startIdx + 1, endIdx + 1),
  }
}

/**
 * Whether one surface node belongs to the reply run that follows a question.
 *
 * A reader-authored message starts the next turn; a spliced context row belongs
 * to this one. Anything else — a compaction checkpoint, a system prompt — ends
 * the run, so the range can only ever be too small.
 */
function extendsReplyRun(event) {
  if (event?.type === 'assistant/message' || event?.type === 'tool/result') return true
  if (event?.type === 'user/message') return event.data?.source?.kind !== 'user'
  return false
}

/**
 * Build the message that asks the model to answer again.
 *
 * It is deliberately produced, not user-authored: the chat surface classifies a
 * `user/message` whose source is not `user` as an injected context row, which
 * this plugin's own `context` renderer hides, so the trigger drives a fresh turn
 * without leaving a second bubble in the transcript.
 *
 * The source kind is the format's own `plugin:<id>` form. Session format v4
 * refuses a bare `kind: 'plugin'` outright — that is the retired v3 wrapper, and
 * the migrator rewrites it to exactly this shape — so writing the old form makes
 * the harness reject the message and fail the turn that claims it.
 * @param {string} instruction - the request text, already localized by the caller.
 * @param {number} nonce - makes the id unique within the session.
 * @returns {object} a user message accepted by `agent.followup`.
 */
function regenerateTrigger(instruction, nonce) {
  return {
    id: `message-editor-regenerate-${nonce}`,
    role: 'user',
    content: [{ type: 'text', text: instruction }],
    source: { kind: producerSourceKind() },
  }
}

/**
 * This plugin's producer-owned source kind.
 * @returns {string} `plugin:<package name>`, the v4 form for a produced message.
 */
function producerSourceKind() {
  return `plugin:${name}`
}

/**
 * Refuse a trigger the session format would reject later, in a worse place.
 *
 * Session format v4 admits any non-empty `source.kind` except the retired bare
 * `plugin` wrapper. Enqueueing a message it refuses does not fail here — it fails
 * when the agent claims the message and appends it, which takes down the turn and
 * leaves the edit applied with no answer. Checking the rule up front turns that
 * into a plain refusal.
 * @param {object} message - the trigger about to be enqueued.
 * @throws when the message source is not admissible.
 */
function assertAdmissibleTrigger(message) {
  const kind = message?.source?.kind
  if (typeof kind !== 'string' || kind.length === 0 || kind === 'plugin') {
    throw new Error(
      `refusing to enqueue a message whose source kind is ${JSON.stringify(kind)}; `
      + 'session format v4 requires a producer-owned source kind',
    )
  }
}

/**
 * Build the replacement event data for one target node.
 *
 * Two rules matter more than anything else here:
 *   - an assistant message must keep EVERY `tool-call` block, in order, or the
 *     paired `tool/result` messages become orphans and the provider rejects the
 *     next request. Only `content` is rewritten, and the rewrite preserves every
 *     non-text block verbatim;
 *   - an assistant replacement must NOT restate `usage`: the token fold reads
 *     the raw log, so re-stating a past step's sample would bill it twice. The
 *     original event keeps the accounting.
 *
 * @param {object} event - the current surface event being shadowed.
 * @param {Array<object>} content - the replacement content blocks.
 * @param {{turn: number, step: number}} [at] - overrides for the staged path.
 * @returns {object} the data payload accepted by `session.append`.
 */
function replacementData(event, content, at) {
  if (event.type === 'user/message') {
    // `source` is preserved verbatim: the client classifies `user/message` by it,
    // and the load path requires an identified message with a valid source.
    return { ...event.data, content }
  }
  if (event.type === 'assistant/message') {
    const { usage: _usage, ...rest } = event.data
    return {
      ...rest,
      turn: at?.turn ?? event.data.turn,
      step: at?.step ?? event.data.step,
      message: { ...event.data.message, content },
    }
  }
  throw new Error(`message-editor: ${event.type} is not editable`)
}

/**
 * Whether a context-compaction transaction is currently open.
 *
 * Rewriting a node inside an open compaction bracket races its span
 * re-validation, so an edit refuses rather than corrupting the bracket.
 */
function compactionBusy(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'compaction/start') return true
    if (event?.type === 'compaction/end' || event?.type === 'session/end-seed') return false
  }
  return false
}

/**
 * Describe one edit for the browser half.
 * @param {number} originSeq - append-origin seq the UI keys on.
 * @param {object} replacement - the replacement event currently on the surface.
 * @param {object} original - the append-origin event.
 * @param {boolean} deferred - whether the edit is staged rather than logged.
 * @returns {object} the wire record.
 */
function editRecord(originSeq, replacement, original, deferred) {
  const content = contentOf(replacement)
  const originalContent = contentOf(original)
  const kept = new Set(attachmentIds(content))
  const removed = attachmentIds(originalContent).filter((id) => !kept.has(id))
  const messageId = messageIdOf(original) ?? messageIdOf(replacement)
  return {
    originSeq,
    ...(messageId === undefined ? {} : { messageId }),
    kind: replacement.type === 'user/message' ? 'user' : 'assistant',
    text: textOfContent(content),
    removed,
    editedAt: typeof replacement.time === 'number' ? replacement.time : 0,
    deferred: deferred === true,
  }
}

/** The content blocks one surface event contributes, regardless of its kind. */
function contentOf(event) {
  if (event?.type === 'assistant/message') return event.data.message.content
  return event.data?.content
}

/**
 * The durable identity of the message one surface event stands for.
 *
 * Both message kinds carry a stable `id` that survives every rewrite, so it is
 * the coordinate the browser's message actions already hold.
 */
function messageIdOf(event) {
  if (event?.type === 'assistant/message') {
    const id = event.data?.message?.id
    return typeof id === 'string' ? id : undefined
  }
  if (event?.type === 'user/message') {
    const id = event?.data?.id
    return typeof id === 'string' ? id : undefined
  }
  return undefined
}

/** The editor chips of one content list: every attachment with a display name. */
function attachmentChipsOf(content) {
  const chips = []
  for (const block of Array.isArray(content) ? content : []) {
    if (!ATTACHMENT_BLOCK_TYPES.has(block?.type)) continue
    const id = block.attachment?.attachmentId
    if (typeof id !== 'string') continue
    chips.push({ id, name: block.attachment?.name ?? block.attachment?.mediaType ?? id })
  }
  return chips
}

/**
 * Resolve a durable message id to the surface node that currently stands for it.
 * @param {ReadonlyArray<object>} events - the session log.
 * @param {string} messageId - the message to find.
 * @returns {{originSeq: number, seq: number, event: object} | undefined} the match.
 */
function findByMessageId(events, messageId) {
  const index = buildSurfaceIndex(events)
  const candidates = new Set([...index.current.keys(), ...index.anchorOf.values()])
  for (const originSeq of candidates) {
    const seq = currentSeqOf(index, originSeq)
    if (seq === undefined) continue
    const event = index.bySeq.get(seq)
    if (event === undefined) continue
    if (messageIdOf(event) === messageId) return { originSeq, seq, event }
  }
  return undefined
}

/**
 * Structural equality over the plain-JSON content domain.
 *
 * A revert restores the original blocks verbatim, so an edit whose current
 * content equals the append-origin content *is* the original: reporting it as
 * edited would leave a stale badge and a revert button after an undo.
 */
function sameContent(left, right) {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/**
 * Fold a session log into the edit table the browser half renders from.
 *
 * An edit is recognised structurally: a surface replacement of a `user/message`
 * or `assistant/message` that is not a compaction checkpoint and whose content
 * actually differs from the append-origin node it shadows. A replacement that
 * spanned more than one node is a regenerate: the extra nodes it shadowed ride
 * along as `hiddenSeqs` so the transcript can drop the replies it replaced. No
 * private marker is needed, so the table rebuilds correctly from a log written
 * by an earlier build.
 * @param {ReadonlyArray<object>} events - the session log.
 * @param {Map<string, object>} staged - session-keyed staged edits by origin seq.
 * @returns {Array<object>} the edit records, oldest origin first.
 */
function listEdits(events, staged) {
  const { bySeq, shadowedBy } = buildSurfaceIndex(events)
  const latest = new Map()
  for (const event of events) {
    const op = surfaceOpOf(event)
    if (op === undefined || op.op !== 'replace') continue
    if (!isEditReplacement(event)) continue
    const originSeq = firstOrigin(event, bySeq, op.startSeq)
    if (bySeq.get(originSeq) === undefined) continue
    // The nodes this replacement shadowed, minus the edited message itself.
    const hidden = (shadowedBy.get(event.seq) ?? []).slice(1)
    latest.set(originSeq, { event, hidden })
  }

  const records = []
  for (const [originSeq, entry] of latest) {
    const original = bySeq.get(originSeq)
    if (sameContent(contentOf(entry.event), contentOf(original))) continue
    records.push({
      ...editRecord(originSeq, entry.event, original, false),
      ...(entry.hidden.length === 0 ? {} : { hiddenSeqs: [...entry.hidden] }),
    })
  }
  if (staged !== undefined) {
    for (const [key, entry] of staged) {
      const originSeq = entry.originSeq
      if (latest.has(originSeq)) continue
      records.push({
        originSeq,
        kind: key.startsWith('assistant:') ? 'assistant' : 'user',
        text: entry.text,
        removed: entry.removed ?? [],
        editedAt: entry.editedAt ?? 0,
        deferred: true,
      })
    }
  }
  return records.sort((a, b) => a.originSeq - b.originSeq)
}

/**
 * Walk a replacement chain back to its append-origin seq.
 * @param {object} event - the replacement event.
 * @param {Map<number, object>} bySeq - seq → event.
 * @param {number} startSeq - the shadowed seq.
 * @returns {number} the append-origin seq.
 */
function firstOrigin(event, bySeq, startSeq) {
  let cursor = startSeq
  const guard = new Set()
  for (;;) {
    if (guard.has(cursor)) return startSeq
    guard.add(cursor)
    const target = bySeq.get(cursor)
    const op = surfaceOpOf(target)
    if (op === undefined || op.op === 'append') return cursor
    if (op.startSeq !== op.endSeq) return cursor
    cursor = op.startSeq
  }
}

// ---------------------------------------------------------------------------
// Wire result helpers.
// ---------------------------------------------------------------------------

/** A successful RPC result in the shape `ctx.connection.rpc` expects. */
function ok(value) {
  return { ok: true, value }
}

/** A failed RPC result; `details` is required by the envelope. */
function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/** Narrow an untrusted RPC payload to a plain record. */
function asRecord(payload) {
  return typeof payload === 'object' && payload !== null ? payload : {}
}

/** Require a non-empty string field. */
function requireString(record, field) {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error(`message-editor: "${field}" must be a non-empty string`), { code: 'bad-request' })
  }
  return value
}

/** Require a non-negative safe integer field. */
function requireSeq(record, field) {
  const value = record[field]
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error(`message-editor: "${field}" must be a non-negative integer`), { code: 'bad-request' })
  }
  return value
}

// ---------------------------------------------------------------------------
// Plugin body.
// ---------------------------------------------------------------------------

/**
 * Host plugin body: the edit RPC channel, the staged-edit flush, and the
 * durable replacement appends.
 * @param {object} ctx - host cordis context.
 */
export function apply(ctx) {
  /**
   * Monotonic counter behind the regenerate trigger's message id.
   *
   * Ids only have to be unique inside one session log; the counter keeps them
   * stable and readable rather than tying them to a clock.
   */
  let regenerateNonce = 0

  /**
   * Staged assistant edits, keyed by `<sessionId>\u0000<originSeq>`.
   *
   * A surface replacement of an `assistant/message` is a step-scoped event: the
   * session log admits it only while a model step is open. An edit made while
   * the agent is idle therefore cannot be logged immediately; it is staged here
   * and flushed from the next `agent/request`, which is inside the step that is
   * about to call the model.
   */
  const staged = new Map()

  /** Staged edits of one session, keyed by origin seq. */
  const stagedOf = (sessionId) => {
    const bucket = new Map()
    const prefix = `${sessionId}\u0000`
    for (const [key, entry] of staged) {
      if (key.startsWith(prefix)) bucket.set(entry.originSeq, { key, entry })
    }
    return bucket
  }

  /** The session column of the edit table, including staged entries. */
  const stagedMap = (sessionId) => {
    const bucket = new Map()
    const prefix = `${sessionId}\u0000`
    for (const [key, entry] of staged) {
      if (key.startsWith(prefix)) bucket.set(key, entry)
    }
    return bucket
  }

  /** Look up a live session or explain why the edit cannot proceed. */
  const liveSession = (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw Object.assign(
        new Error('message-editor: this session is not loaded; send a message to resume it, then edit'),
        { code: 'session-cold' },
      )
    }
    return session
  }

  /** Resolve origin seq → the surface event currently standing in for it. */
  const resolveTarget = (session, originSeq) => {
    const events = eventsOf(session)
    const index = buildSurfaceIndex(events)
    const targetSeq = currentSeqOf(index, originSeq)
    if (targetSeq === undefined) {
      throw Object.assign(
        new Error('message-editor: that message is no longer on the model-visible surface'),
        { code: 'target-not-found' },
      )
    }
    const event = index.bySeq.get(targetSeq) ?? session.eventAt?.(targetSeq)
    if (event === undefined) {
      throw Object.assign(new Error('message-editor: the target event could not be read'), { code: 'target-not-found' })
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') {
      throw Object.assign(
        new Error(`message-editor: ${event.type} messages cannot be edited`),
        { code: 'unsupported-target' },
      )
    }
    return { targetSeq, event, original: index.bySeq.get(originSeq) }
  }

  /** Normalize the caller's removal list into a Set of attachment ids. */
  const removalSet = (record) => {
    const removed = record['removed']
    if (!Array.isArray(removed)) return new Set()
    return new Set(removed.filter((id) => typeof id === 'string' && id.length > 0))
  }

  /**
   * Append one edit as a surface replacement, staging it when the log's
   * relational rules refuse an `assistant/message` outside an open step.
   *
   * With `regenerate` set on a user message the replacement spans the whole
   * stale exchange — the edited question plus the replies that answered it — so
   * the model no longer sees the answer it is being asked to redo, and no
   * `tool/result` is left orphaned by a reply that lost its call.
   * @returns {{deferred: boolean, record: object}} the settled edit.
   */
  const commit = (sessionId, session, originSeq, text, removed, regenerate) => {
    if (compactionBusy(eventsOf(session))) {
      throw Object.assign(
        new Error('message-editor: a context compaction is running; try again in a moment'),
        { code: 'compaction-busy' },
      )
    }
    const { targetSeq, event, original } = resolveTarget(session, originSeq)
    const base = event.type === 'assistant/message' ? event.data.message.content : event.data.content
    const content = applyText(dropAttachments(base, removed), text)
    const data = replacementData(event, content)
    const range = regenerate === true && event.type === 'user/message'
      ? regenerateRange(eventsOf(session), originSeq)
      : undefined
    const endSeq = range?.endSeq ?? targetSeq
    const cite = range?.hidden ?? []
    try {
      const appended = appendReplacement(session, targetSeq, endSeq, cite, event.type, data)
      staged.delete(`${sessionId}\u0000${originSeq}`)
      return {
        deferred: false,
        regenerated: range !== undefined,
        hidden: cite,
        record: {
          ...editRecord(originSeq, appended, original ?? event, false),
          ...(cite.length === 0 ? {} : { hiddenSeqs: [...cite] }),
        },
      }
    } catch (error) {
      if (event.type !== 'assistant/message') throw error
      // The step is closed: stage it for the next model step.
      const entry = { originSeq, text, removed: [...removed], editedAt: Date.now(), content }
      staged.set(`${sessionId}\u0000${originSeq}`, entry)
      return {
        deferred: true,
        regenerated: false,
        hidden: [],
        record: {
          originSeq,
          kind: 'assistant',
          text,
          removed: [...removed],
          editedAt: entry.editedAt,
          deferred: true,
        },
      }
    }
  }

  /** Flush every staged edit of one session now that a step is open. */
  const flush = (session, turn, step) => {
    const bucket = stagedOf(session.header?.id ?? session.id)
    if (bucket.size === 0) return
    for (const [originSeq, { key, entry }] of bucket) {
      const events = eventsOf(session)
      const index = buildSurfaceIndex(events)
      const targetSeq = currentSeqOf(index, originSeq)
      if (targetSeq === undefined) {
        staged.delete(key)
        continue
      }
      const event = index.bySeq.get(targetSeq)
      if (event === undefined || event.type !== 'assistant/message') {
        staged.delete(key)
        continue
      }
      const data = replacementData(event, entry.content, { turn, step })
      try {
        appendReplacement(session, targetSeq, targetSeq, [], 'assistant/message', data)
        staged.delete(key)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-message-editor: staged edit flush failed: ${String(error)}`)
      }
    }
  }
  // A step is open for the whole of `agent/request`, so this is the earliest
  // legal point at which an idle-time assistant edit can enter the log.
  ctx.on('agent/request', (payload, next) => {
    const agent = payload?.agent
    const session = agent?.session
    if (session !== undefined) flush(session, payload.turn, payload.step)
    return next()
  })

  /** Dispatch one decoded endpoint call and return the JSON envelope. */
  const dispatch = async (endpoint, rawPayload) => {
    try {
      const payload = asRecord(rawPayload)
      switch (endpoint) {
        case 'list': {
          const sessionId = requireString(payload, 'sessionId')
          const session = ctx.sessions.get(sessionId)
          const events = session === undefined ? [] : eventsOf(session)
          return ok({ edits: listEdits(events, stagedMap(sessionId)) })
        }
        case 'apply': {
          const sessionId = requireString(payload, 'sessionId')
          const originSeq = requireSeq(payload, 'originSeq')
          const text = requireString(payload, 'text')
          if (text.length > MAX_TEXT) return fail('text-too-large', 'the replacement text is too long')
          const regenerate = payload['regenerate'] === true
          // The trigger text is model-facing, so the browser half localizes it
          // and sends it along; the host only checks that it is usable.
          const instruction = regenerate && typeof payload['instruction'] === 'string'
            ? payload['instruction'].trim()
            : ''
          const session = liveSession(sessionId)
          // Build and admit the trigger BEFORE touching the log. A trigger the
          // session format would refuse must fail this call outright: enqueueing
          // it would let the log reject it later, inside the turn that claims it,
          // and take that whole turn down with the edit already applied.
          const trigger = regenerate ? regenerateTrigger(
            instruction.length > 0 ? instruction : DEFAULT_REGENERATE_INSTRUCTION,
            regenerateNonce + 1,
          ) : undefined
          if (trigger !== undefined) {
            try {
              assertAdmissibleTrigger(trigger)
            } catch (error) {
              return fail('regenerate-failed', error instanceof Error ? error.message : String(error))
            }
          }
          const settled = commit(sessionId, session, originSeq, text, removalSet(payload), regenerate)
          await ctx.sessions.flush(session)
          // Only a plain user-message edit has a stale reply to redo.
          if (settled.regenerated === true && trigger !== undefined) {
            const agent = ctx.agents?.get?.(sessionId)
            if (agent === undefined) {
              return fail('session-cold', 'the session has no live agent to regenerate with')
            }
            try {
              regenerateNonce += 1
              agent.followup(trigger)
            } catch (error) {
              return fail('regenerate-failed', error instanceof Error ? error.message : String(error))
            }
          }
          return ok(settled)
        }
        case 'read': {
          // The id → surface-seq resolution belongs here: the browser action
          // strip is handed a `messageId` and nothing else, and the host is the
          // only party that can resolve it against the current log.
          const sessionId = requireString(payload, 'sessionId')
          const messageId = requireString(payload, 'messageId')
          const session = liveSession(sessionId)
          const found = findByMessageId(eventsOf(session), messageId)
          if (found === undefined) {
            return fail('target-not-found', 'that message is not on the model-visible surface')
          }
          return ok({
            originSeq: found.originSeq,
            messageId,
            kind: found.event.type === 'assistant/message' ? 'assistant' : 'user',
            text: textOfContent(contentOf(found.event)),
            attachments: attachmentChipsOf(contentOf(found.event)),
          })
        }
        case 'revert': {
          const sessionId = requireString(payload, 'sessionId')
          const originSeq = requireSeq(payload, 'originSeq')
          const session = liveSession(sessionId)
          const events = eventsOf(session)
          const { bySeq } = buildSurfaceIndex(events)
          const original = bySeq.get(originSeq)
          if (original === undefined) {
            return fail('target-not-found', 'the original message is no longer in this log')
          }
          const stagedKey = `${sessionId}\u0000${originSeq}`
          const { targetSeq } = resolveTarget(session, originSeq)
          if (targetSeq === originSeq) {
            staged.delete(stagedKey)
            return ok({ reverted: true })
          }
          const content = contentOf(original)
          const data = replacementData(bySeq.get(targetSeq) ?? original, content)
          const appended = appendReplacement(session, targetSeq, targetSeq, [], original.type, data)
          staged.delete(stagedKey)
          await ctx.sessions.flush(session)
          return ok({ reverted: true, targetSeq: appended.seq })
        }
        default:
          return fail('unknown-endpoint', `unknown endpoint "${endpoint}"`)
      }
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'internal'
      const message = error instanceof Error ? error.message : String(error)
      return fail(code, message)
    }
  }

  // The route hands back plain JSON; the browser half reads the same envelope
  // shape either way, so a failure is a value and never a transport throw.
  const disposeRoute = ctx.connection.fetch.register({
    path: CHANNEL,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let result
      try {
        const body = asRecord(await request.json())
        result = await dispatch(
          typeof body['endpoint'] === 'string' ? body['endpoint'] : '',
          body['payload'],
        )
      } catch (error) {
        result = fail('bad-request', error instanceof Error ? error.message : 'malformed request body')
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  ctx.effect(() => () => { void disposeRoute?.() }, 'dsh-message-editor: edit route')
}

/**
 * Pure helpers, exported for the package's own tests.
 *
 * They carry no Cordis state — the plugin body above is their only caller — so
 * they are safe to exercise directly against a synthetic log.
 */
export const internals = {
  surfaceOpOf,
  buildSurfaceIndex,
  applyText,
  dropAttachments,
  textOfContent,
  attachmentIds,
  contentOf,
  sameContent,
  messageIdOf,
  attachmentChipsOf,
  findByMessageId,
  regenerateRange,
  regenerateTrigger,
  assertAdmissibleTrigger,
  listEdits,
  isEditReplacement,
  compactionBusy,
  replacementData,
  appendReplacement,
}
