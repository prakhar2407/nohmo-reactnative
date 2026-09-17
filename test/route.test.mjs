/**
 * The router-agnostic route watcher, and the contract the React provider relies
 * on when it turns a navigation into a PAGE_VIEW.
 *
 * This is the piece that lets a Vite/CRA app track routes without calling
 * usePageView() on every screen — the same watcher Next has always used. It runs
 * against a stubbed History API rather than a real DOM, because what matters is
 * which navigations it reports, not how a browser renders them.
 */
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let route

before(() => {
  // A stubbed browser, installed before the module is loaded: core/route patches
  // history at subscribe time and deliberately never un-patches.
  const listeners = {}
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener: (e, h) => { (listeners[e] ??= []).push(h) },
    __fire: (e) => (listeners[e] ?? []).forEach((h) => h()),
  }
  globalThis.history = {
    pushState(_s, _t, url) { globalThis.window.location.pathname = url },
    replaceState(_s, _t, url) { globalThis.window.location.pathname = url },
  }

  const out = mkdtempSync(path.join(tmpdir(), 'nohmo-route-'))
  try {
    execFileSync('npx', ['tsc', 'src/core/route.ts',
      '--outDir', out, '--module', 'commonjs', '--target', 'es2020',
      '--esModuleInterop', '--skipLibCheck', '--moduleResolution', 'node',
    ], { cwd: repo, stdio: 'pipe' })
  } catch { /* emit-on-error is fine */ }

  const compiled = path.join(out, 'route.js')
  assert.ok(existsSync(compiled), 'route.ts failed to compile')
  route = createRequire(path.join(out, 'x.js'))(compiled)
})

beforeEach(() => { globalThis.window.location.pathname = '/' })

describe('route watcher — every router, no per-page code', () => {
  test('pushState is reported', () => {
    const seen = []
    const off = route.onRouteChange((p) => seen.push(p))
    history.pushState({}, '', '/pricing')
    history.pushState({}, '', '/checkout')
    off()
    assert.deepEqual(seen, ['/pricing', '/checkout'])
  })

  test('replaceState is reported', () => {
    // React Router uses replaceState for redirects; missing it loses the landing
    // page of anyone who arrives via one.
    const seen = []
    const off = route.onRouteChange((p) => seen.push(p))
    history.replaceState({}, '', '/login')
    off()
    assert.deepEqual(seen, ['/login'])
  })

  test('back and forward are reported', () => {
    // popstate does not go through pushState, so without this the back button
    // would silently stop producing page views.
    const seen = []
    const off = route.onRouteChange((p) => seen.push(p))
    globalThis.window.location.pathname = '/pricing'
    globalThis.window.__fire('popstate')
    off()
    assert.deepEqual(seen, ['/pricing'])
  })

  test('unsubscribing actually stops delivery', () => {
    const seen = []
    const off = route.onRouteChange((p) => seen.push(p))
    off()
    history.pushState({}, '', '/after')
    assert.deepEqual(seen, [])
  })

  test('one bad subscriber does not stop the others', () => {
    // A throwing listener must never surface as an error in the host app, nor
    // stop the provider's own handler from firing.
    const seen = []
    const offBad = route.onRouteChange(() => { throw new Error('boom') })
    const offGood = route.onRouteChange((p) => seen.push(p))
    assert.doesNotThrow(() => history.pushState({}, '', '/still-works'))
    offBad(); offGood()
    assert.deepEqual(seen, ['/still-works'])
  })

  test('the original history behaviour is preserved', () => {
    const off = route.onRouteChange(() => {})
    history.pushState({}, '', '/real-navigation')
    off()
    assert.equal(window.location.pathname, '/real-navigation',
      'patching history must not break navigation itself')
  })
})

describe('page views are not double-counted after the upgrade', () => {
  let Tracker

  before(() => {
    // The tracker needs a bit more browser than the route watcher does.
    globalThis.document = { title: 'T', hidden: false, addEventListener() {}, referrer: '' }
    // Node defines navigator as a getter-only global, so plain assignment throws.
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'node', language: 'en' }, configurable: true, writable: true,
    })
    globalThis.screen = { width: 1440, height: 900 }
    const store = () => ({
      _s: {},
      getItem(k) { return this._s[k] ?? null },
      setItem(k, v) { this._s[k] = String(v) },
      removeItem(k) { delete this._s[k] },
    })
    globalThis.localStorage = store()
    globalThis.sessionStorage = store()

    const out = mkdtempSync(path.join(tmpdir(), 'nohmo-tracker-'))
    try {
      execFileSync('npx', ['tsc', 'src/core/tracker.ts',
        '--outDir', out, '--module', 'commonjs', '--target', 'es2020',
        '--esModuleInterop', '--skipLibCheck', '--moduleResolution', 'node',
      ], { cwd: repo, stdio: 'pipe' })
    } catch { /* emit-on-error is the point */ }
    const compiled = path.join(out, 'core', 'tracker.js')
    const flat = path.join(out, 'tracker.js')
    const file = existsSync(compiled) ? compiled : flat
    assert.ok(existsSync(file), 'tracker.ts failed to compile')
    Tracker = createRequire(path.join(out, 'x.js'))(file).NohmoTracker
  })

  function make() {
    const t = new Tracker({ projectId: 'p', apiKey: 'k', autoPageView: false })
    const sent = []
    t.send = (event, data) => sent.push({ event, data })
    return { t, sent }
  }

  test('a route change plus a leftover usePageView counts once', () => {
    // The upgrade hazard: an app written before automatic tracking still calls
    // usePageView on the screen the watcher just reported. Counting both would
    // silently double every page-view number in the dashboard.
    const { t, sent } = make()
    t.trackPageView('/pricing')   // route watcher
    t.trackPageView('/pricing')   // the component's own usePageView
    assert.equal(sent.filter((e) => e.event === 'PAGE_VIEW').length, 1)
  })

  test('different paths are both counted', () => {
    const { t, sent } = make()
    t.trackPageView('/a')
    t.trackPageView('/b')
    assert.deepEqual(sent.map((e) => e.data.path), ['/a', '/b'])
  })

  test('returning to a page later is counted again', async () => {
    // The guard must not swallow a real second visit — only the duplicate that
    // arrives in the same instant.
    const { t, sent } = make()
    t.trackPageView('/pricing')
    await new Promise((r) => setTimeout(r, 600))
    t.trackPageView('/pricing')
    assert.equal(sent.filter((e) => e.event === 'PAGE_VIEW').length, 2)
  })

  test('the page clock restarts on every counted view', () => {
    // trackPageView resets pageStart; send() never did. Without this, TIME_SPENT
    // after the first navigation measured the whole visit instead of the page.
    const { t, sent } = make()
    t.pageStart = Date.now() - 30_000
    t.trackPageView('/second-page')
    t.trackTimeSpent('/second-page')
    const ts = sent.find((e) => e.event === 'TIME_SPENT')
    assert.ok(!ts || ts.data.seconds < 5,
      `page clock was not restarted — reported ${ts?.data.seconds}s`)
  })
})
