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
 * `/api` surface the browser half calls through.
 */
export const inject = ['sessions', 'connection']

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
 * @returns {{current: Map<number, number>, originOf: Map<number, number>, bySeq: Map<number, object>}}
 *   current surface seq per origin, origin per surface seq, and seq → event.
 */
function buildSurfaceIndex(events) {
  const current = new Map()
  const originOf = new Map()
  const bySeq = new Map()
  for (const event of events) {
    if (typeof event?.seq === 'number') bySeq.set(event.seq, event)
    const op = surfaceOpOf(event)
    if (op === undefined) continue
    if (op.op === 'append') {
      if (!SURFACE_TYPES.has(event.type)) continue
      originOf.set(event.seq, event.seq)
      current.set(event.seq, event.seq)
      continue
    }
    if (op.startSeq === op.endSeq) {
      const origin = originOf.get(op.startSeq) ?? op.startSeq
      originOf.set(event.seq, origin)
      current.set(origin, event.seq)
      continue
    }
    // A wider replacement (context compaction shadows a whole range): every
    // shadowed origin leaves the surface, so drop each one.
    for (let seq = op.startSeq; seq <= op.endSeq; seq += 1) {
      const origin = originOf.get(seq)
      if (origin === undefined) continue
      originOf.delete(seq)
      current.delete(origin)
    }
  }
  return { current, originOf, bySeq }
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
 * @param {number} seq - the current surface seq to shadow.
 * @param {string} type - the surface event type.
 * @param {object} data - the replacement event data.
 * @returns {object} the appended event.
 * @throws when every accepted spelling was rejected by the host.
 */
function appendReplacement(session, seq, type, data) {
  const shapes = [
    { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
    { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq } },
    { surfaceOp: { op: 'replace', start: seq, end: seq }, sourceEventSeqs: [seq] },
    { surfaceOp: { op: 'replace', start: seq, end: seq } },
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
  const { current, bySeq } = buildSurfaceIndex(events)
  for (const [originSeq, seq] of current) {
    const event = bySeq.get(seq)
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
 * An edit is recognised structurally: a single-node surface replacement of a
 * `user/message` or `assistant/message` that is not a compaction checkpoint and
 * whose content actually differs from the append-origin node it shadows. No
 * private marker is needed, so the table rebuilds correctly from a log written
 * by an earlier build.
 * @param {ReadonlyArray<object>} events - the session log.
 * @param {Map<string, object>} staged - session-keyed staged edits by origin seq.
 * @returns {Array<object>} the edit records, oldest origin first.
 */
function listEdits(events, staged) {
  const { bySeq } = buildSurfaceIndex(events)
  const latest = new Map()
  for (const event of events) {
    const op = surfaceOpOf(event)
    if (op === undefined || op.op !== 'replace' || op.startSeq !== op.endSeq) continue
    if (!isEditReplacement(event)) continue
    const originSeq = firstOrigin(event, bySeq, op.startSeq)
    if (bySeq.get(originSeq) === undefined) continue
    latest.set(originSeq, event)
  }

  const records = []
  for (const [originSeq, event] of latest) {
    const original = bySeq.get(originSeq)
    if (sameContent(contentOf(event), contentOf(original))) continue
    records.push(editRecord(originSeq, event, original, false))
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
    const { current, bySeq } = buildSurfaceIndex(events)
    const targetSeq = current.get(originSeq)
    if (targetSeq === undefined) {
      throw Object.assign(
        new Error('message-editor: that message is no longer on the model-visible surface'),
        { code: 'target-not-found' },
      )
    }
    const event = bySeq.get(targetSeq) ?? session.eventAt?.(targetSeq)
    if (event === undefined) {
      throw Object.assign(new Error('message-editor: the target event could not be read'), { code: 'target-not-found' })
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') {
      throw Object.assign(
        new Error(`message-editor: ${event.type} messages cannot be edited`),
        { code: 'unsupported-target' },
      )
    }
    return { targetSeq, event, original: bySeq.get(originSeq) }
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
   * @returns {{deferred: boolean, record: object}} the settled edit.
   */
  const commit = (sessionId, session, originSeq, text, removed) => {
    if (compactionBusy(eventsOf(session))) {
      throw Object.assign(
        new Error('message-editor: a context compaction is running; try again in a moment'),
        { code: 'compaction-busy' },
      )
    }
    const { targetSeq, event } = resolveTarget(session, originSeq)
    const base = event.type === 'assistant/message' ? event.data.message.content : event.data.content
    const content = applyText(dropAttachments(base, removed), text)
    const data = replacementData(event, content)
    try {
      const appended = appendReplacement(session, targetSeq, event.type, data)
      const original = resolveTarget(session, originSeq).original ?? event
      staged.delete(`${sessionId}\u0000${originSeq}`)
      return { deferred: false, record: editRecord(originSeq, appended, original, false) }
    } catch (error) {
      if (event.type !== 'assistant/message') throw error
      // The step is closed: stage it for the next model step.
      const entry = { originSeq, text, removed: [...removed], editedAt: Date.now(), content }
      staged.set(`${sessionId}\u0000${originSeq}`, entry)
      return {
        deferred: true,
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
      const { current, bySeq } = buildSurfaceIndex(events)
      const targetSeq = current.get(originSeq)
      if (targetSeq === undefined) {
        staged.delete(key)
        continue
      }
      const event = bySeq.get(targetSeq)
      if (event === undefined || event.type !== 'assistant/message') {
        staged.delete(key)
        continue
      }
      const data = replacementData(event, entry.content, { turn, step })
      try {
        appendReplacement(session, targetSeq, 'assistant/message', data)
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
          const session = liveSession(sessionId)
          const settled = commit(sessionId, session, originSeq, text, removalSet(payload))
          await ctx.sessions.flush(session)
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
          const appended = appendReplacement(session, targetSeq, original.type, data)
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
  listEdits,
  isEditReplacement,
  compactionBusy,
  replacementData,
  appendReplacement,
}
