/**
 * Unit tests for the widget OTT handoff route loader logic.
 *
 * Exercise the production loader and handler, mocking framework wrappers
 * and external dependencies rather than duplicating the handoff algorithm.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockSetResponseHeader = vi.fn()
const mockGetRequestHeaders = vi.fn(() => new Headers())

vi.mock('@tanstack/react-start', () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const chain = {
      validator() {
        return chain
      },
      handler(fn: unknown) {
        return fn
      },
    }
    return chain
  },
}))

vi.mock('@/lib/server/auth/session', () => ({
  getSession: () => mockGetSession(),
}))

vi.mock('@tanstack/react-start/server', () => ({
  setResponseHeader: (...args: unknown[]) => mockSetResponseHeader(...args),
  getRequestHeaders: () => mockGetRequestHeaders(),
}))

// Config mock
vi.mock('@/lib/server/config', () => ({
  config: { baseUrl: 'http://localhost:3000' },
}))

// Audit log mock
const mockRecordAuditEvent = vi.fn()
vi.mock('@/lib/server/audit/log', () => ({
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  recordAuditEvent: (arg: any) => mockRecordAuditEvent(arg),
}))

// DB mock
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
const mockOnConflictDoNothing: any = vi.fn()
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
const mockInsertValues: any = vi.fn(() => ({ onConflictDoNothing: mockOnConflictDoNothing }))
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbInsert: any = vi.fn(() => ({ values: mockInsertValues }))
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdateWhere: any = vi.fn(async () => undefined)
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdateSet: any = vi.fn(() => ({ where: mockUpdateWhere }))
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbUpdate: any = vi.fn(() => ({ set: mockUpdateSet }))
// Provenance lookup: tests default to hmacVerified=true so the
// existing redirect/audit assertions still exercise the success
// path. The provenance gate itself is covered in detail by
// auth.widget-handoff-provenance.test.ts.
const mockWidgetIdentifiedFindFirst = vi.fn(async () => ({ hmacVerified: true }))
const mockPrincipalFindFirst = vi.fn(async (): Promise<{ role: string } | null> => ({
  role: 'user',
}))
const mockGetSession = vi.fn(
  async (): Promise<{
    user: { id: string }
    session: { scope: string }
  } | null> => null
)
vi.mock('@/lib/server/db', () => ({
  db: {
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    insert: (arg: any) => mockDbInsert(arg),
    update: (arg: unknown) => mockDbUpdate(arg),
    query: {
      widgetIdentifiedSession: {
        findFirst: (...args: unknown[]) => mockWidgetIdentifiedFindFirst(...(args as [])),
      },
      principal: {
        findFirst: (...args: unknown[]) => mockPrincipalFindFirst(...(args as [])),
      },
    },
  },
  widgetOriginSession: {},
  widgetIdentifiedSession: { sessionId: 'widget_identified_session.session_id' },
  principal: { userId: 'principal.user_id' },
  session: { id: 'session.id' },
  eq: vi.fn((col, val) => ({ kind: 'eq', col, val })),
}))

// Fetch mock
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ---------------------------------------------------------------------------
// Invoke the actual loader and normalize its thrown redirect for assertions.
// ---------------------------------------------------------------------------

async function runHandoffLoader(search: string) {
  const { Route } = await import('../auth.widget-handoff')
  const { isRedirect } = await import('@tanstack/react-router')
  const params = new URLSearchParams(search)
  const loader = Route.options.loader as (context: {
    location: { search: { ott?: string; returnTo?: string } }
  }) => Promise<{ status: 'invalid' | 'expired' | 'error' }>
  try {
    return await loader({
      location: {
        search: {
          ott: params.get('ott') ?? undefined,
          returnTo: params.get('returnTo') ?? undefined,
        },
      },
    })
  } catch (err) {
    if (isRedirect(err)) {
      return { status: 'redirect' as const, to: err.options.to, search: err.options.search }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockGetRequestHeaders.mockReturnValue(new Headers())
})

describe('isHandoffPrincipalTeammate', () => {
  it('is true for admin and member, false for portal users', async () => {
    const { isHandoffPrincipalTeammate } = await import('../auth.widget-handoff')
    mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'admin' })
    expect(await isHandoffPrincipalTeammate('user_admin')).toBe(true)
    mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'member' })
    expect(await isHandoffPrincipalTeammate('user_member')).toBe(true)
    mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'user' })
    expect(await isHandoffPrincipalTeammate('user_customer')).toBe(false)
  })

  it('is false when no principal exists', async () => {
    const { isHandoffPrincipalTeammate } = await import('../auth.widget-handoff')
    mockPrincipalFindFirst.mockResolvedValueOnce(null)
    expect(await isHandoffPrincipalTeammate('user_unknown')).toBe(false)
  })
})

describe('verifyHandoffToken', () => {
  it('sends no cookie or origin-sensitive header even when the browser has cookies', async () => {
    // The incoming request carries portal-host cookies (a theme preference
    // plus CDN cookies). BA rejects a cookie-bearing request without Origin
    // with 403 MISSING_OR_NULL_ORIGIN, so none may be forwarded.
    mockGetRequestHeaders.mockReturnValue(new Headers({ cookie: 'cf_clearance=x; theme=dark' }))
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response)

    const { verifyHandoffToken } = await import('../auth.widget-handoff')
    await verifyHandoffToken('http://localhost:3000', 'tok_1')

    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://localhost:3000/api/auth/one-time-token/verify')
    const headers = new Headers(init.headers)
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ token: 'tok_1' })
  })

  it('does not forward the incoming cookie from the handoff flow either', async () => {
    mockGetRequestHeaders.mockReturnValue(new Headers({ cookie: 'cf_clearance=x; theme=dark' }))
    mockFetch.mockResolvedValue({ ok: false, status: 400 } as Response)

    await runHandoffLoader('?ott=tok_2')

    const headers = new Headers(mockFetch.mock.calls[0][1].headers)
    expect(headers.get('cookie')).toBeNull()
  })
})

describe('widget handoff loader — missing OTT', () => {
  it('returns invalid status when ott param is absent', async () => {
    const result = await runHandoffLoader('')
    expect(result.status).toBe('invalid')
  })

  it('records the invalid audit event when ott is missing', async () => {
    await runHandoffLoader('')
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'portal.widget_handshake.invalid',
        outcome: 'failure',
        metadata: expect.objectContaining({ reason: 'missing_ott' }),
      })
    )
  })
})

describe('widget handoff loader — valid OTT', () => {
  function makeOkResponse(session: { id: string; userId: string }) {
    const headers = new Headers()
    headers.append('set-cookie', 'better-auth.session_token=abc; Path=/; HttpOnly')
    return {
      ok: true,
      status: 200,
      headers,
      json: () =>
        Promise.resolve({
          session: { id: session.id, userId: session.userId },
          user: { id: session.userId },
        }),
    } as unknown as Response
  }

  it('redirects to / on a valid OTT', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    const result = await runHandoffLoader('?ott=valid-token')
    expect(result.status).toBe('redirect')
    if (result.status === 'redirect') expect(result.to).toBe('/')
  })

  it('forwards Set-Cookie header from BA response', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    await runHandoffLoader('?ott=valid-token')
    expect(mockSetResponseHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([expect.stringContaining('better-auth.session_token')])
    )
  })

  it('signs a returning visitor in without forwarding browser cookies or caller origin', async () => {
    mockGetRequestHeaders.mockReturnValue(
      new Headers({
        cookie: 'better-auth.session_token=old; cf_clearance=x',
        origin: 'https://untrusted.example',
      })
    )
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_returning', userId: 'user_abc' }))

    expect(await runHandoffLoader('?ott=fresh-token')).toMatchObject({
      status: 'redirect',
      to: '/',
    })
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/api/auth/one-time-token/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'fresh-token' }),
    })
  })

  it('forwards all response cookies together after verification', async () => {
    const response = makeOkResponse({ id: 'sess_1', userId: 'user_abc' })
    response.headers.append('set-cookie', 'better-auth.session_data=data; Path=/; HttpOnly')
    mockFetch.mockResolvedValue(response)

    await runHandoffLoader('?ott=valid-token')
    expect(mockSetResponseHeader).toHaveBeenCalledExactlyOnceWith('Set-Cookie', [
      'better-auth.session_token=abc; Path=/; HttpOnly',
      'better-auth.session_data=data; Path=/; HttpOnly',
    ])
  })

  it('does not install cookies or a provenance marker when a consumed token is rejected', async () => {
    mockFetch
      .mockResolvedValueOnce(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
    expect(await runHandoffLoader('?ott=single-use-token')).toMatchObject({ status: 'redirect' })
    mockSetResponseHeader.mockClear()
    mockDbInsert.mockClear()

    expect(await runHandoffLoader('?ott=single-use-token')).toEqual({ status: 'invalid' })
    expect(mockSetResponseHeader).not.toHaveBeenCalled()
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('inserts the widget_origin_session marker', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    await runHandoffLoader('?ott=valid-token')
    expect(mockDbInsert).toHaveBeenCalled()
  })

  it('promotes the verified session to portal scope', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    await runHandoffLoader('?ott=valid-token')
    expect(mockUpdateSet).toHaveBeenCalledWith({ scope: 'portal' })
  })

  it('records the consumed audit event', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    await runHandoffLoader('?ott=valid-token')
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'portal.widget_handshake.consumed',
        outcome: 'success',
      })
    )
  })

  it('respects a safe returnTo param', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    const result = await runHandoffLoader('?ott=valid-token&returnTo=/posts/123')
    if (result.status === 'redirect') expect(result.to).toBe('/posts/123')
  })

  it('rejects an unsafe returnTo (absolute URL) and falls back to /', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    const result = await runHandoffLoader(
      `?ott=valid-token&returnTo=${encodeURIComponent('https://evil.com')}`
    )
    if (result.status === 'redirect') expect(result.to).toBe('/')
  })

  describe('provenance gate', () => {
    it('rejects when the session has no widget_identified_session row', async () => {
      // No row → undefined → isWidgetSessionHmacVerified returns false →
      // handoff refuses to insert the marker and returns invalid.
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_no_row', userId: 'user_xyz' }))
      mockWidgetIdentifiedFindFirst.mockResolvedValueOnce(
        undefined as unknown as { hmacVerified: boolean }
      )

      const result = await runHandoffLoader('?ott=valid-token')
      expect(result.status).toBe('invalid')
      expect(mockDbInsert).not.toHaveBeenCalled()
      expect(mockUpdateSet).not.toHaveBeenCalled()
    })

    it('rejects when hmac_verified is false (email-capture identify)', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_capture', userId: 'user_xyz' }))
      mockWidgetIdentifiedFindFirst.mockResolvedValueOnce({ hmacVerified: false })

      const result = await runHandoffLoader('?ott=valid-token')
      expect(result.status).toBe('invalid')
      expect(mockDbInsert).not.toHaveBeenCalled()
    })

    it('records an audit failure with unverified_provenance reason on reject', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_capture', userId: 'user_xyz' }))
      mockWidgetIdentifiedFindFirst.mockResolvedValueOnce({ hmacVerified: false })

      await runHandoffLoader('?ott=valid-token')

      expect(mockRecordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'portal.widget_handshake.invalid',
          outcome: 'failure',
          metadata: expect.objectContaining({ reason: 'unverified_provenance' }),
        })
      )
    })

    it('does NOT forward Set-Cookie when provenance fails (G7)', async () => {
      // Regression: the route used to call setResponseHeader('Set-Cookie',
      // …) immediately after the OTT verify succeeded, BEFORE running the
      // provenance check. Any valid BA OTT (even one minted by a
      // non-widget flow) would then install the session cookie in the
      // browser even though the handoff was refused. The cookie must be
      // forwarded only AFTER provenance is confirmed.
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_capture', userId: 'user_xyz' }))
      mockWidgetIdentifiedFindFirst.mockResolvedValueOnce({ hmacVerified: false })

      await runHandoffLoader('?ott=valid-token')

      expect(mockSetResponseHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.anything())
    })

    it('does forward Set-Cookie when provenance passes (success-path parity)', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_ok', userId: 'user_ok' }))
      mockWidgetIdentifiedFindFirst.mockResolvedValueOnce({ hmacVerified: true })

      await runHandoffLoader('?ott=valid-token')

      expect(mockSetResponseHeader).toHaveBeenCalledWith(
        'Set-Cookie',
        expect.arrayContaining([expect.stringContaining('better-auth.session_token')])
      )
    })
  })

  describe('teammate identity', () => {
    it('does not install a portal cookie when the identified user is an admin', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_admin', userId: 'user_admin' }))
      mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'admin' })

      const result = await runHandoffLoader('?ott=valid-token')

      expect(result.status).toBe('redirect')
      expect(mockSetResponseHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.anything())
      expect(mockDbInsert).not.toHaveBeenCalled()
      expect(mockUpdateSet).not.toHaveBeenCalled()
    })

    it('does not install a portal cookie when the identified user is a member', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_member', userId: 'user_member' }))
      mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'member' })

      await runHandoffLoader('?ott=valid-token')

      expect(mockSetResponseHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.anything())
    })

    it('sends teammates to the portal sign-in landing without authenticating', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_admin', userId: 'user_admin' }))
      mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'admin' })

      const result = await runHandoffLoader('?ott=valid-token&returnTo=/posts/abc')

      expect(result.status).toBe('redirect')
      if (result.status === 'redirect') {
        expect(result.to).toBe('/')
        expect(result.search).toEqual({ auth: 'signin', callbackUrl: '/posts/abc' })
      }
    })

    it('records teammate_identity when skipping the cookie', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_admin', userId: 'user_admin' }))
      mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'admin' })

      await runHandoffLoader('?ott=valid-token')

      expect(mockRecordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'portal.widget_handshake.invalid',
          outcome: 'failure',
          metadata: expect.objectContaining({ reason: 'teammate_identity' }),
        })
      )
    })

    it('sends an already-authenticated teammate to returnTo without replacing the cookie', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_admin', userId: 'user_admin' }))
      mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'admin' })
      mockGetSession.mockResolvedValueOnce({
        user: { id: 'user_admin' },
        session: { scope: 'dashboard' },
      })

      const result = await runHandoffLoader('?ott=valid-token&returnTo=/posts/abc')

      expect(result.status).toBe('redirect')
      if (result.status === 'redirect') {
        expect(result.to).toBe('/posts/abc')
        expect(result.search).toBeUndefined()
      }
      expect(mockSetResponseHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.anything())
    })

    it('does not replace a dashboard cookie with a customer OTT', async () => {
      mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_customer', userId: 'user_customer' }))
      mockPrincipalFindFirst.mockResolvedValueOnce({ role: 'user' })
      mockGetSession.mockResolvedValueOnce({
        user: { id: 'user_admin' },
        session: { scope: 'dashboard' },
      })

      const result = await runHandoffLoader('?ott=valid-token&returnTo=/posts/abc')

      expect(result.status).toBe('redirect')
      if (result.status === 'redirect') {
        expect(result.to).toBe('/posts/abc')
      }
      expect(mockSetResponseHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.anything())
      expect(mockRecordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ reason: 'dashboard_session_present' }),
        })
      )
    })
  })
})

describe('widget handoff loader — invalid/expired/replayed OTT', () => {
  it('returns invalid status when BA responds with 400', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
    } as Response)

    const result = await runHandoffLoader('?ott=bad-token')
    expect(result.status).toBe('invalid')
  })

  it('returns error status when BA responds with a non-400 error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
    } as Response)

    const result = await runHandoffLoader('?ott=bad-token')
    expect(result.status).toBe('error')
  })

  it('records the invalid audit event on 400 from BA', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
    } as Response)

    await runHandoffLoader('?ott=bad-token')
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'portal.widget_handshake.invalid',
        outcome: 'failure',
      })
    )
  })

  it('returns error status when the fetch itself throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))

    const result = await runHandoffLoader('?ott=token-that-causes-error')
    expect(result.status).toBe('error')
  })

  it('does not insert marker on invalid OTT', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
    } as Response)

    await runHandoffLoader('?ott=bad-token')
    expect(mockDbInsert).not.toHaveBeenCalled()
  })
})
