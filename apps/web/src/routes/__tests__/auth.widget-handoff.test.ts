/**
 * Unit tests for the widget OTT handoff route loader logic.
 *
 * Exercise the production loader and server handler, mocking only framework
 * wrappers and external dependencies (HTTP, DB, and audit logging).
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recordAuditEvent: (arg: any) => mockRecordAuditEvent(arg),
}))

// DB mock
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOnConflictDoNothing: any = vi.fn()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInsertValues: any = vi.fn(() => ({ onConflictDoNothing: mockOnConflictDoNothing }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbInsert: any = vi.fn(() => ({ values: mockInsertValues }))
// Provenance lookup: tests default to hmacVerified=true so the
// existing redirect/audit assertions still exercise the success
// path. The provenance gate itself is covered in detail by
// auth.widget-handoff-provenance.test.ts.
const mockWidgetIdentifiedFindFirst = vi.fn(async () => ({ hmacVerified: true }))
vi.mock('@/lib/server/db', () => ({
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: (arg: any) => mockDbInsert(arg),
    query: {
      widgetIdentifiedSession: {
        findFirst: (...args: unknown[]) => mockWidgetIdentifiedFindFirst(...(args as [])),
      },
    },
  },
  widgetOriginSession: {},
  widgetIdentifiedSession: { sessionId: 'widget_identified_session.session_id' },
  eq: vi.fn((col, val) => ({ kind: 'eq', col, val })),
}))

// Fetch mock
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ---------------------------------------------------------------------------
// Invoke the real route loader; normalize its thrown redirect for assertions.
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
    if (isRedirect(err)) return { status: 'redirect' as const, to: err.options.to }
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

  it('verifies a fresh OTT with the configured origin and no Cookie on first use', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    expect(await runHandoffLoader('?ott=first-token')).toEqual({ status: 'redirect', to: '/' })
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/api/auth/one-time-token/verify', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ token: 'first-token' }),
    })
  })

  it.each([undefined, 'https://untrusted.example'])(
    'uses the configured origin for Cookie-bearing verification, not caller Origin %s',
    async (callerOrigin) => {
      const cookie = 'better-auth.session_token=existing-session'
      const headers = new Headers({ cookie, host: 'untrusted.example' })
      if (callerOrigin) headers.set('origin', callerOrigin)
      mockGetRequestHeaders.mockReturnValue(headers)
      // Simulate BA's Cookie-bearing POST origin check. Before the fix this
      // returns 403 despite a fresh OTT, reproducing the second-click failure.
      mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const verifyHeaders = new Headers(init.headers)
        if (
          verifyHeaders.has('cookie') &&
          verifyHeaders.get('origin') !== 'http://localhost:3000'
        ) {
          return new Response(null, { status: 403 })
        }
        return makeOkResponse({ id: 'sess_2', userId: 'user_abc' })
      })

      expect(await runHandoffLoader('?ott=fresh-token')).toEqual({ status: 'redirect', to: '/' })
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/auth/one-time-token/verify',
        expect.objectContaining({
          headers: {
            'content-type': 'application/json',
            origin: 'http://localhost:3000',
            cookie,
          },
          body: JSON.stringify({ token: 'fresh-token' }),
        })
      )
    }
  )

  it('still rejects reuse of an OTT after a successful Cookie-bearing handoff', async () => {
    mockGetRequestHeaders.mockReturnValue(
      new Headers({ cookie: 'better-auth.session_token=existing-session' })
    )
    // BA owns token consumption; simulate its success then replay rejection.
    mockFetch
      .mockResolvedValueOnce(makeOkResponse({ id: 'sess_2', userId: 'user_abc' }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }))

    expect(await runHandoffLoader('?ott=single-use-token')).toEqual({ status: 'redirect', to: '/' })
    mockSetResponseHeader.mockClear()
    mockDbInsert.mockClear()
    expect(await runHandoffLoader('?ott=single-use-token')).toEqual({ status: 'invalid' })
    expect(mockSetResponseHeader).not.toHaveBeenCalled()
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('forwards all session cookies together after provenance succeeds', async () => {
    const response = makeOkResponse({ id: 'sess_1', userId: 'user_abc' })
    response.headers.append('set-cookie', 'better-auth.session_data=data; Path=/; HttpOnly')
    mockFetch.mockResolvedValue(response)

    await runHandoffLoader('?ott=valid-token')
    expect(mockSetResponseHeader).toHaveBeenCalledExactlyOnceWith('Set-Cookie', [
      'better-auth.session_token=abc; Path=/; HttpOnly',
      'better-auth.session_data=data; Path=/; HttpOnly',
    ])
  })

  it('forwards Set-Cookie header from BA response', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    await runHandoffLoader('?ott=valid-token')
    expect(mockSetResponseHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([expect.stringContaining('better-auth.session_token')])
    )
  })

  it('inserts the widget_origin_session marker', async () => {
    mockFetch.mockResolvedValue(makeOkResponse({ id: 'sess_1', userId: 'user_abc' }))

    await runHandoffLoader('?ott=valid-token')
    expect(mockDbInsert).toHaveBeenCalled()
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
