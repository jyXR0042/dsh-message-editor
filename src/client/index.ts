/**
 * dsh-message-editor — browser half.
 *
 * Contributes three keyed occupants of the chat transcript plus one entry in
 * the shipped per-message action strip, all backed by one Session-scoped edit
 * object layer that talks to the host over the trust-fenced `/message-editor`
 * RPC channel.
 *
 * The plugin requires only React from the shell's module table; every other
 * value it needs it either draws itself (icons, layout, stylesheet) or receives
 * as a slot prop (`node`, `loadImage`, `t`, `useSession`).
 *
 * @module dsh-message-editor/client
 */

import { createElement as h } from 'react'
import { MessageEditorController } from './controller.ts'
import { createEditorChannel } from './channel.ts'
import { EditedUserMessageView } from './user-node.tsx'
import { EditedAssistantStepView } from './assistant-node.tsx'
import { EditedContextNodeView } from './context-node.tsx'
import { AssistantEditAction } from './assistant-action.tsx'
import { NS, en, zh } from './locales.ts'
import { installStyles } from './styles.ts'

/** Cordis plugin name. */
export const name = 'dsh-message-editor'

/**
 * The slot registry is the only hard dependency.
 *
 * The host channel is a plain same-origin `fetch` to this plugin's own `/api`
 * route, so it needs no client service at all — which also keeps the plugin
 * loadable in a composition whose connection service exposes a different shape.
 */
export const inject = ['slots']

/** The host's own translate namespace, for renderers this plugin delegates to. */
const CONVERSATION_NS = 'conversation'

/** Chat-node cells this plugin takes over. */
const NODE_SLOT = 'conversation.chat.node'

/** The shipped assistant action strip. */
const ACTIONS_SLOT = 'conversation.chat.assistant-actions'

/** Frame-wide overlay seat used for the transient toast. */
const OVERLAY_SLOT = 'shell.overlay'

/** One entry in the slot registry's read-only ledger. */
interface LedgerEntry {
  component?: { __dmeShadow?: boolean } | null
  /** The shipped entry's inject face — it may own hook sources its view needs. */
  inject?: ((...args: unknown[]) => Record<string, unknown>) | undefined
  options?: { key?: string; id?: string; priority?: number }
}

/** The slice of `ctx.slots` this plugin uses. */
interface SlotsApi {
  register: (options: Record<string, unknown>, component: unknown) => () => void
  inject: (key: string, callback: () => () => void) => () => void
  entries?: (key: string) => readonly LedgerEntry[]
}

/** The installed locale service, when the composition provides one. */
interface LocaleApi {
  register: (ns: string, locale: string, dict: Record<string, string>) => () => void
  bind: (ns: string) => (key: string, params?: Record<string, unknown>) => string
}

/** The slice of the client context this plugin uses. */
interface ClientContext {
  slots: SlotsApi
  effect: (execute: () => (() => void) | void, label?: string) => () => void
  on: (name: string, listener: (...args: never[]) => void) => () => void
  get: (name: string) => unknown
}

/** Injected face of the frame-wide toast. */
interface NoticeInjected {
  useNotice: <S>(selector: (value: string | null) => S) => S
}

/** Slot options this plugin passes to `register`. */
type RegisterOptions = Record<string, unknown>

/** Mark a component as this plugin's own, so built-in capture never picks it up. */
function markShadow<T>(component: T): T {
  try {
    Object.defineProperty(component as object, '__dmeShadow', { value: true, enumerable: false })
  } catch {
    /* A frozen component simply stays unmarked; capture falls back to ordering. */
  }
  return component
}

/** Read the installed locale service when the composition provides one. */
function localeOf(ctx: ClientContext): LocaleApi | undefined {
  const candidate = ctx.get('locale') as LocaleApi | undefined
  if (typeof candidate?.register !== 'function') return undefined
  if (typeof candidate.bind !== 'function') return undefined
  return candidate
}

/** Narrow an inherited inject face's `hooks` bag to a plain record. */
function asHooks(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * Read the shipped occupant of one keyed cell from the registration ledger.
 *
 * `entries()` is the documented read-only inspection surface of the slot
 * registry; the plugin captures the shipped renderer *before* registering its
 * own occupant for the same key. Nothing else about that entry is optional:
 * its `inject` face carries the hook sources its view reads — the shipped
 * `assistant-step` entry, for one, hands its view `usePresentation`, so a
 * shadow that dropped that face would crash on first render and abdicate.
 */
function captureEntry(slots: SlotsApi, key: string): LedgerEntry | undefined {
  try {
    const entries = typeof slots.entries === 'function' ? slots.entries(NODE_SLOT) : []
    for (const entry of entries) {
      if (entry?.options?.key !== key) continue
      const component = entry.component
      if (component === undefined || component === null) continue
      if (component.__dmeShadow === true) continue
      return entry
    }
  } catch (error) {
    console.warn('[dsh-message-editor] could not read the shipped chat renderers:', error)
  }
  return undefined
}

/** A tiny observable carrying the newest toast line. */
function createNoticeBus() {
  let value: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[dsh-message-editor] notice subscriber threw:', error)
      }
    }
  }
  return {
    getSnapshot: (): string | null => value,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    push: (message: string): void => {
      value = message
      emit()
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        value = null
        emit()
      }, 2800)
    },
    dispose: (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      listeners.clear()
    },
  }
}

/** Render the frame-wide toast line. */
function NoticeToast({ useNotice }: NoticeInjected) {
  const notice = useNotice((value) => value)
  if (notice === null || notice === undefined || notice === '') return null
  return h('div', { className: 'dme-toast', role: 'status' }, notice)
}

/**
 * Client plugin body.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  installStyles()

  const locale = localeOf(ctx)
  const hasLocale = locale !== undefined
  if (locale !== undefined) {
    // Single-locale registrations stay valid on every shipped overload.
    ctx.effect(() => locale.register(NS, 'zh', zh), 'dsh-message-editor: zh dictionary')
    ctx.effect(() => locale.register(NS, 'en', en), 'dsh-message-editor: en dictionary')
  }

  const fallbackT = (key: string): string => (typeof zh[key as keyof typeof zh] === 'string' ? zh[key as keyof typeof zh] : key)
  const conversationT = locale?.bind(CONVERSATION_NS)
  const localT = locale?.bind(NS) ?? fallbackT

  const notices = createNoticeBus()
  const channel = createEditorChannel()
  const controllers = new Map<string, MessageEditorController>()

  /** Create the Session-scoped edit layer, or return the live one. */
  const controllerFor = (sessionId: string): MessageEditorController => {
    let controller = controllers.get(sessionId)
    if (controller === undefined) {
      controller = new MessageEditorController(
        (endpoint, payload) => channel.call(endpoint, payload),
        sessionId,
        localT,
        (message: string) => { notices.push(message) },
      )
      controllers.set(sessionId, controller)
    }
    return controller
  }

  /** The shared injected face for one Session. */
  const injectedFor = (sessionId: string): Record<string, unknown> => {
    const controller = controllerFor(sessionId)
    return {
      hooks: { editor: controller },
      controller,
      conversationT,
      fallbackT,
    }
  }

  // A reconnect can only invalidate what was already read.
  ctx.on('connection/reset', () => {
    for (const controller of controllers.values()) {
      if (controller.getSnapshot().status !== 'cold') void controller.refresh()
    }
  })

  // ---- transcript cells ---------------------------------------------------

  ctx.slots.inject(NODE_SLOT, () => {
    const shipped = {
      user: captureEntry(ctx.slots, 'user'),
      steering: captureEntry(ctx.slots, 'steering'),
      'assistant-step': captureEntry(ctx.slots, 'assistant-step'),
      context: captureEntry(ctx.slots, 'context'),
    }
    if (shipped['assistant-step'] === undefined) {
      console.warn('[dsh-message-editor] shipped assistant renderer not found; using the self-contained body')
    }
    if (shipped.context === undefined) {
      console.warn('[dsh-message-editor] shipped context renderer not found; injected context rows will not render')
    }

    /**
     * Take one keyed cell.
     *
     * A release that shadows by priority refuses the first spelling, so the
     * retry lowers it; a release that replaces by key accepts the first call.
     * The inject face inherits the shipped entry's own face verbatim, so every
     * hook source its view reads stays available, and adds this plugin's.
     */
    const take = (
      key: keyof typeof shipped & string,
      component: unknown,
    ): (() => void) => {
      const cell = shipped[key]
      const base: RegisterOptions = {
        name: NODE_SLOT,
        key,
        ...(hasLocale ? { locale: NS } : {}),
        inject: (sessionId: string) => {
          const controller = controllerFor(sessionId)
          const inherited = typeof cell?.inject === 'function'
            ? (cell.inject(sessionId) ?? {})
            : {}
          const hooks = { ...(asHooks(inherited['hooks'])), editor: controller }
          return {
            ...inherited,
            hooks,
            controller,
            conversationT,
            fallbackT,
            pluginId: name,
            builtinNode: cell?.component,
          }
        },
      }
      try {
        return ctx.slots.register(base, component)
      } catch {
        return ctx.slots.register({ ...base, priority: -1 }, component)
      }
    }

    const disposers = [
      take('user', markShadow(EditedUserMessageView)),
      take('steering', markShadow(EditedUserMessageView)),
      take('assistant-step', markShadow(EditedAssistantStepView)),
      take('context', markShadow(EditedContextNodeView)),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          console.error('[dsh-message-editor] slot disposer threw:', error)
        }
      }
    }
  })

  // ---- assistant action strip --------------------------------------------

  ctx.slots.inject(ACTIONS_SLOT, () => ctx.slots.register({
    name: ACTIONS_SLOT,
    id: 'message-editor',
    order: 5,
    inject: injectedFor,
    ...(hasLocale ? { locale: NS } : {}),
  }, markShadow(AssistantEditAction)))

  // ---- frame-wide toast ---------------------------------------------------

  ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
    name: OVERLAY_SLOT,
    id: 'message-editor-notice',
    order: 90,
    inject: () => ({ hooks: { notice: notices } }),
  }, NoticeToast))

  ctx.effect(() => () => {
    for (const controller of controllers.values()) controller.dispose()
    controllers.clear()
    notices.dispose()
  }, 'dsh-message-editor: teardown')
}

export { MessageEditorController } from './controller.ts'
