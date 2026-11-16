/**
 * Path-inserted RFC 9728 document for resource `…/api/mcp`.
 * Better Auth 1.7's challenge helper points here; keep it identical to the root PRM.
 */

import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/.well-known/oauth-protected-resource/api/mcp')({
  server: {
    handlers: {
      GET: async () => {
        const { mcpOAuthUnavailableResponse } =
          await import('@/lib/server/auth/mcp-oauth-availability')
        const unavailable = mcpOAuthUnavailableResponse()
        if (unavailable) return unavailable
        const { config } = await import('@/lib/server/config')
        const { mcpProtectedResourceMetadata } =
          await import('@/lib/server/mcp/protected-resource-metadata')
        return new Response(JSON.stringify(mcpProtectedResourceMetadata(config.baseUrl)), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
            Vary: 'Host',
          },
        })
      },
    },
  },
})
