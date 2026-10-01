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

1. **`ctx.connection.rpc.handle()` is unusable in the shipped 0.2.0 build.** Its `register` reads
   `owner.webServer` through the *connection service's own* context, whose row injects only `webRuntime`,
   so every caller gets `cannot get property "webServer" without inject`. Declaring `webServer` in the
   plugin's own inject does not help — the read is not on the plugin's context. The working sibling is the
   exact Fetch-route registry: `ctx.connection.fetch.register({ path: '/api/…', methods, requestBody, fetch })`
   mounts under the same `/api` prefix, behind the same Host/Origin fence and browser authentication.
2. **A shadowing entry must inherit the shipped entry's inject face.** The shipped `assistant-step`
   registration is `{ key: 'assistant-step', locale: NS, inject: () => ({ hooks: { presentation } }) }`.
   A shadow that supplies only its own inject face renders that view without `usePresentation`; the view
   throws on its first render, the entry is retired from its cell, and the transcript silently reverts to
   the shipped renderer. Copying the shipped entry's `inject(...)` result into the shadow's face — and
   keeping an error boundary around the delegated element — is what makes the takeover hold.
