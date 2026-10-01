# Editing a prior message so SUBSEQUENT model calls see the edit

Read-only investigation of `E:\1AIDEEPSEEKHARNESS` (DSH, Cordis-based).
All paths below are relative to that monorepo root.

## 0. Verdict in one paragraph

There is **no request-time seam that can substitute the message history**. `agent/request`
carries only `LlmCallConfig` (provider/model/sampling — *no messages*) and is documented as
unable to mutate messages. `agent/pre-step` sees only the newly claimed inbox batch, not
history. `llm/stream` does receive the full `GenerateOptions` **including `messages`**, but
loop-built requests are deep-frozen, marked, and contractually read-only; `next()` cannot take
a replacement (`vendor/cordis/src/events.ts:234-243`) and the innermost continuation closes over
the original `options`. The **supported seam is durable and append-only**: append a *surface
replacement* event (`surfaceOp: { op: 'replace', start, end }` + `sourceEventSeqs`) for the
target `user/message` / `assistant/message` / `tool/result` node. `Session.deriveMessages()` is
re-folded from the log on **every step** (`packages/core/agent-loop/src/agent.ts:340-342`), so
one append changes what the model sees in every later turn — no regeneration, no log rewrite.
This is the same mechanism compaction already ships.

---

## 1. `agent/request` — cannot carry messages

`packages/core/agent/src/runtime-types.ts:244`

```ts
'agent/request'(this: Scoped<Agent>, payload: { agent: Agent; turn: number; step: number; signal: AbortSignal }, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig>
```

`LlmCallConfig` — `packages/llm/llm/src/call-config.ts:23-30`:

```ts
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
```

**No messages field.** The doc comment at `packages/core/agent/src/runtime-types.ts:236` states it
explicitly: *"Model-visible content must use logged channels; this waterfall cannot mutate messages."*
Reinforced by `.agents/notes/implemented/simplification/2026-07-24-agent-loop-observable-state-machine.md:46`
("There is no request-only message prefix, assistant-message transform…") and the
reconstructable-requests note's rejection of "per-call request scalars"
(`.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md:41`).

Replacement mechanics of this waterfall: the listener **returns** a replacement config
(`return { ...await next(), temperature: 0.5 }`); `next()` itself takes no arguments. The seed is
deep-frozen (`agent.ts:428-437`), so in-place shaping throws
(`packages/core/agent-loop/tests/request-reconstruction.spec.ts:542-552`).

## 2. `agent/pre-step` — claimed inbox batch only

`packages/core/agent/src/runtime-types.ts:53-55, 220-231`

```ts
export type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[] }

'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

Coverage — `payload.messages` is documented as *"messages removed from the inbox for this step"*
(`runtime-types.ts:224`) and built at `packages/core/agent-loop/src/agent.ts:229`
(`const claimed = this.inbox.claim(target, position.turn)`), passed into the waterfall at
`agent.ts:234-240` with default `next()` = `{ kind: 'enter', messages: context === undefined ? claimed : [...claimed, context] }`.

* Yes it can **replace, reorder, drop and inject** — the returned `messages` array *is* the batch that
  becomes this step's `user/message` events (`agent.ts:282-284`). Proven by
  `packages/core/agent-loop/tests/interception.spec.ts:159-178` (rewrite) and `:180-205` (inject).
* It covers **only the newly arriving batch**, never history: `interception.spec.ts:103-106` shows a
  tool-continuation step arriving with `messages: 0`.
* It **cannot touch assistant messages already in history**, and it cannot inject anything that
  outlives the step.
* Ordering note: the batch is claimed *before* the waterfall and logged *after* it, so a batch
  swapped out here never appears as a `user/message` event.

## 3. How the request message list is assembled

`packages/core/agent-loop/src/agent.ts:332-345`

```ts
private async step(assembly: PromptAssembly): Promise<StepEndReason | null> {
  ...
  const { request, preparedCall } = await this.buildRequest(
    turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
  )
```

`packages/core/agent-loop/src/agent.ts:486-494`

```ts
const request = markAgentLoopRequest(deepFreeze({
  ...header.config,
  messages: boundaryMessages,
  ...header.system !== undefined ? { system: header.system } : {},
  ...header.tools !== undefined ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal,
}))
return { request, ...preparedCall === undefined ? {} : { preparedCall } }
```

* **Read from the durable log, every step**: `Session.deriveMessages()`
  (`packages/core/session/src/index.ts:726-747`) folds the current *surface* of the append-only
  event log. Cached per surface generation; a replacement bumps `replaceGeneration` and forces a
  rebuild (`index.ts:730-734`, `packages/core/session/src/surface.ts:431-441`).
* **Not exposed to plugins at all.** There is no waterfall over history assembly. The only
  plugin-visible inputs are the logger channels (`agent/pre-step` for the current batch,
  `agent.inject()/steer()` for later batches) and *log edits* like the surface replacement below.
* `deepFreeze` (`packages/llm/llm/src/call-config.ts:88-117`) + `markAgentLoopRequest`
  (`call-config.ts:66-69`) make the built request immutable and identifiable.
* Enforcement: `packages/core/agent-loop/src/invariant.ts:21-42` re-derives the log in a fresh
  `Session` at `llm/stream` and **fails** if `JSON.stringify(options.messages)` differs from
  `session.deriveMessages()` ("log-reconstruction desync"). Because a replacement is *in* the log,
  a replacement-based edit passes this check.

## 4. `llm/stream` — has `messages`, but is read-only

Signature: `packages/llm/llm/src/index.ts:64`

```ts
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

`GenerateOptions` — `packages/llm/llm/src/types.ts:320-356`:

| field | line | note |
|---|---|---|
| `provider: string` | 322 | selects the adapter registration |
| `model: string` | 323 | |
| `reasoningEffort?: ReasoningEffortId` | 325 | |
| **`messages: Message[]`** | **331** | "Ordered conversation messages, exactly as the provider sees them (after the `system` slot). A loop-built request assembles them as the derived history (dsh-agent-loop)" |
| `system?: string` | 333 | |
| `tools?: ToolSchema[]` | 335 | |
| `temperature?: number` | 336 | |
| `maxTokens?: number` | 337 | |
| `stop?: string[]` | 343 | |
| `signal?: AbortSignal` | 344 | |
| `sessionId?: Branded<'SessionId'>` | 349 | |
| `purpose?: 'compaction' \| 'session-title'` | 355 | |

**Can a listener replace `options`? No — three independent reasons:**

1. `next` is declared `() => AsyncIterable<StreamChunk>` (no parameters), and Cordis' waterfall
   forwards the **same positional `args` array** to each callback:
   `vendor/cordis/src/events.ts:234-243`
   ```ts
   waterfall(...args: any[]) {
     const cbs = this.dispatch('waterfall', args)
     const inner = args.pop()
     const next = () => { const cb = cbs.shift() ?? inner; return cb(...args) }
     args.push(next)
     return next()
   }
   ```
   Even if you passed an argument to `next(x)`, `next` ignores it; and the innermost continuation
   is `() => this.adapterStream(options, prepared)` — closing over the **original** `options`
   (`packages/llm/llm/src/index.ts:921-926`).
2. Loop-built requests are deep-frozen, so in-place mutation throws:
   `packages/llm/llm/src/index.ts:56-61` — *"its content is a pure function of the session log
   (the reconstructability Agent Note), so listeners read it, never rewrite it"*; proven by
   `packages/core/agent-loop/tests/request-reconstruction.spec.ts:485-507`.
3. The agent-loop invariant would flag a divergence for a marked request
   (`packages/core/agent-loop/src/invariant.ts:21-42`).

What a listener *can* do: call `next()` and wrap the returned iterator (rewrite **output** chunks,
cache, log), or return its own `AsyncIterable` without calling `next()` (short-circuit).

> Not-recommended loophole, for completeness: the listener could re-enter
> `ctx.llm.stream({ ...options, messages: edited })` behind its own re-entrancy flag. The nested
> object is a *new* object, so `isAgentLoopRequest()` is false and the reconstruction invariant
> skips it (`invariant.ts:22`) — the check would be silently defeated, and a third party replaying
> the log would reconstruct different messages than the provider saw. This breaks the documented
> contract and the reconstructability axiom; do not build on it.

## 5. Documented alternative that actually exists: surface replacement

`packages/core/session/src/types.ts:359-374`

```ts
export type SurfaceOp = 'append' | { op: 'replace'; start: number; end: number }
```

> "`{ op: 'replace', start, end }`: replaces surface nodes from `start` (inclusive) through `end`
> (inclusive) with this node. Both must exist as surface nodes in the current surface.
> `start === end` replaces a single node. The node's `sourceEventSeqs` must include every shadowed
> surface node. **Used by compaction; any surface-replacing producer may use it.**" (`types.ts:365-370`)

`SurfaceIntent` (third arg of `Session.append`) — `types.ts:376-389`.

Validation at append (`packages/core/session/src/surface.ts`):
* `assertProvenance` `:210-243` — `sourceEventSeqs` must list **every** shadowed node, must be
  unique, and must all be **earlier** seqs.
* `replacementRange` `:245-266` — `start`/`end` must be *current surface* nodes; otherwise
  *"surface replace: start seq X not found in surface"*.
* `assertToolResultRewrite` `:286-318` — a `tool/result` replacement may change **only** the nested
  `content`; `toolCallId`, `isError`, and every other field must be deep-equal.

Canonical in-tree examples:
* summary compaction: `packages/compaction/compaction-basic/src/region.ts:462-465`
* single-node tool-result content rewrite: `packages/compaction/compaction-tool-result-pruner/src/index.ts:146-183`
* proof that a plugin-side replacement with the agent **idle** rewrites the next request:
  `packages/core/agent-loop/tests/request-reconstruction.spec.ts:406-431`
  ("a compaction replace rewrites the resend, and the log explains it") — no new `request/header`,
  the replacement is itself the explanation.

Session-invariant constraints on *who may append what, when*
(`packages/core/session/src/invariant.ts:114-146`) — these are the hard timing rules:

| replacement type | when it may be appended | evidence |
|---|---|---|
| `user/message` | **any time** (unconstrained; idle, between turns, inside pre-step, inside a step) | `invariant.ts:145-146` `case 'user/message': break` |
| `assistant/message` | **only while a step is open**, and `data.{turn,step}` must name that open step | `invariant.ts:118-121` → `requireOpenStep` (`:42-52`) |
| `tool/result` | only while a **turn** is open (step not required) | `invariant.ts:127-135` |

These companions only run when `@deepseek-ai/dsh-invariants` is composed, but `InvariantFailure`
throws (`packages/runtime-diagnostics/invariants/src/index.ts:29, 49-66`), so violating them
fails loudly in the dev/test lanes and in any deployment that mounts the service.

Additional import-path validation (persistence/session-query): `assertMessageEventShape`
(`packages/core/session/src/index.ts:301-352`) requires a replacement `assistant/message` to keep
`source.kind === 'model'` with non-empty `provider` **and** `model`, and a replacement `tool/result`
to keep `source.callId === content[0].toolCallId`.

---

## 6. Copy-pasteable minimal Cordis plugin

```ts
/**
 * dsh-message-editor — rewrite a prior message's text for SUBSEQUENT model calls.
 * Append-only: adds a surface `replace` node; the durable log is never rewritten.
 */
import type { Context } from '@deepseek-ai/cordis'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage, ContentBlock, Message, MessageId, ToolResultMessage, UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SurfaceEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage, isSurfaceEvent } from '@deepseek-ai/dsh-session'

export const name = 'message-editor'
/** Host-only: the registry resolves a live agent (and thus its session) from an id. */
export const inject = ['agents']

/** Apply a text edit to text blocks only. */
function rewriteBlocks(blocks: readonly ContentBlock[], edit: (text: string) => string): ContentBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: edit(block.text) }
      case 'tool-result': // nested result content is free to change...
        return { ...block, content: rewriteBlocks(block.content, edit) }
      // ...but `tool-call` is passed through VERBATIM: {id,name,arguments} correlate the
      // paired tool/result. `reasoning`, `image`, and plugin-merged blocks also pass through.
      default:
        return block
    }
  })
}

/** New frozen value, SAME MessageId (representation change, not a new semantic message). */
function edited(message: Message, edit: (text: string) => string): Message {
  return freezeMessage({ ...message, content: rewriteBlocks(message.content, edit) })
}

/** The CURRENT surface node carrying a message id (seq changes after every replacement). */
function currentNode(session: Session, id: MessageId): { seq: number; event: SurfaceEvent } | undefined {
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    if (event === undefined || !isSurfaceEvent(event)) continue
    if (deriveEventMessage(event)?.id === id) return { seq, event }
  }
  return undefined
}

/** user/message: legal at ANY time, so an idle-agent edit lands in the very next request. */
export function editUserMessage(session: Session, id: MessageId, edit: (text: string) => string): SessionEvent {
  const node = currentNode(session, id)
  if (node === undefined) throw new Error(`message ${id} is not on the session surface`)
  if (node.event.type !== 'user/message') throw new Error(`message ${id} is not a user/message`)
  return session.append('user/message', edited(node.event.data, edit) as UserMessage, {
    surfaceOp: { op: 'replace', start: node.seq, end: node.seq },
    sourceEventSeqs: [node.seq], // MUST cite every shadowed surface node
  })
}

/**
 * assistant/message: requires an OPEN step and must name it, so `at` is the turn/step of the
 * hook that is running (session invariant: requireOpenStep).
 */
export function editAssistantMessage(
  session: Session, id: MessageId, edit: (text: string) => string, at: { turn: number; step: number },
): SessionEvent {
  const node = currentNode(session, id)
  if (node === undefined) throw new Error(`message ${id} is not on the session surface`)
  if (node.event.type !== 'assistant/message') throw new Error(`message ${id} is not an assistant/message`)
  // `source` (provider/model/replayState) is carried over untouched — assertMessageEventShape
  // requires kind:'model' with provider+model, and replayState is model-visible replay input.
  const message = edited(node.event.data.message, edit) as AssistantMessage
  return session.append('assistant/message', { turn: at.turn, step: at.step, message }, {
    surfaceOp: { op: 'replace', start: node.seq, end: node.seq },
    sourceEventSeqs: [node.seq],
  })
}

/** tool/result: only the nested content may change (session-enforced); keep the callId pair. */
export function editToolResult(session: Session, id: MessageId, edit: (text: string) => string): SessionEvent {
  const node = currentNode(session, id)
  if (node === undefined) throw new Error(`message ${id} is not on the session surface`)
  if (node.event.type !== 'tool/result') throw new Error(`message ${id} is not a tool/result`)
  const original = node.event.data.message
  const message = freezeMessage<ToolResultMessage>({
    ...original,
    content: [{ ...original.content[0], content: rewriteBlocks(original.content[0].content, edit) }],
  })
  return session.append('tool/result', { ...node.event.data, message }, {
    surfaceOp: { op: 'replace', start: node.seq, end: node.seq },
    sourceEventSeqs: [node.seq],
  })
}

export function apply(ctx: Context): void {
  /** Assistant edits staged while no step is open; flushed at the next `agent/request`. */
  const pending = new Map<string, Array<{ id: MessageId; edit: (t: string) => string }>>()

  // Your UI/command/RPC entry points call these two; both are safe from any phase.
  ctx.set?.('queueAssistantEdit', (sessionId: string, id: MessageId, edit: (t: string) => string) => {
    const list = pending.get(sessionId) ?? []
    list.push({ id, edit })
    pending.set(sessionId, list)
  })

  // The first hook inside an open step: `step/start` at agent.ts:279 precedes it, and the
  // request is dispatched from here, so turn/step are exactly the open ones.
  ctx.on('agent/request', ({ agent, turn, step }, next) => {
    const queued = pending.get(agent.id)
    if (queued !== undefined) {
      pending.delete(agent.id)
      for (const item of queued) editAssistantMessage(agent.session, item.id, item.edit, { turn, step })
    }
    return next()
  })
}
```

### How messages are identified

* **`Message.id` (`MessageId`)** is the stable identity: it is minted at creation and survives
  admission, inbox claim, `agent/pre-step` rewriting, durable append, and request projection
  (`.agents/notes/implemented/architecture/2026-07-28-identified-immutable-message-values.md:15,25`).
  Use it as the edit key.
* **`seq`** is the *surface node* coordinate, not a message identity, and it **changes** every time
  the message is replaced. Resolve it freshly via `session.surface.nodes` → `session.events[seq]` →
  `deriveEventMessage(event)?.id`. Caching the original `seq` makes the second edit throw
  *"surface replace: start seq N not found in surface"* (`surface.ts:250-253`).
* `message.role` + `message.source.kind` distinguish a human prompt (`user`), injected context
  (`plugin`), tool result (`tool`), and model output (`model`).

### Exact block shape to produce

`ContentBlock` (`packages/llm/llm/src/types.ts:99-110`) is the merge-extensible union of
`{ type: 'text'; text: string }` (`:54-57`), `{ type: 'reasoning'; text: string }` (`:60-63`),
`{ type: 'image'; attachment: ImageAttachmentRef }` (`:71-75`),
`{ type: 'tool-call'; id: CallId; name: string; arguments: string }` (`:78-85`), and
`{ type: 'tool-result'; toolCallId: CallId; content: ContentBlock[]; isError?: boolean }` (`:88-93`).
A text edit is simply `{ type: 'text', text: newText }`.

`Message` (`packages/llm/llm/src/message.ts:129-138`): `{ id, role: 'system'|'user'|'assistant', content: ContentBlock[], source: MessageSource }`.
For an edited assistant message, keep `source: { kind: 'model', provider, model, replayState? }`
(`message.ts:21-24`, `:8-19`). `deepFreeze`/`snapshotJsonValue` mean everything you append must be
plain lossless JSON.

---

## 7. LIMITS — what cannot be done

1. **History assembly is not interceptable.** There is no waterfall or service over
   `Session.deriveMessages()`/`buildRequest`. A plugin cannot produce a *transient, per-step*
   message list. The closest achievable behaviour is a **durable log edit** (surface replacement):
   it is permanent until superseded by a later replacement or shadowed by compaction.
2. **`agent/request` cannot carry messages** (`call-config.ts:23-30`, `runtime-types.ts:236`).
3. **`llm/stream` cannot substitute `options`** (no-arg `next`, frozen marked request,
   invariant) — see §4. The only in-contract listener behaviour is wrapping/short-circuiting the
   **response** stream.
4. **`agent/pre-step` is not a history channel.** It only replaces/injects the *claimed batch* of
   the step it is proposing; assistant messages already in history are untouched.
5. **An assistant-message edit cannot be applied while the agent is idle.** The session invariant
   requires an open step naming the replacement's `turn`/`step` (`invariant.ts:118-121`). Stage such
   edits and flush them from `agent/request` (or another step-scoped hook).
6. **The edit is invisible in the human transcript — by design.** Replacement copies "stay
   model-only": the Web history page and the conversation nodes admit only *append-origin* surface
   events (`packages/host/apiproxy/src/api-proxy.ts:302`;
   `packages/core/session/src/surface.ts:40-55`; `packages/client/ui-conversation/src/client/conversation-nodes/message.ts:35`).
   A UI that must *show* the edited text needs its own log-only "edit" event or must read the
   model-visible surface. This is exactly what keeps "the user already saw this" history stable.
7. **Ephemerality is not available.** Once appended, the replacement is durable, replayable, and
   inherited by forks. Undoing an edit requires appending another replacement that restores the
   original content (the shadowed original is still in the log, so this is cheap and lossless).
8. **Nothing here regenerates the conversation.** No model call is made by the edit itself; the
   edit is pure log mutation and takes effect on the next request the loop builds.

### Per-step or one-shot?

**Per-step and persistent, applied automatically.** `deriveMessages()` is re-folded from the log at
the top of *every* `step()` (`agent.ts:340-342`) and on every retry iteration of the
`agent/request-error` loop. A replacement appended once is therefore seen by every subsequent
request — no per-turn re-application, no plugin bookkeeping. (Corollary: a naive per-step listener
that appended the same replacement every turn would be wrong — it would grow the log without
changing the derivation. Append once, when the user makes the edit.)

### Ordering caveat when applying from `agent/request`

`this.session.deriveMessages()` is an *argument* to `buildRequest` (`agent.ts:340-342`), so it is
evaluated **before** the `agent/request` waterfall runs inside `buildRequest` (`agent.ts:438`).
A replacement appended during step N's `agent/request` is therefore first visible in the request of
**step N+1** (same turn for a tool loop, otherwise the next turn) — never in the request being built.
An edit applied from `agent/pre-step` (user messages only) *is* visible in the immediately following
request.

---

## 8. Risks

### Tool-call / tool-result pairing (the one hard hazard)

* Dropping or rewriting an `assistant/message`'s `tool-call` blocks orphans the following
  `tool/result` nodes → provider 400 ("tool result without a preceding tool call"). There is **no
  runtime guard on derivation**; the session invariant only checks pairing for tool-result
  *appends* inside a step (`packages/core/session/src/invariant.ts:127-144`).
* `tool/result` replacements are structurally protected: only the nested `content` may differ, and
  `toolCallId` must stay (`surface.ts:286-318`); persistence additionally re-checks
  `source.callId === content[0].toolCallId` (`index.ts:336-351`).
* Available to check before cutting: `toolPairingBalancedBefore/After`
  (`packages/compaction/compaction/src/tool-pairing.ts:117,129`) — the fold treats an
  in-progress tool-call count going negative as corrupt (`:64-66`).
* **Safe to rewrite:** any `text` block in a `user/message`; `text`/`reasoning` blocks of an
  `assistant/message` (preserving its tool-call blocks and their argument strings verbatim); the
  nested `content` of a `tool-result` block. **Unsafe:** deleting an assistant message that owns
  tool calls, altering `tool-call.id/name/arguments`, altering `toolCallId`/`isError`, or
  dropping the `source` of an assistant message.

### Provider prompt cache

Any change to an earlier surface position invalidates the provider's cached prefix from that point
on; the next request shows a cache-read drop. The reconstructability note makes this explicit —
prefix stability is emergent from *append-only* extension, and a real change is a full-price event
(`.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.md:19, 31, 51`).
Editing near the tail is cheap; editing turn 1 makes the whole conversation full price on the next
call. Compaction batches its replacements for the same reason
(`packages/compaction/compaction-basic/README.md`).

### Token-meter drift (soft failure)

The token-meter surface fold is O(1) and expects a shadow-price event immediately before a
replacement (`packages/llm/token-meter/src/surface-projection.ts:48-93`). A replacement with no
adjacent claim folds with **zero delta** (`:86`) rather than throwing, so the session's surface
token total keeps counting the shadowed node. Only an adjacent claim for a *different* range
throws (`:87-92`). If accurate metering matters, append the shared shadow-price event
(`compaction/prune`, priced with `ctx.tokenMeter.estimateMessage`) immediately before the
replacement — the pattern is `packages/compaction/compaction-tool-result-pruner/src/index.ts:159-173`.
Otherwise accept documented drift.

### Replay-state loss

Rewriting an assistant message without carrying `source.replayState` (`message.ts:13-19`) drops the
adapter-private replay input for that message. `LlmRuntime.forAdapter` also strips it when a
different adapter owns the historical provider (`packages/llm/llm/src/index.ts:822-836`). Preserve
`source` when editing.

### Non-risks (verified)

* No desync with the agent-loop invariant: replacements are in the log, so
  `deriveMessages()` at dispatch still matches (`invariant.ts:39-42`).
* No transcript corruption: replacement nodes are excluded from the history page
  (`api-proxy.ts:302`) and from `isAppendSurfaceEvent`-gated conversation nodes.
* Third-party replacement `user/message` events are *not* mistaken for compaction checkpoints —
  that node matches only `source.plugin === COMPACT_PLUGIN`
  (`packages/client/ui-conversation/src/client/conversation-nodes/command.ts:83-95`).
* Resume/fork: replacements are ordinary surface events, validated and replayed by
  `foldSurface`/`SurfaceManager` (`surface.ts:387-459`), so a resumed or forked session derives the
  same edited history.
