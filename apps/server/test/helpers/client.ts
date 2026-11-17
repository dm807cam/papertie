import type { TestServer } from './harness'

/** The one user, as the board helpers take it. */
export interface TestUser {
  id: string
  /** `fetch` against the server with the server's own `Origin` (unless one is given). */
  request(path: string, init?: RequestInit): Promise<Response>
}

/** `fetch` against the server with the server's own `Origin` (and a JSON content type for bodies). */
export function api(server: TestServer, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Origin', server.url)
  // A FormData body gets its multipart Content-Type (with boundary) from fetch itself.
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${server.url}${path}`, { redirect: 'manual', ...init, headers })
}

export function postJson(server: TestServer, path: string, body: unknown) {
  return api(server, path, { method: 'POST', body: JSON.stringify(body) })
}
