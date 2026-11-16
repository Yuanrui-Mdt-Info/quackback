import { describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'

// Exercise the installed dependency's public API. All attempted requests are
// answered in memory, including the positive controls; no network is needed.
describe('Happy DOM security upgrade', () => {
  it.each([false, true])(
    'loads iframe/CSS resources only with explicit opt-in: %s',
    async (optIn) => {
      const requests: string[] = []
      const window = new Window({
        url: 'https://fixture.test/',
        settings: {
          ...(optIn ? { enableIframePageLoading: true, enableCSSFileLoading: true } : {}),
          fetch: {
            interceptor: {
              beforeAsyncRequest: async ({ request, window }) => {
                requests.push(new URL(request.url).pathname)
                return new window.Response(
                  request.url.endsWith('.css') ? 'body { color: red }' : '<p>Frame</p>',
                  {
                    headers: {
                      'content-type': request.url.endsWith('.css') ? 'text/css' : 'text/html',
                    },
                  }
                )
              },
            },
          },
        },
      })
      try {
        window.document.write(
          '<link rel="stylesheet" href="/fixture.css"><iframe src="/frame"></iframe>'
        )
        await window.happyDOM.waitUntilComplete()
        expect(window.document.querySelector('iframe')).not.toBeNull()
        expect(requests.sort()).toEqual(optIn ? ['/fixture.css', '/frame'] : [])
      } finally {
        await window.happyDOM.close()
      }
    }
  )

  it.each([false, true])(
    'does not execute malformed import aliases while valid modules still work: %s',
    async (malformed) => {
      const window = new Window({
        url: 'https://fixture.test/',
        settings: {
          // Opt in only for these trusted, in-memory module fixtures.
          enableJavaScriptEvaluation: true,
          suppressInsecureJavaScriptEnvironmentWarning: true,
          fetch: {
            interceptor: {
              beforeAsyncRequest: async ({ window }) =>
                new window.Response('{"value":42}', {
                  headers: { 'content-type': 'application/json' },
                }),
            },
          },
        },
      })
      try {
        const script = window.document.createElement('script')
        script.type = 'module'
        script.textContent = malformed
          ? "import { missing as injected = globalThis.__aliasProbe = 42 } from './fixture.json' with { type: 'json' }; globalThis.__moduleFinished = true;"
          : "import { default as result } from './fixture.json' with { type: 'json' }; globalThis.__aliasProbe = result.value; globalThis.__moduleFinished = true;"
        window.document.body.appendChild(script)
        await window.happyDOM.waitUntilComplete()
        await expect.poll(() => Reflect.get(window, '__moduleFinished')).toBe(true)
        expect(Reflect.get(window, '__aliasProbe')).toBe(malformed ? undefined : 42)
      } finally {
        await window.happyDOM.close()
      }
    }
  )
})
