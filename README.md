# dsh-message-editor

English | [中文](README.zh.md)

Edit any past message in a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) conversation — the model's output *and* your own input, text *and* attachments. **Cold edit by default: nothing is regenerated.** The transcript shows the corrected text, and later model calls read the corrected text.

<p align="center">
  <img src="icon.svg" width="72" alt="">
</p>

## What it does

- **Your own messages are editable in place.** A user message carries a pencil in its bubble row; the body becomes an inline editor — a bordered card on the layer-1 surface, a capsule Save / Cancel pair, `Enter` to save, `Shift+Enter` for a newline, `Escape` to cancel. Nothing is regenerated, so nothing restarts, streams, or costs tokens.
- **A model reply can be regenerated.** Model replies carry a round-arrow button in the host's own action strip, next to copy / branch / rating — the same 28px ghost button on `--dsw-alias-*` tokens. Clicking it has the model answer that turn again, with the old answer removed from both the transcript and the context.

  > **A model reply cannot be *rewritten*.** That is the session format's rule, not this plugin's choice: every surface replacement must cite the nodes it shadows in `sourceEventSeqs`, and `assistant/message` explicitly refuses to carry that field because it embeds its own source stream. The two rules together leave no legal spelling, so **rewriting a model message cannot take effect on this format**. An earlier build tried: the save looked successful, was marked "applies next step", and then failed to flush forever while the model kept seeing the original text. The call now fails with that reason spelled out instead of pretending. (Measured: across 30 real session logs, the number of assistant-message replacements is zero.)
- **Regenerate after editing your own input.** Editing a user message adds a **Save & regenerate** action: it saves the edit *and* has the model answer the new text, with the old answer removed from both the transcript and the context — no second answer stacked under a stale one. Plain **Save** stays the default cold edit.
- **Attachments too.** A user message's image and file chips are listed above the field; toggling one marks it removed, and saving drops that block from the message the model sees.
- **Undo.** A cold-edited user message shows an `Edited` marker and a revert control that restores the logged original. (A regenerate replaces the old answer and is not revertible.)
- **Durable and reversible.** An edit is an append-only event in the session log, not a mutation. It survives reloads, resume, fork, and replay, and the original is never destroyed.

## How it works

The session log is append-only, and the harness renders two different views of it:

- the **model-visible surface**, a fold that resolves each message to whatever currently shadows it;
- the **human transcript**, which admits append-origin events only, so that a landed replacement cannot erase conversation you already read.

This plugin writes to the first and draws the second.

1. **The rewrite is a surface replacement.** Editing appends a fresh `user/message` / `assistant/message` event carrying `surfaceOp: { op: 'replace', startSeq, endSeq }`, so the surface fold shadows the original node while the original stays in the log. This is the same mechanism context compaction and the tool-result pruner already use, and `Session.deriveMessages()` re-folds the log at the top of every model step — so **one append governs every later request**. No request-time interception exists for message history, and none is needed.
2. **The transcript is drawn by shadowed renderers.** The `conversation.chat.node` cell is keyed, so this plugin takes `user`, `steering`, `assistant-step`, and `context`. The user bubble is drawn directly; the assistant step *delegates* to the shipped markdown renderer with a patched node, so unedited replies are byte-for-byte the stock UI and edited ones keep full markdown, code, and reasoning rendering. Injected context rows delegate too; only this plugin's own trigger row is hidden.
3. **Regenerate is one cross-node replacement plus one wake-up.** Save & regenerate submits a range that starts at the edited message and runs through every reply after it, stopping at the next user message — and only `assistant/message` and `tool/result` nodes extend it, so the range can only ever be too small, never too large. The stale answer, its tool results, and its tool calls therefore leave the model's view together and no tool pair is orphaned. The plugin then enqueues a plugin-sourced trigger message to wake the session; the `context` renderer hides that row, so the reader sees the edited question followed by the new answer.
4. **The two halves talk over one authenticated route.** The host mounts an exact Fetch route on the connection's `/api` surface; the browser half calls it with a same-origin `fetch`, so every edit passes the same Host/Origin fence and browser authentication as the rest of the app. No generated Remote artifact, no zod contribution, no codegen.

Rewriting is deliberately conservative, because the message history feeds real provider requests:

- every non-text block is preserved verbatim — above all an assistant message's `tool-call` blocks, or the paired `tool/result` messages become orphans and the provider rejects the next request;
- an assistant replacement **drops `usage`**, since the token fold reads the raw log and would otherwise bill a past step twice;
- message `id`, `role`, and `source` are kept, as the load path requires;
- an assistant replacement **realigns `source.replayState.blocks` with the new content**: the adapter validates that array by index (matching length, matching `type` per position) and discards the whole envelope on any mismatch. It carries thinking signatures, not text, so misalignment costs the model that turn's reasoning continuity;
- an edit is refused while a context compaction bracket is open.

### Does the model know its words were changed?

No, and that is the design. A model has no memory of its own beyond the context, and **the context is its memory**. (This section applies to edits of your *own* messages; a model reply cannot be edited at all — see above.) After you rewrite your own input the prompt contains only the corrected version, with nothing marking it as edited, so the agent can neither notice nor object. That is precisely what a cold edit is for — the correction becomes the only version of the truth.

Three things make it *look* unaware:

1. **A gap inside a running turn.** The request is built before the `agent/request` waterfall, so editing while a step is in flight — mid-stream, or inside a tool loop — leaves that step's request carrying the old text. The edit reaches the model from the next step or turn.
2. **Later messages still assert the old content.** Rewriting turn 3 does not rewrite turn 7's "as I said earlier". The model sees contradictory history and may follow either part.
3. **Save & regenerate deletes the old answer from the model's view**, so it cannot even compare against what it used to say.

Making the model aware would take an explicit note in its context; the plugin deliberately does not add one, because that turns a correction into a conversation event.

## Install

The plugin is a **bundle**: `package.json` declares `dsh.bundle.patch`, and that patch inserts one host row. The browser half attaches automatically from `exports["./client"]`.

**From the Web UI** — sidebar → **Plugins** → **Add plugin** → paste this repository's URL or a local path, tick the trust box, **Install**.

**From an agent session** — `plugin_manager` → `install_bundle` with the package directory, a git address, or an npm spec.

**Verify** — the Plugins page lists `dsh-message-editor` as enabled; your own messages show a pencil, and model replies show a "Regenerate this turn" button in their action row.

> **If an edit fails with "The plugin is older in the host process than in this page", that is this rule.** The browser half is re-served from disk and can hot-swap; the host half is a cached module. When the two generations differ, the page calls an endpoint the running host does not have yet. Restarting aligns them, and nothing is corrupted in the meantime.

### One restart is required after installing or updating

A bundle that has *never* been loaded activates through HMR. **Replacing an already-installed package needs a process restart**, because the host half is a JavaScript module and the running process keeps the first generation it loaded in memory. This is documented harness behaviour, not a quirk of this plugin:

> Installing a new bundle can activate through HMR; replacing an installed package requires restart to load a fresh JavaScript module generation.

So after the first install of a *new version*, restart the app. On a fresh machine the first install activates immediately.

## Limitations

- **Loaded sessions only.** An edit needs a live session, because the replacement is appended through the live `Session.append` path. Editing a session that is not currently loaded returns an actionable refusal instead of writing a log the harness has not validated. Send one message to resume a cold session, then edit.
- **Assistant edits and step scope.** A `user/message` replacement is legal at any time, so a user-message edit is part of the very next request. An `assistant/message` replacement is step-scoped by the harness's own relational rules; the plugin applies it immediately when a step is open and otherwise stages it for the next model step, marking the message `Edited · applies next step`. In the shipped configuration the immediate path always succeeds, so staging is dormant.
- **Text is one string.** Several text blocks in one message are collapsed into the first one on save; reasoning, image, file, and tool-call blocks keep their order and content. An edit can therefore move text relative to a tool call, which is intended, but it cannot reorder non-text blocks.
- **Attachments are removable, not addable (yet).** Removing an attachment from a past message works today. Adding a brand-new file to a past message needs the upload pipeline and is deliberately out of scope for this version.
- **Regenerate is offered for user messages only, and has no undo.** It supersedes the old answer: that answer stays in the append-only log, but neither the transcript nor the model context shows it again. Use plain **Save** when you want to keep both.
- **One instance per harness.** The host mounts a fixed route path, so two copies of this plugin cannot be active at once.
- **Built against `@deepseek-ai/dsh` 0.2.0-rc.2.** The plugin declares no `@deepseek-ai/dsh-*` peer dependencies — the harness gates those against its exact runtime version, and a wrong range rejects the install. It talks to the host only through `ctx.sessions`, `ctx.agents`, and `ctx.connection`, and tolerates both shipped spellings of `surfaceOp` (`startSeq`/`endSeq` and the older `start`/`end`), so it should keep working across nearby releases.

## Develop

```bash
pnpm install
pnpm typecheck     # tsc over the browser half
pnpm test          # host log-rewriting logic + a full host harness
pnpm build         # esbuild → lib/client.js
```

Layout:

| Path | What it is |
|---|---|
| `index.js` | Host entry; re-exports `lib/host.js` |
| `lib/host.js` | Host half: the edit route, the surface replacements, the staged-assistant flush |
| `src/client/**` | Browser half, built into `lib/client.js` |
| `tests/**` | Host logic unit tests and an end-to-end host harness |
| `docs/research/**` | The seam research this design rests on |

`lib/` is committed on purpose: the harness serves the browser half verbatim and never builds it.

### Verifying a change

`pnpm test` covers the log rewriting against a `Session` double that enforces the real append contract (surface marker, replacement range, provenance). The browser half is verified through the live client slot tree — `cordis_inspect_query` → client `Slots` → `listSubTree` on `conversation.chat.node` should show this plugin's entries winning `user`, `steering`, and `assistant-step`.

## License

[MIT](LICENSE)
