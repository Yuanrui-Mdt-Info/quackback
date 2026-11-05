import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))
vi.mock('@/lib/server/config', () => ({
  config: { mcpOAuthEnabled: false, baseUrl: 'http://192.168.50.33:3001' },
}))
const { handler, getAuth } = vi.hoisted(() => ({
  handler: vi.fn(async () => new Response(null, { status: 204 })),
  getAuth: vi.fn(() => {
    throw new Error('disabled discovery must not initialize OAuth')
  }),
}))
vi.mock('@/lib/server/auth/index', () => ({ auth: { handler }, getAuth }))

import { Route as ProtectedRoot } from '../[.]well-known.oauth-protected-resource'
import { Route as ProtectedPath } from '../[.]well-known.oauth-protected-resource.api.mcp'
import { Route as AuthorizationRoot } from '../[.]well-known.oauth-authorization-server'
import { Route as AuthorizationPath } from '../[.]well-known.oauth-authorization-server.api.auth'
import { Route as OpenIdRoot } from '../[.]well-known.openid-configuration'
import { Route as OpenIdPath } from '../[.]well-known.openid-configuration.api.auth'
import { Route as Auth } from '../api/auth/$'

type TestRoute = {
  options: {
    server: { handlers: Record<string, (args: { request: Request }) => Promise<Response>> }
  }
}
function request(route: unknown, path: string, method = 'GET') {
  return (route as TestRoute).options.server.handlers[method]({
    request: new Request(`http://192.168.50.33:3001${path}`, { method }),
  })
}

describe('disabled MCP OAuth routes', () => {
  it.each([
    ProtectedRoot,
    ProtectedPath,
    AuthorizationRoot,
    AuthorizationPath,
    OpenIdRoot,
    OpenIdPath,
  ])('returns a non-cacheable 404 for provider discovery', async (route) => {
    const response = await request(route, '/.well-known/oauth-authorization-server')
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(getAuth).not.toHaveBeenCalled()
  })
  it.each([
    ['/api/auth/oauth2/authorize', 'GET'],
    ['/api/auth/oauth2/register', 'POST'],
    ['/api/auth/oauth2/token', 'POST'],
  ])('does not dispatch disabled provider endpoint %s', async (path, method) => {
    handler.mockClear()
    expect((await request(Auth, path, method)).status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })
  it.each([
    ['/api/auth/get-session', 'GET'],
    ['/api/auth/one-time-token/generate', 'GET'],
    ['/api/auth/sign-in/email', 'POST'],
    ['/api/auth/sign-in/social', 'POST'],
  ])('still dispatches ordinary authentication endpoint %s', async (path, method) => {
    handler.mockClear()
    expect((await request(Auth, path, method)).status).toBe(204)
    expect(handler).toHaveBeenCalledOnce()
  })
})
