import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ enabled: false }))
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  notFound: () => ({ isNotFound: true }),
  redirect: (options: unknown) => ({ isRedirect: true, options }),
  useNavigate: vi.fn(),
}))
vi.mock('@/lib/server/functions/device-auth', () => ({
  isDeviceAuthorizationEnabledFn: async () => state.enabled,
}))
vi.mock('@/components/device/device-approval', () => ({ DeviceApproval: vi.fn() }))
import { Route } from '../device'
const beforeLoad = (
  Route as unknown as { options: { beforeLoad: (args: unknown) => Promise<void> } }
).options.beforeLoad
beforeEach(() => {
  state.enabled = false
})
describe('device page availability', () => {
  it.each([null, { user: { id: 'test-user' } }])(
    'returns not found before login when disabled',
    async (session) => {
      await expect(beforeLoad({ context: { session }, search: {} })).rejects.toEqual({
        isNotFound: true,
      })
    }
  )
  it('preserves the signed-in flow when enabled', async () => {
    state.enabled = true
    await expect(
      beforeLoad({ context: { session: { user: { id: 'test-user' } } }, search: {} })
    ).resolves.toBeUndefined()
  })
  it('still requires sign-in for enabled device authorization', async () => {
    state.enabled = true
    await expect(
      beforeLoad({ context: { session: null }, search: { user_code: 'ABCD1234' } })
    ).rejects.toMatchObject({ isRedirect: true })
  })
})
