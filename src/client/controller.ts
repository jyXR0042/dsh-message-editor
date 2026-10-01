/**
 * One Session's edit object layer.
 *
 * The host owns the truth: an edit is a durable surface-replacement event in
 * the session log, and this controller is a browser-local mirror of it. It
 * seeds once with `list`, applies mutations optimistically, and reconciles from
 * every reply — the host always answers with the settled record, so a lost race
 * or a deferred assistant edit converges without a refetch.
 *
 * The snapshot is a frozen value handed to `useSyncExternalStore` through the
 * slot `hooks` seat, so one controller backs every message control in its
 * Session.
 *
 * @module dsh-message-editor/client/controller
 */

/** One attachment the editor may drop from a user message. */
export interface EditorAttachment {
  id: string
  name: string
}

/** The durable record of one edited message, as the host reports it. */
export interface EditRecord {
  /** Append-origin seq of the message this edit shadows. */
  originSeq: number
  kind: 'user' | 'assistant'
  /** The edited text. */
  text: string
  /** Attachment ids dropped from the original content. */
  removed: string[]
  /** Epoch ms of the replacement. */
  editedAt: number
  /** True while the host has staged the edit for the next model step. */
  deferred: boolean
  /** The edited message's own id, so an action that only knows the id can match. */
  messageId?: string
}

/** What the host reports for one message addressed by its durable id. */
interface MessageInfo {
  originSeq: number
  messageId?: string
  kind: 'user' | 'assistant'
  text: string
  attachments?: readonly EditorAttachment[]
}

/** The message currently open in the inline editor. */
export interface EditingState {
  originSeq: number
  kind: 'user' | 'assistant'
  text: string
  /** Attachment ids dropped from the draft. */
  removed: ReadonlySet<string>
  /** Attachments the draft may drop. */
  attachments: readonly EditorAttachment[]
}

/** Load state of the one list read that seeds every control. */
export type EditorStatus = 'cold' | 'loading' | 'ready' | 'error'

/** Immutable view published to every control in one Session. */
export interface EditorView {
  status: EditorStatus
  /** Committed edit per append-origin seq. */
  edits: ReadonlyMap<number, EditRecord>
  /** The open inline editor, if any. */
  editing: EditingState | null
  /** A mutation is in flight. */
  pending: boolean
  /** Failure text for the open editor, cleared on the next action. */
  error: string | null
  /** Transient success note shown as a toast. */
  notice: string | null
}

/** Settled shape every mutating verb resolves to. */
export type EditorActionResult = { ok: true } | { ok: false; error: string }

const EMPTY_EDITS: ReadonlyMap<number, EditRecord> = new Map()

const INITIAL_VIEW: EditorView = Object.freeze({
  status: 'cold',
  edits: EMPTY_EDITS,
  editing: null,
  pending: false,
  error: null,
  notice: null,
})

const OK: EditorActionResult = Object.freeze({ ok: true })

/** Translate one host failure code through the entry's dictionary. */
function describe(t: (key: string) => string, code: string): string {
  switch (code) {
    case 'session-cold': return t('error.session-cold')
    case 'target-not-found': return t('error.target-not-found')
    case 'unsupported-target': return t('error.unsupported-target')
    case 'text-too-large': return t('error.text-too-large')
    case 'bad-request': return t('error.bad-request')
    case 'transport': return t('error.transport')
    default: return t('error.generic')
  }
}

/** One settled reply from the host channel. */
interface EditorEnvelope {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

/**
 * Per-Session edit layer. One instance backs every message control in that
 * Session, so a single list read seeds them all.
 */
export class MessageEditorController {
  private view = INITIAL_VIEW
  private readonly listeners = new Set<() => void>()
  private loadPromise: Promise<EditorActionResult> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly call: (endpoint: string, payload: unknown) => Promise<EditorEnvelope>
  private readonly sessionId: string
  private readonly t: (key: string) => string
  private readonly onNotice: (message: string, isError: boolean) => void

  /**
   * Fields are assigned in the body rather than declared as constructor
   * parameters, so the class stays plain enough to load under Node's
   * strip-only TypeScript mode — which is what lets the tests exercise it
   * directly without a build step.
   * @param call - the host channel caller.
   * @param sessionId - the Session owning every addressed message.
   * @param t - this plugin's translate seat.
   * @param onNotice - sink for transient success/failure toasts.
   */
  constructor(
    call: (endpoint: string, payload: unknown) => Promise<EditorEnvelope>,
    sessionId: string,
    t: (key: string) => string,
    onNotice: (message: string, isError: boolean) => void = () => {},
  ) {
    this.call = call
    this.sessionId = sessionId
    this.t = t
    this.onNotice = onNotice
  }

  /** Current frozen view (uSES getSnapshot). */
  getSnapshot = (): EditorView => this.view

  /** Subscribe to view replacement (uSES subscribe). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // ---------------------------------------------------------------------
  // Verbs.
  //
  // These are ARROW PROPERTIES on purpose. They are handed to presentational
  // components as bare callbacks (`onSave: editor.save`), so a prototype method
  // would lose its receiver and throw on `this.view` — the editor would open and
  // then refuse to type, save, or close. Binding at the definition removes that
  // whole class of mistake for every call site, present and future.
  // ---------------------------------------------------------------------

  /** Seed once; a failed load stays retryable. */
  ensure = (): Promise<EditorActionResult> => {
    if (this.view.status === 'ready') return Promise.resolve(OK)
    return this.refresh()
  }

  /** Re-read the authoritative edit table, collapsing concurrent callers. */
  refresh = (): Promise<EditorActionResult> => {
    if (this.loadPromise !== null) return this.loadPromise
    this.publish({ ...this.view, status: 'loading' })
    const pending = this.load()
    this.loadPromise = pending
    return pending.finally(() => { this.loadPromise = null })
  }

  /**
   * Open the inline editor for one message.
   * @param input - the message identity plus the text/attachments it starts from.
   */
  begin = (input: {
    originSeq: number
    kind: 'user' | 'assistant'
    text: string
    attachments: readonly EditorAttachment[]
  }): void => {
    void this.ensure()
    this.publish({
      ...this.view,
      editing: {
        originSeq: input.originSeq,
        kind: input.kind,
        text: input.text,
        removed: new Set(),
        attachments: input.attachments,
      },
      error: null,
    })
  }

  /**
   * Open the editor for a message addressed only by its id.
   *
   * The host owns the id → surface-seq resolution, so an action that receives
   * nothing but a `messageId` needs no conversation snapshot at all.
   * @param messageId - the message to edit.
   * @returns the settled result once the editor is open.
   */
  beginForMessage = (messageId: string): Promise<EditorActionResult> => {
    return this.mutate(async () => {
      for (const record of this.view.edits.values()) {
        if (record.messageId !== messageId) continue
        this.begin({
          originSeq: record.originSeq,
          kind: record.kind,
          text: record.text,
          attachments: [],
        })
        return OK
      }
      const result = await this.callHost('read', { sessionId: this.sessionId, messageId })
      if (!result.ok) {
        this.publish({ ...this.view, error: result.error })
        this.toast(result.error, true)
        return result
      }
      const info = (result.value ?? {}) as Partial<MessageInfo>
      if (typeof info.originSeq !== 'number') {
        const message = this.t('error.target-not-found')
        this.publish({ ...this.view, error: message })
        return { ok: false, error: message }
      }
      this.begin({
        originSeq: info.originSeq,
        kind: info.kind === 'assistant' ? 'assistant' : 'user',
        text: typeof info.text === 'string' ? info.text : '',
        attachments: Array.isArray(info.attachments) ? info.attachments : [],
      })
      return OK
    })
  }

  /** Close the inline editor without saving. */
  cancel = (): void => {
    if (this.view.editing === null) return
    this.publish({ ...this.view, editing: null, error: null })
  }

  /** Replace the draft text. */
  setText = (text: string): void => {
    const editing = this.view.editing
    if (editing === null) return
    this.publish({ ...this.view, editing: { ...editing, text } })
  }

  /** Toggle one attachment between kept and removed in the draft. */
  toggleAttachment = (id: string): void => {
    const editing = this.view.editing
    if (editing === null) return
    const removed = new Set(editing.removed)
    if (removed.has(id)) removed.delete(id)
    else removed.add(id)
    this.publish({ ...this.view, editing: { ...editing, removed } })
  }

  /** Commit the open draft through the host. */
  save = (): Promise<EditorActionResult> => {
    const editing = this.view.editing
    if (editing === null) return Promise.resolve(OK)
    const text = editing.text
    if (text.trim().length === 0) {
      this.publish({ ...this.view, error: this.t('editor.empty') })
      return Promise.resolve({ ok: false, error: this.t('editor.empty') })
    }
    return this.mutate(async () => {
      const result = await this.callHost('apply', {
        sessionId: this.sessionId,
        originSeq: editing.originSeq,
        text,
        removed: [...editing.removed],
      })
      if (!result.ok) {
        this.publish({ ...this.view, error: result.error })
        return result
      }
      const record = (result.value as { record?: EditRecord } | undefined)?.record
      if (record !== undefined) this.commit(record)
      this.publish({ ...this.view, editing: null, error: null })
      this.toast(this.t(record?.deferred === true ? 'badge.deferred' : 'notice.saved'))
      return OK
    })
  }

  /** Restore one edited message to its logged original. */
  revert = (originSeq: number): Promise<EditorActionResult> => {
    return this.mutate(async () => {
      const result = await this.callHost('revert', { sessionId: this.sessionId, originSeq })
      if (!result.ok) {
        this.toast(result.error, true)
        return result
      }
      const edits = new Map(this.view.edits)
      edits.delete(originSeq)
      this.publish({ ...this.view, edits, error: null })
      this.toast(this.t('notice.reverted'))
      return OK
    })
  }

  /** Drop subscribers and stop publishing when the owning fiber unloads. */
  dispose = (): void => {
    this.disposed = true
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer)
    this.listeners.clear()
  }

  /** Fetch the whole edit table and publish it as the seeded view. */
  private async load(): Promise<EditorActionResult> {
    const result = await this.callHost('list', { sessionId: this.sessionId })
    if (this.disposed) return OK
    if (!result.ok) {
      this.publish({ ...this.view, status: 'error', error: result.error })
      return result
    }
    const edits = new Map<number, EditRecord>()
    const list = (result.value as { edits?: unknown })?.edits
    if (Array.isArray(list)) {
      for (const raw of list) {
        const record = raw as EditRecord
        if (typeof record?.originSeq === 'number') edits.set(record.originSeq, record)
      }
    }
    this.publish({ ...this.view, status: 'ready', edits, error: null })
    return OK
  }

  /** One round trip, normalized to the settled action shape. */
  private async callHost(endpoint: string, payload: unknown): Promise<
    { ok: true; value: unknown } | { ok: false; error: string }
  > {
    try {
      const envelope = await this.call(endpoint, payload)
      if (envelope?.ok === true) return { ok: true, value: envelope.value }
      const code = envelope?.error?.code ?? 'unknown'
      return { ok: false, error: describe(this.t, code) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `${this.t('error.transport')} ${message}` }
    }
  }

  /** Serialize one mutation behind the previous one and settle its state. */
  private mutate(operation: () => Promise<EditorActionResult>): Promise<EditorActionResult> {
    const guarded = async (): Promise<EditorActionResult> => {
      if (this.disposed) return OK
      this.publish({ ...this.view, pending: true })
      let result: EditorActionResult
      try {
        result = await operation()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        result = { ok: false, error: message }
      }
      if (!this.disposed) this.publish({ ...this.view, pending: false })
      return result
    }
    const settled = this.tail.then(guarded, guarded)
    this.tail = settled.then(() => undefined, () => undefined)
    return settled
  }

  /** Merge one committed record, preserving every other entry's identity. */
  private commit(record: EditRecord): void {
    const edits = new Map(this.view.edits)
    edits.set(record.originSeq, record)
    this.publish({ ...this.view, edits })
  }

  /** Show one transient toast line. */
  private toast(message: string, isError = false): void {
    if (this.disposed) return
    this.publish({ ...this.view, notice: message })
    try {
      this.onNotice(message, isError)
    } catch (error) {
      console.error('[dsh-message-editor] notice sink threw:', error)
    }
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      if (!this.disposed) this.publish({ ...this.view, notice: null })
    }, isError ? 5200 : 2600)
  }

  /** Replace the view and contain subscriber failures. */
  private publish(view: EditorView): void {
    this.view = Object.freeze(view)
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-message-editor] subscriber threw:', error)
      }
    }
  }
}
