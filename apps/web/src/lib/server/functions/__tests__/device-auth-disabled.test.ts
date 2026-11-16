import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ enabled: false, requireAuth: vi.fn(), getAuth: vi.fn() }))
vi.mock('@/lib/server/config', () => ({
  config: {
    get mcpOAuthEnabled() {
      return state.enabled
    },
  },
}))
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const chain = { validator: () => chain, handler: (fn: unknown) => fn }
    return chain
  },
}))
vi.mock('@tanstack/react-start/server', () => ({ getRequestHeaders: vi.fn() }))
vi.mock('../auth-helpers', () => ({ requireAuth: state.requireAuth }))
vi.mock('@/lib/server/auth', () => ({ getAuth: state.getAuth }))
vi.mock('@/lib/server/auth/recent-sign-in', () => ({ hasRecentSignIn: vi.fn() }))

import {
  isDeviceAuthorizationEnabledFn,
  lookupDeviceCodeFn,
  decideDeviceCodeFn,
} from '../device-auth'

beforeEach(() => {
  state.enabled = false
  vi.clearAllMocks()
})

describe('disabled device server functions', () => {
  it('returns unavailable without initializing auth or reading/writing codes', async () => {
    expect(await isDeviceAuthorizationEnabledFn()).toBe(false)
    expect(await lookupDeviceCodeFn({ data: { userCode: 'ABCD1234' } })).toEqual({
      state: 'unavailable',
    })
    for (const accept of [true, false]) {
      expect(
        await decideDeviceCodeFn({
          data: { userCode: 'ABCD1234', accept, selectedScopes: [], offlineAccess: false },
        })
      ).toEqual({ ok: false, reason: 'unavailable' })
    }
    expect(state.requireAuth).not.toHaveBeenCalled()
    expect(state.getAuth).not.toHaveBeenCalled()
  })
  it('reads the switch at request time', async () => {
    state.enabled = true
    expect(await isDeviceAuthorizationEnabledFn()).toBe(true)
  })
})
