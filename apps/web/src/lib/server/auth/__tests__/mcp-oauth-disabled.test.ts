/**
 * Every way into Better Auth carries the trusted client address: the instance
 * is configured to read only the private header, requests through
 * `auth.handler` get it set from the socket peer, and server-side `auth.api.*`
 * calls get the same rewrite of the headers they forward.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

if (!process.env.BASE_URL?.startsWith('http')) process.env.BASE_URL = 'http://localhost:3000'
process.env.SECRET_KEY ??= 'test-secret-key-with-at-least-32-characters'

const { built, mockGetRequestIP } = vi.hoisted(() => ({
  built: {
    options: null as null | {
      plugins?: Array<{ id: string }>
      emailAndPassword?: { enabled: boolean }
    },
    handler: vi.fn(async (_request: Request) => new Response(null, { status: 204 })),
    getSession: vi.fn(async (_args: { headers: Headers }) => null),
  },
  mockGetRequestIP: vi.fn(),
}))

vi.mock('better-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('better-auth')>()),
  betterAuth: vi.fn((options: typeof built.options) => {
    built.options = options
    return { api: { getSession: built.getSession }, handler: built.handler }
  }),
}))
vi.mock('@tanstack/react-start/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-start/server')>()),
  getRequestIP: mockGetRequestIP,
}))
vi.mock('@/lib/server/domains/platform-credentials/platform-credential.service', () => ({
  getPlatformCredentials: vi.fn(async () => null),
  getConfiguredIntegrationTypes: vi.fn(async () => new Set()),
}))
vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  getWorkspaceSettings: vi.fn(async () => ({
    settings: { authConfigVersion: 1 },
    authConfig: { oauth: {} },
    developerConfig: {},
  })),
}))
vi.mock('@/lib/server/domains/settings/tier-limits.service', () => ({
  getTierLimits: vi.fn(async () => ({ features: {} })),
}))
vi.mock('@/lib/server/domains/settings/identity-providers.service', () => ({
  listIdentityProviders: vi.fn(async () => []),
  getIdentityProviderCredentials: vi.fn(async () => null),
}))
vi.mock('../ensure-mcp-oauth-resource', () => ({
  ensureMcpOauthResource: vi.fn(async () => undefined),
}))
vi.mock('../hooks', () => ({
  hooksBefore: vi.fn(),
  hooksAfter: vi.fn(),
}))

const { getAuth, resetAuth } = await import('../index')
const { resetConfig, config } = await import('@/lib/server/config')
const { ensureMcpOauthResource } = await import('../ensure-mcp-oauth-resource')

beforeEach(() => {
  vi.stubEnv('BASE_URL', 'http://192.168.50.33:3001')
  vi.stubEnv('QUACKBACK_MCP_OAUTH_ENABLED', 'false')
  resetConfig()
  resetAuth()
  vi.mocked(ensureMcpOauthResource).mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetConfig()
  resetAuth()
})

describe('explicit MCP OAuth opt-out', () => {
  it('initializes normal HTTP auth without creating the HTTPS-only plugin or seeding resources', async () => {
    await getAuth()
    const ids = built.options?.plugins?.map((p) => p.id)
    expect(ids).not.toContain('oauth-provider')
    expect(ids).toEqual(expect.arrayContaining(['bearer', 'one-time-token', 'magic-link']))
    expect(built.options?.emailAndPassword?.enabled).toBe(true)
    expect(ensureMcpOauthResource).not.toHaveBeenCalled()
  })

  it.each([undefined, '', 'true', '1'])(
    'keeps MCP OAuth enabled by default (%s)',
    async (value) => {
      vi.stubEnv('QUACKBACK_MCP_OAUTH_ENABLED', value)
      resetConfig()
      expect(config.mcpOAuthEnabled).toBe(true)
      await expect(getAuth()).rejects.toThrow('MCP resource URL must use HTTPS')
    }
  )

  it('keeps the HTTPS provider and resource seeding when enabled', async () => {
    vi.stubEnv('BASE_URL', 'https://feedback.example.com')
    vi.stubEnv('QUACKBACK_MCP_OAUTH_ENABLED', 'true')
    resetConfig()
    await getAuth()
    expect(built.options?.plugins?.map((p) => p.id)).toContain('oauth-provider')
    expect(ensureMcpOauthResource).toHaveBeenCalled()
  })

  it('rejects an ambiguous switch instead of silently disabling OAuth', () => {
    vi.stubEnv('QUACKBACK_MCP_OAUTH_ENABLED', 'off')
    resetConfig()
    expect(() => config.mcpOAuthEnabled).toThrow()
  })
})
