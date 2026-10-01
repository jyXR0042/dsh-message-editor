/**
 * The browser half's side of the edit channel.
 *
 * The Host mounts one exact route on the connection's authenticated `/api`
 * surface, so the browser reaches it with a same-origin `fetch` — no generated
 * Remote namespace, no zod contribution, and the request still passes the
 * Host/Origin fence and browser authentication that the whole `/api` surface
 * shares.
 *
 * A carrier failure and a business refusal are deliberately collapsed into the
 * same settled envelope, because the controller renders them identically.
 *
 * @module dsh-message-editor/client/channel
 */

/** The Host route this plugin owns; kept in step with the host half. */
export const EDITOR_ENDPOINT = '/api/dsh-message-editor'

/** One settled business reply, as the Host writes it. */
export type EditorEnvelope =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message?: string } }

/** The caller shape the controller depends on. */
export interface EditorChannel {
  call: (endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<EditorEnvelope>
}

/**
 * Build the channel over `fetch`.
 * @param fetchImpl - the fetch implementation; defaults to the global one.
 * @returns a caller that never rejects.
 */
export function createEditorChannel(
  fetchImpl: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined,
): EditorChannel {
  return {
    async call(endpoint, payload, signal) {
      if (fetchImpl === undefined) {
        return { ok: false, error: { code: 'transport', message: 'fetch is unavailable' } }
      }
      try {
        const response = await fetchImpl(EDITOR_ENDPOINT, {
          method: 'POST',
          // Same-origin keeps the session cookie that authenticates /api.
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint, payload }),
          ...(signal === undefined ? {} : { signal }),
        })
        if (!response.ok) {
          return { ok: false, error: { code: 'transport', message: `HTTP ${response.status}` } }
        }
        const body = (await response.json()) as EditorEnvelope | undefined
        if (body === undefined || typeof body !== 'object' || typeof body.ok !== 'boolean') {
          return { ok: false, error: { code: 'transport', message: 'malformed reply' } }
        }
        return body
      } catch (error) {
        return {
          ok: false,
          error: { code: 'transport', message: error instanceof Error ? error.message : String(error) },
        }
      }
    },
  }
}
