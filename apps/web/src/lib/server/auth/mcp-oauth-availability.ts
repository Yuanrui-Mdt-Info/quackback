import { config } from '@/lib/server/config'

/** Missing provider endpoints must not advertise OAuth or throw during discovery. */
export function mcpOAuthUnavailableResponse(): Response | null {
  if (config.mcpOAuthEnabled !== false) return null
  return Response.json(
    { error: 'MCP OAuth is disabled for this instance' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } }
  )
}
