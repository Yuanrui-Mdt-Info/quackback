import { beforeEach, describe, expect, it, vi } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { magicLink } from 'better-auth/plugins'

const { getAuth } = vi.hoisted(() => ({ getAuth: vi.fn() }))
vi.mock('../index', () => ({ getAuth }))
// Minting uses the real Better Auth adapter below, never the application DB.
vi.mock('@/lib/server/db', () => ({ db: {}, verification: {}, eq: vi.fn(), inArray: vi.fn() }))

import { mintMagicLinkUrl } from '../magic-link-mint'

function createAuth() {
  return betterAuth({
    baseURL: 'https://auth.test',
    secret: 'local-magic-link-compatibility-test-secret',
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    plugins: [magicLink({ sendMagicLink: async () => {} })],
    rateLimit: { enabled: false },
  })
}

let auth: ReturnType<typeof createAuth>
beforeEach(() => {
  auth = createAuth()
  getAuth.mockResolvedValue(auth)
})

function verify(token: string) {
  return auth.handler(
    new Request(`https://auth.test/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`)
  )
}

describe('internal mint compatibility with the installed Better Auth magic-link plugin', () => {
  it('redeems an internally minted link once and rejects replay', async () => {
    const { token } = await mintMagicLinkUrl({
      email: 'invitee@example.com',
      callbackPath: '/admin',
      portalUrl: 'https://auth.test',
    })
    const response = await verify(token)
    expect(response.status).toBe(200)
    expect((await response.json()).user.email).toBe('invitee@example.com')
    expect(response.headers.get('set-cookie')).toContain('session_token=')

    const replay = await verify(token)
    expect(replay.status).toBe(302)
    expect(replay.headers.get('location')).toContain('error=INVALID_TOKEN')
  })

  it.each([
    ['legacy unscoped link', 'legacy-token', { email: 'invitee@example.com', attempt: 0 }],
    [
      'another capability',
      'magic-link:legacy-token',
      { type: 'oauth-state', email: 'invitee@example.com' },
    ],
  ])('rejects %s without creating a session', async (_label, identifier, value) => {
    const ctx = await auth.$context
    await ctx.internalAdapter.createVerificationValue({
      identifier,
      value: JSON.stringify(value),
      expiresAt: new Date(Date.now() + 60_000),
    })
    const response = await verify('legacy-token')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('error=INVALID_TOKEN')
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})
