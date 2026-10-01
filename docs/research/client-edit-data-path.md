# Client-side data path for a message-EDIT feature (replacement events → browser)

Read-only investigation of `E:\1AIDEEPSEEKHARNESS` (DSH monorepo). Every path is relative to that root.
Companion to `MESSAGE-EDIT-SEAM-REPORT.md` (which covers the Host-side append seam). This file answers:
**can the browser see a `surfaceOp: {op:'replace'}` event, through which public API, and what is the
minimum-moving-parts reactive design?**

---

## 0. Verdict

1. **YES — the browser receives replacement events, with `surfaceOp` and `sourceEventSeqs` intact**, on
   both the live mux stream and the history page. They are *not* filtered before the wire. Only the
   *chat transcript builder* filters them (via `isAppendSurfaceEvent`), and that filter lives in
   individual `ConversationNodeDefinition`s, not in the transport.
2. **No slot component can read raw events.** `ConversationSnapshot` carries no event log and no
   `seq → event` map; the raw window is `private` on the client `Session`. The only public place a raw
   event is handed out is inside a `ConversationNodeDefinition` callback (`match`/`start`/`update`).
3. **Recommended reactive mechanism: a Host-registered `ctx.sessionProjections` unit + `useProjection`
   on the client.** It is the only channel that is (i) push-reactive, (ii) folded over the *whole* host
   log rather than the client's paged window, and (iii) readable from any session-scope slot component.
   The alternative (own client `ConversationNodeDefinition`) needs no host code but cannot show the edited
   text *in place* and misses edits that have fallen outside the loaded history window.
4. **Blockers:** a new Host **Remote** namespace cannot be added by a third party (mount list is
   hard-coded); a static third-party **client plugin** must be composed into the web bundle; the
   runtime plugin runner (`cordis_define`/`cordis_run`) is the workaround for both.

---

## 1. Does the client see replacement events? (yes)

### 1.1 Host → wire: no surface filtering on either path

| step | evidence |
|---|---|
| live push of **every** committed event, unfiltered | `packages/host/apiproxy/src/api-proxy.ts:3475-3493` — `ctx.on('session/event', …)` → `queue.push(frame({ type: 'session/event', sessionId, event, view? }))`. No `surfaceOp` test. |
| mux stream is all-session aggregated; every consumer gets every frame | `api-proxy.ts:3429-3435` + `api-proxy.ts:479-482` (`subscribeSession` only queues the `session/subscribed` baseline) |
| history page content: replacement copies consume no **message quota** only | `api-proxy.ts:292-313` (`paginate`; `:302` skips non-append events, `:311` returns `window.filter(event => event.seq >= cut)` — i.e. **all** raw events from the cut) |
| history page assembly | `api-proxy.ts:804-819` (`historyPage`), `:1563-1574` (`historyCutOf`) |
| wire schema keeps the markers | `packages/host/apiproxy/src/api/sessions.schema.ts:41-49` — `sourceEventSeqs: z.array(z.number()).optional()`, `surfaceOp: z.unknown().optional()`; frame schema `api/events.schema.ts:43-44`; frame type `api/events.ts:69-70` |
| client validates frames with that same schema | `packages/client/connection/src/client/web-api-client.ts:23` (`muxFrameSchema`) |

`api-proxy.ts:302` is a **quota** filter, not a page filter — a common misreading. Replacement events are
in `page.events`.

### 1.2 Client pump → conversation engine: every event is dispatched to every Definition

* `packages/client/runtime/src/client/sessions/session.ts:653-660` `installWindow` → `conversation.replaceWindow(entries.map(conversationInput), …)` (open / resync / gap repair)
* `session.ts:667-677` `appendLive` → `conversation.append({event, view})` (live tail)
* `session.ts:684-697` `acceptLiveEvent` (gap → buffer + tail-page repull)
* `packages/client/runtime/src/client/sessions/conversation-assembler.ts:337-340` `matchInput` and `:360-385` `dispatchInput` — `:371` calls `definition.match(input.event)` for **every registered Definition, for every event**, with no surface predicate.
* `packages/client/runtime/src/client/sessions/conversation-assembler.ts:168-187 / 194-215 / 223-248` = the three ingestion paths (replace / append / prepend).

### 1.3 Proof in shipped code

* `packages/client/ui-conversation/src/client/conversation-nodes/message.ts:24-28` — `isCompactionCheckpoint` reads `isReplacementSurfaceEvent(event)` and `event.data.source` off a `user/message`.
* `packages/client/ui-conversation/src/client/conversation-nodes/command.ts:79-95` — `compactSource()` does the same and extracts `compactionId` / `sourceCommandId`.
* `packages/client/ui-conversation/src/client/conversation-nodes/compaction.ts:31-56` — builds a **visible** Chat node from that replacement event.
* Guards are re-exported to client plugins: `packages/client/runtime/src/client/index.ts:19`.

### 1.4 The filter that *does* exist (transcript only)

`isAppendSurfaceEvent` gates the append-origin node Definitions:
`message.ts:34-35`, `assistant.ts:250`, `tool.ts:241`, `turn-tail.ts:39,130`, `fallback.ts:19`; replacement
`user/message` is also explicitly excluded from the manual-compaction path at `command.ts:83`.
Semantics: `packages/core/session/src/surface.ts:40-68`.

### 1.5 One real limitation

`session/event` frames for a session the client has **not instantiated** are dropped (no lazy build):
`packages/client/runtime/src/client/sessions/manager.ts:751-758` ("history backfills them on open").
So the *event* path only exists for the open/staged session. `session/projection` frames are the
exception — see §3.3.

---

## 2. What a `conversation.chat.node` occupant can read (and cannot)

### 2.1 `ConversationSnapshot` — no events, no seq map

`packages/client/runtime/src/client/sessions/conversation.ts:433-477`. Fields:
`sessionId`, `views`, `chat`, `nodes`, `turnTimings`, `turnEnds`, `partial`, `runningCalls`, `pending`,
`queue`, `running`, `subagent`, `composerPhase`, `removed`, `openState`, `openError`, `hasMore`,
`loadingOlder`, `promptError`, `blank`, `lastAgentError`.

`chat` — `conversation.ts:395-401`: `{ order: readonly string[]; nodes: ChatNodeStore; locations;
timeline; legacy }`.

* `order` = visible Chat-node **keys** sorted by `anchorSeq` then key: `chat-snapshot-builder.ts:135-139`, `:429-441`.
* `nodes` = keyed store of *materialized view nodes* (`ChatNodeStore`, `conversation.ts:367-372`).
* `timeline` = `{ turnOrder, turns: Map<number, TurnLocation> }` (`contract/conversation.ts:231-234`) — `TurnLocation` exposes only the `turn/start`/`turn/end` **events** and step boundaries, not the log.
* `legacy` = `LegacyConversationSlice` (`conversation.ts:386-392`): `nodes: readonly ConversationNode[]` (derived data), `turnTimings`, `turnEnds`, `partial`, `runningCalls` — **not raw events** (`chat-snapshot-builder.ts:332-340`).

There is **no `events` field, no `records`, no `seq → event` map** anywhere in the snapshot.

### 2.2 The raw window is unreachable

* `packages/client/runtime/src/client/sessions/session.ts:67` — `private events: SessionEvent[] = []`.
* `packages/client/runtime/src/client/contract/session.ts:30-82` — `ISession` exposes `sessionId`, `projections`, `prompt`, `readAttachment`, `updateQueue`, `cancel`, `rename`, `loadOlder`, `command`. Nothing else.
* `packages/client/runtime/src/client/contract/sessions.ts:1-9` (module doc): wire-pump entry points (`handleMuxEnvelope`/`handleConnected`/`refresh`) "stay on the concrete class"; `:123,129` `sessionOf`/`binding` hand out `SessionFace` only.
* `packages/client/runtime/src/client/index.ts:74-82` — the exported/public conversation types contain no event type.

### 2.3 The three public hooks, precisely

| seat | type | source |
|---|---|---|
| `useSession` | `SnapshotSelectorHook<ConversationSnapshot>` — `(sel, eq?) => S` | `client/index.ts:122,131`; `packages/client/ui-slots/src/store.ts:8` |
| `sessionId` | branded `SessionId` (framework-resolved; owners never pass it) | `client/index.ts:133` |
| `useProjection` | `<K extends keyof SessionProjectionMap>(key: K) => SessionProjectionMap[K] \| undefined`, plus a `(key, selector, eq?)` overload | `client/index.ts:135`; `projection-store.ts:33-40`; bound at `packages/client/web-react/src/session-provider.tsx:96-114`, injected at `scoped-slots.tsx:378` |

**`useChat` does not exist** (no match for `useChat` anywhere under `packages/`). Per-Node renderer props are
`ChatNodeViewProps<Kind> = PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'conversation'>`
(`packages/client/ui-conversation/src/client/contract/slots.ts:370-371`) = owner share (`ChatNodeOwnerProps`,
`:355-367`) + `{ node: ChatNode<Kind> }` keyProps (`:82`) + session standard kit (`useSession`,
`sessionId`, `useProjection`, `useInput`, `inputActions`) + inject face + `t`.

### 2.4 The one place raw events *are* public: a Definition callback

`ConversationNodeDefinition` (`packages/client/runtime/src/client/contract/conversation.ts:171-228`):

* `match(event: SessionEvent)` — `:180` — the raw event.
* `start(context, match, reader)` / `update(context, match)` — `ConversationMatch extends ConversationEventInput` = `{ event: SessionEvent; view?: ToolEventView; role; location }` — `:8-12, 99-102`.
* `context.matches: readonly ConversationMatch[]` — `:137` — i.e. each Definition privately owns every raw event it matched, indexed by `event.seq`.

Not reachable from a component: the assembler's internal `inputs: Map<seq, ConversationEventInput>` is
`private` (`conversation-assembler.ts:141`), and `snapshot(target)`/`get(target)` only return registered
**view** snapshots (`:323-331`).

Other non-slot escape hatches (plugin code, not slot hooks):
* `ctx.connection.api.sessions.history({ sessionId, beforeSeq?, maxMessages? })` →
  `{ events: HistoryEntry[]; hasMore; projections? }` — `packages/client/connection/src/client/index.ts:60-78`
  (`ConnectionHandle.api`), `packages/host/apiproxy/src/api/sessions.ts:282-283`. Raw events, replacements
  included; **one-shot, not reactive**.
* `ctx.sessions.binding(id)?.session.projections.faceOf(key)` — `contract/sessions.ts:129`,
  `contract/session.ts:26,34`; shipped example `packages/client/ui-goal/src/client/index.ts:60-65`.

---

## 3. Projections: the exact contract, and whether a third party can register one

### 3.1 `ProjectionDefinition` — there is **no `wire` field**

`packages/session/session-projection/src/index.ts:42-74`:

```ts
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  key: K                                                    // its SessionProjectionMap entry
  schema: ZodType<SessionProjectionMap[K]>                   // validates the wire payload (view output) before it leaves the host
  init(): S                                                  // state for the empty log
  apply(state: S, event: SessionEvent): S                    // pure; return the SAME reference when uninterested (zero downstream work)
  view(state: S): SessionProjectionMap[K]                    // state → wire payload (the read-side projection)
  stateVersion: number                                       // persisted-cache invalidation version (non-negative int)
}
```

The wire value is `view(state)` after `schema.parse`; there is no separate `wire` field. (The only `wire`
field in this neighbourhood is typert's `InvocationParameterDescriptor.wire`,
`packages/typert/protocol/src/types.ts:153` — unrelated.)

### 3.2 Registration signature

`SessionProjectionRegistry.register` — `session-projection/src/index.ts:194-222`:

```ts
register<K extends keyof SessionProjectionMap, S>(definition: ProjectionDefinition<K, S>): () => void
```

* Validates `stateVersion` (non-negative safe integer) → throws otherwise (`:195-197`).
* Registration is a Cordis **effect on the calling fiber** (`:198-221`) → disposing the fiber removes the key.
* Duplicate key: shared, ref-counted (`:200-212`); a differing `stateVersion` throws (`:208-210`).
* `onChanged(listener)` — `:230-238`; `snapshot(session)` — `:248-255`; the registry drives every committed host event at `:181-183`.
* The key table is empty and merge-extensible: `packages/session/session-projection/src/types.ts:17` (`export interface SessionProjectionMap {}`).
* Lazy cell build folds the **whole in-memory host log**: `:388-402` (`buildCell(def, session.events)` at `:398`); the host `Session.events` is the full log (`packages/core/session/src/index.ts:559`, and `surface` at `:431`).

### 3.3 Delivery to the browser (already wired, nothing for the plugin to do)

| leg | evidence |
|---|---|
| tail-page baseline: `registry.snapshot(session)` | `api-proxy.ts:841-845`, `:1563-1574`; wire shape `api/sessions.ts:79-84`, `sessions.schema.ts:212-216,237-242` |
| cold/resumed sessions: checkpoint + restore over the stored log | `api-proxy.ts:1567-1569` (`detachedProjectionsFor`) |
| push frame on every changed unit | `api-proxy.ts:1279-1287` (`onChanged` → `broadcast({ type: 'session/projection', sessionId, key, value, seq })`); frame doc `api/events.ts:99-107` |
| client lands it **even for uninstantiated sessions** | `packages/client/runtime/src/client/sessions/manager.ts:696-703` |
| client store: higher-seq-wins, seeded by the tail page | `packages/client/runtime/src/client/sessions/projection-store.ts:77-201` (`apply` `:134-139`, `seed` `:149-160`, `truncate` `:171-177`); seeding call `session.ts:660` |
| React seat: `useProjection(key)` | `web-react/src/session-provider.tsx:96-114` |

### 3.4 Can a third-party package register one? **Yes.**

The registry is an ordinary public Service Definition; domain packages register under an injected child so
headless assemblies are unaffected — e.g. `packages/todo/tool-todo/src/index.ts:135-136`,
`packages/plan/plan-mode/src/index.ts:244-245`, `packages/goal/goal/src/index.ts:204-205`,
`packages/llm/token-meter/src/index.ts:87-90`. Documented in
`packages/session/session-projection/README.md:11,28` and `docs/subsystems/session-projection.md:11,93,157`.

On the **client**, the key just has to be visible to the type program. Two options:
1. `useProjection('messageEdits')` — declare-merge the key into `SessionProjectionMap` (the domain's
   established pattern: `plan-mode` README:25, `ui-goal/src/client/index.ts:18-19` imports the domain's
   type-only outlet).
2. `ctx.sessions.binding(sessionId)?.session.projections.faceOf('messageEdits')` — **untyped**, no merge
   needed; exactly what `ui-goal/src/client/index.ts:60-65` does. A component would then drive it through
   React's own `useSyncExternalStore` (runtime-free: the plugin's inject face can hand the component a
   reader).

---

## 4. Recommended reactive mechanism

### 4.1 Evaluation of the four candidates

| option | reactive | sees edits outside the loaded window | needs host code | public API |
|---|---|---|---|---|
| (a) Host Remote read on mount | no (manual re-pull) | yes | **requires editing `dsh-api-remotes`** (hard-coded mount list, `packages/api/remotes/src/client/index.ts:105-122`); existing `ctx.connection.api.sessions.history` works but is a one-shot | yes |
| (b) **Host session projection** | **yes** (change feed → `session/projection` frame) | **yes** (folded over the whole host log, `session-projection/src/index.ts:388-402`) | 1 unit registration | yes |
| (c) follow stream | yes | **no** (only the loaded, instantiated window) | no | **no** — no client `session/event` subscription exists: `ISessions` has no frame sink (`contract/sessions.ts:1-9`), and the `ctx.remote.$on` allowlist has no session events (`packages/api/remotes/src/remote-events.ts:17-29`) |
| (c′) own `ConversationNodeDefinition` | yes (assembler ingestion) | no (window-bound) | no | yes (`ctx.conversationEvents.register`, `docs/cookbook/adding-a-conversation-node.md:185-193`) |
| (d) plugin `defineStore` + Remote read | no | yes | yes (Remote, see (a)) | store seat is per-entry × scope, framework-minted (`packages/client/runtime/src/client/slots.ts:423-436`) — the plugin cannot write into the framework instance from a Definition |

**Recommended: (b).** It is the only design where the client learns about an edit with *zero* client-side
event plumbing, *zero* dependence on pagination, and a read seat (`useProjection`) available to **any**
session-scope component. (c′) is the right fallback when you must not ship host code, and is the mechanism
the built-in compaction feature uses for exactly this shape of problem.

### 4.2 Key the map by the **original append-origin seq**

The built-in `UserMessageNode` exposes **no `messageId`** (`conversation.ts:76-83` — only `kind`, `seq`,
`time`, `content`, `source`), so the client's only usable key for the visible row is `node.data.seq`.
Two consequences for the Host unit:

* a replacement's `surfaceOp.start` is the seq of the node it replaces **as it exists now** — after edit #1
  that is edit #1's seq, not the original. Keep a chain map `originOf[newSeq] = originOf[start] ?? start`
  (or put your own explicit `editOf` field in the replacement payload and read that);
* `sourceEventSeqs` must list every shadowed surface node (`packages/core/session/src/surface.ts:210-243`).

### 4.3 Concrete sketch (public APIs only)

**Host half** (`src/index.ts`):

```ts
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

// The one projection type table (host unit + wire block + client hook share it).
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** original append-origin user/message seq -> current edited text. */
    messageEdits: Record<string, { seq: number; text: string }>
  }
}

interface EditState { edits: Record<string, { seq: number; text: string }>; originOf: Record<string, number> }

const messageEditsSchema = z.record(z.string(), z.object({ seq: z.number().int().nonnegative(), text: z.string() }))

const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap(b => b.type === 'text' ? [b.text] : []).join('')

export const inject = ['sessionProjections']

export function apply(ctx: Context): void {
  ctx.sessionProjections.register<'messageEdits', EditState>({
    key: 'messageEdits',
    schema: messageEditsSchema,
    init: () => ({ edits: {}, originOf: {} }),
    apply: (state, event: SessionEvent) => {
      // Only YOUR replacement user/message events (tag them in `source`, like compaction does).
      if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return state
      const source = event.data.source as { kind?: string; plugin?: string }
      if (source.kind !== 'plugin' || source.plugin !== 'message-editor') return state
      const start = event.surfaceOp.start
      const origin = state.originOf[String(start)] ?? start          // follow repeat-edit chains
      return {
        originOf: { ...state.originOf, [String(event.seq)]: origin },
        edits: { ...state.edits, [String(origin)]: { seq: event.seq, text: textOf(event.data.content) } },
      }
    },
    view: state => state.edits,
    stateVersion: 1,
  })
}
```

Notes: returning the *same* state reference for every unrelated event is load-bearing — the registry only
notifies when `!Object.is(next, cell.state)` (`session-projection/src/index.ts:414-423`). Registering under
`ctx.inject(['sessionProjections'], …)` keeps headless compositions working (README:28).

**Client half** (`src/client/index.ts`), rendering in place by shadowing the built-in `user` cell:

```ts
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'   // SlotMap + ChatNodeViewProps merge
import type {} from '@deepseek-ai/dsh-session-projection/types'        // the messageEdits key merge
import { EditedUserMessageView } from './EditedUserMessageView.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { messageEditor: MessageEditorKey } }

export const inject = ['slots', 'sessions', 'locale', 'conversationEvents']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'message-editor: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',            // shadow the shipped 'user' renderer for that cell
    priority: -1,           // lowest priority wins the cell (SlotCore.entriesOfSlot)
    locale: NS,
  }, EditedUserMessageView))
}
```

```tsx
function EditedUserMessageView({ node, useProjection, loadImage }: ChatNodeViewProps<'user'>) {
  const edits = useProjection('messageEdits')          // Record<string, {seq,text}> | undefined
  const edit = edits?.[String(node.data.seq)]          // UserMessageNode.seq = append-origin event seq
  const content = edit === undefined
    ? node.data.content
    : node.data.content.map(b => b.type === 'text' ? { ...b, text: edit.text } : b)
  return <UserBubble content={content} edited={edit !== undefined} />
}
```

Cell-shadowing mechanics: same `key` at the **same** priority throws; a different priority shadows and the
lowest renders (`packages/client/ui-slots/src/index.ts:799-812` register, `:936-952` `entriesOfSlot`).
Dispatch passes `entryKey: node.kind` and `hookContext: nodeKey`
(`packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx:23,48-50`).

**Fallback without a host projection** (option c′): register a `ConversationNodeDefinition` whose
`match(event)` tests `isReplacementSurfaceEvent(event)` and returns `{ id: String(event.surfaceOp.start), role: 'start' }`,
keeping `event.data.content` in State and publishing it through `buildViewNode` (`chatNode(...)`,
`packages/client/ui-conversation/src/client/conversation-nodes/common.ts:39-59`) under its own
`conversation.chat.node` key. This mirrors `compactionDefinition` (`compaction.ts:31-56`) exactly. Its data
is reachable only by that node's own renderer — a Definition's State is not exported to other components.

---

## 5. Client plugin entry-point contract (exact)

```ts
// package.json
//   "exports": { ".": …, "./client": … },  "dsh": { "client": { "platform": "web", "inject": [...] } }
// — packages/client/runtime/package.json:16-42; packages/client/AGENTS.md:94-96
export const inject = ['slots', 'sessions', 'locale', 'conversationEvents', 'remote']  // required services
export function apply(ctx: ClientContext): void                                        // the entry point
```

* `ClientContext = Context` (cordis) — `packages/client/runtime/src/client/index.ts:112`; the runtime's own
  `apply(ctx: Context): void` is `:188`, its `inject` list `:183`. Client `Context` merges (all public):
  `slots` (`:170`), `conversationEvents`, `conversationViews`, `sessions`, `workspaces` (`:171-179`),
  plus `connection` (`packages/client/connection/src/client/index.ts:60-78,143`), `locale`
  (`packages/client/locale/src/client/index.ts:72-75,360`), `remote`
  (`packages/api/remotes/src/client/index.ts:90-95`), `settingsScope` (ui-settings).
* **`ctx.store` does not exist.** The store seat is a *registration option*:
  `defineStore({init, persist?, actions})` (`packages/client/runtime/src/client/contract/store.ts:207-240`)
  returns a handle; pass it (or a `() => handle` factory) as `store:`. Components receive
  `useStore` + `actions` (`packages/client/ui-slots/src/store.ts:123-125`); an `inject` factory additionally
  receives `(sessionId, actions)` for session scope (`packages/client/ui-slots/src/index.ts:460-467`).
* `ctx.effect(execute, label?)` — cordis fiber effect; the body returns a disposer (or an iterable /
  promise of them), torn down with the fiber
  (`packages/client/runtime/node_modules/@deepseek-ai/cordis/lib/types/fiber.d.ts:144-159`).
* `ctx.on(name, listener, options?)` — cordis listener, auto-removed with the fiber
  (`…/cordis/lib/types/events.d.ts:80-97`). Client-emitted events are only
  `slots/changed` and `connection/reset` (`packages/client/runtime/src/client/index.ts:153-168`).
* `ctx.remote` = `TypertClientRemote` (`packages/typert/protocol/src/types.ts:222-250`): `$mount`,
  `$on(event, listener)`, `$dispatch`, plus the mounted namespaces (`ctx.remote.goals.edit(...)` etc.).
  The `$on` key set is the allowlist `API_REMOTE_FORWARDED_EVENTS`
  (`packages/api/remotes/src/remote-events.ts:17-29`) — **no session events**.
* `ctx.locale` = `LocaleRuntime` (`packages/client/locale/src/client/index.ts:114-313`):
  `register(ns, dicts)` / `register(ns, locale, dict)`, `bind(ns)`, `getLocale()`, `getSnapshot()`,
  `subscribe(fn)`.

### `ctx.slots.register(options, component): () => void`

`SlotRegistry.register` reuses `SlotCore['register']` verbatim and wraps it in the caller's `ctx.effect`
(`packages/client/runtime/src/client/slots.ts:109-126`, `:464-471`). Options
(`packages/client/ui-slots/src/index.ts:527-550` + kind shape `:480-509`):

| option | meaning |
|---|---|
| `name: K` | target slot key (must be declared by a parent entry's `children`, else throw — `:788-791`) |
| `children?: D` | child-slot declaration + render authorization; declaring is claiming (one declarer per key — `:825-832`) |
| `store?: StoreDecl` | shared handle, or an exclusive `() => StoreHandle` factory (`:356-383`) |
| `inject?: (...args: InjectParams<K,H>) => I` | registrant business face; args are `[sessionId]` / `[sessionId \| undefined]` / `[]`, plus `actions` when a store is declared (`:460-467`) |
| `locale?: N` | dictionary namespace; synthesizes the typed `t` prop (`:541-547`) |
| `registrant?: string` | diagnostics label (the Service wrapper stamps the fiber name) |
| `key` / `priority` | **keyed** slots: cell key + shadowing rank (ascending; lowest renders; same key + same priority throws) |
| `id` / `order` / `label` / `priority` | **list** slots: cell id, display order, label (string or thunk), shadowing rank |
| `select` / `priority` | **chain** slots: mandatory routing selector + election order |

`ctx.slots.inject(key, callback): () => void` — runs `callback` for each declaration lifetime of `key`
(immediately if already declared) and owns the result in the caller's fiber
(`slots.ts:143-205`).

The `conversation.chat.node` slot itself is `{ kind: 'keyed', scope: 'session', owner: ChatNodeOwnerProps,
keyProps: { [K in ChatNodeKind]: { node: ChatNode<K> } }, hookContext: string, inject: ChatNodeTurnDataInjected }`
declared by the chat-view entry (`packages/client/ui-conversation/src/client/apply.ts:376-385`,
`contract/slots.ts:78-85`).

---

## 6. Blockers and workarounds

1. **You cannot add a Host Remote namespace from a third-party package.** The client assembly mounts a
   fixed array (`packages/api/remotes/src/client/index.ts:105-122`), and the README states the capability
   set is fixed by explicit build-time value imports (`packages/api/remotes/README.md:39-40`).
   *Workaround A:* use the existing `ctx.connection.api.sessions.history(...)` (public; raw events).
   *Workaround B:* the projection route (recommended) needs no Remote at all.
   *Workaround C:* in a dynamic dual-half package, `harness.handle(method, handler)` gives the host half a
   package-private Client RPC (`packages/extensions/cordis-host-runner/src/sandbox.ts:29-37`), called from
   the browser half as `host.call(...)`.
2. **A static client plugin must be composed into the web bundle**: three registration surfaces
   (`tsconfig.client.json`, `packages/bundle/web-app/cordis.patch.yml`, `packages/bundle/web-app/package.json`)
   — `packages/client/AGENTS.md:94-96`; the Node half scans `dsh.client` packages and hashes the built
   `exports["./client"]` into the boot graph (`packages/client/modules/README.md:11`). A drop-in
   third-party client bundle is *not* a supported path by itself.
   *Workaround:* the **dynamic Cordis package route** — `cordis_define` + run
   (`packages/extensions/cordis-client-runner/README.md`). Its client half is evaluated as an async
   function body (no JSX/TS/imports; `React` arrives as a closure symbol) and receives a whitelisting ctx
   facade that: exposes `effect/on/once/provide` + timer verbs (`…/client/guard.ts:22-25`), forwards any
   service the returned plugin declares in `inject` (`:204-211`), and gives the `slots` seat a register
   proxy that **assigns its own shadowing priority** (later registrations win) and ledgers the entry
   (`:96-137`). The host half reaches services through `inject` / `ctx.get(name)`
   (`packages/extensions/cordis-host-runner/src/guard.ts:636,718-741`), so
   `inject: ['sessionProjections']` + `ctx.sessionProjections.register(...)` is available there too.
3. **`useProjection` is key-typed.** An undeclared key is a compile error even though the runtime accepts
   any string. Merge the key (option 1 in §3.4) or use the untyped `faceOf` route (`ui-goal` precedent,
   §2.4).
4. **A Definition's State is not readable outside its own node.** If you take route (c′), the edit text can
   only reach a renderer through that Definition's own `buildViewNode` payload — not as a prop to the
   shipped `user` renderer.
5. **Window-bound detection (route c′ only).** A plugin `apply()` cannot subscribe to frames, and the
   assembler only sees the loaded window; an edit older than the last `maxMessages` (50,
   `packages/client/runtime/src/client/sessions/session.ts:32`) message groups is invisible until
   `loadOlder` fetches it. The projection route has no such gap.

---

## 7. One-line answers

* **Does the client see replacement events?** Yes — live (`api-proxy.ts:3475-3493`) and in history pages
  (`api-proxy.ts:311,812-819`), schema-intact (`sessions.schema.ts:41-49`), dispatched to every
  `ConversationNodeDefinition` (`conversation-assembler.ts:360-385`), and consumed by shipped code
  (`message.ts:24-28`, `command.ts:79-95`, `compaction.ts:31-56`). Only the transcript node builders filter
  to `isAppendSurfaceEvent`.
* **Can a component read a raw event by seq?** No; only a Definition callback can (`contract/conversation.ts:180`).
* **Best reactive mechanism?** Host `ctx.sessionProjections.register(...)` unit + client `useProjection('messageEdits')`.
