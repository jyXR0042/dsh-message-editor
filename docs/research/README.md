# Design research

These two reports are the seam investigation this plugin's design rests on. They were written against a
source checkout of `@deepseek-ai/dsh` 0.1.0-rc.5 while the installed desktop app was already 0.2.0-rc.2, so
treat the *conclusions* as load-bearing and the *line numbers* as historical.

| Report | What it established |
|---|---|
| [surface-replacement-seam.md](surface-replacement-seam.md) | There is no request-time seam for message history: `agent/request` carries call config only, `llm/stream` receives a frozen request, and `agent/pre-step` sees only the newly claimed inbox batch. The supported mechanism is a durable **surface replacement** event, and `Session.deriveMessages()` re-folds the log every step, so one append governs every later request. |
| [client-edit-data-path.md](client-edit-data-path.md) | The browser receives replacement events but the transcript builder admits append-origin events only, so a visual edit needs its own renderer. It also maps the client slot surface, the `useProjection` option, and the absence of any per-user-message action seat. |

Two findings in them were superseded during implementation and are recorded here so they are not
re-discovered the hard way:

1. **The edit channel is an exact Fetch route, not a generic RPC channel.** `ctx.connection.rpc.handle()`
   mounts its physical route through `owner.webServer`, so a caller that does not declare `webServer` in
   its own inject fails with `cannot get property "webServer" without inject`. `owner` *is* the calling
   plugin's context — unloading the plugin disposes the route — so the fix would be a one-word inject
   change; the exact Fetch-route registry was chosen instead because it needs no extra service while
   mounting on the same authenticated `/api` surface:
   `ctx.connection.fetch.register({ path: '/api/…', methods, requestBody, fetch })`, matched by
   `createSharedFetchHandler('/api')` before the shared fallback.
   *Correction:* an earlier draft of this note claimed the API was broken for every caller because the
   read happened on the connection service's own context. That was wrong — it was this plugin's missing
   `webServer` inject, and a cached module generation hid the fix from re-testing.
2. **A shadowing entry must inherit the shipped entry's inject face.** The shipped `assistant-step`
   registration is `{ key: 'assistant-step', locale: NS, inject: () => ({ hooks: { presentation } }) }`.
   A shadow that supplies only its own inject face renders that view without `usePresentation`; the view
   throws on its first render, the entry is retired from its cell, and the transcript silently reverts to
   the shipped renderer. Copying the shipped entry's `inject(...)` result into the shadow's face — and
   keeping an error boundary around the delegated element — is what makes the takeover hold.
3. **On 0.2.0 a keyed registration *replaces* the cell rather than shadowing it by priority.** The live
   ledger shows the plugin's entries at `priority: 0` with the shipped entries for those keys gone
   entirely, not retained beneath them. The practical consequence: capture the shipped entry from
   `ctx.slots.entries()` **before** registering, because afterwards it is no longer in the ledger.
