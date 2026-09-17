/**
 * The web tracker under conditions a real visitor arrives in.
 *
 * Each of these was a live defect found by auditing the Next/React integration:
 * a visitor with storage blocked was served a blank page, a wrong API key said
 * nothing at all, an offline moment threw events away, listeners outlived the
 * tracker that made them, and React StrictMode double-counted every page view in
 * development. They run against the built bundle, which is what a consumer gets.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(repo, 'dist', 'index.cjs')
let NohmoTracker

const put = (k, v) => {
  try { Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }) } catch { /* getter-only */ }
}

function makeStore() {
  return { _s: {}, getItem(k) { return this._s[k] ?? null },
           setItem(k, v) { this._s[k] = String(v) }, removeItem(k) { delete this._s[k] } }
}

/** A browser stub. `storageThrows` reproduces blocked cookies / private mode,
 *  where the property exists and reading it raises. */
function browser({ storageThrows = false, fetchImpl, beacon } = {}) {
  const listeners = { window: {}, document: {} }
  const target = (bag) => ({
    addEventListener(t, h) { (bag[t] ??= []).push(h) },
    removeEventListener(t, h) { bag[t] = (bag[t] ?? []).filter((x) => x !== h) },
    __count() { return Object.values(bag).reduce((n, a) => n + a.length, 0) },
  })
  const doc = { ...target(listeners.document), title: 'T', hidden: false, referrer: '', documentElement: { scrollHeight: 2000 } }
  const win = { ...target(listeners.window), location: { pathname: '/', href: 'https://shop.test/', search: '' },
                innerHeight: 800, scrollY: 0, devicePixelRatio: 1 }

  if (storageThrows) {
    const boom = () => { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e }
    for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(globalThis, k, { get: boom, configurable: true })
  } else {
    put('localStorage', makeStore()); put('sessionStorage', makeStore())
  }

  const net = []
  put('fetch', fetchImpl ?? (async (url, init) => {
    net.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return { ok: true, status: 200, json: async () => ({ success: true, data: { deviceId: 'did_srv' } }) }
  }))
  put('navigator', { userAgent: 'node', language: 'en', sendBeacon: beacon ?? (() => false) })
  put('screen', { width: 1440, height: 900 })
  put('crypto', { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i; return a },
                  subtle: { digest: async () => new Uint8Array(32).buffer } })
  put('document', doc); put('window', win)
  return { win, doc, net, listenerCount: () => win.__count() + doc.__count() }
}

// A tracker's flush interval keeps the Node event loop alive, so anything left
// running would hang the whole file rather than fail it.
const started = []
before(() => {
  assert.ok(existsSync(dist), 'run `npm run build` before these tests')
  const Real = createRequire(path.join(repo, 'x.js'))(dist).NohmoTracker
  NohmoTracker = class extends Real {
    constructor(cfg) { super(cfg); started.push(this) }
  }
})
after(() => { for (const t of started) { try { t.destroy() } catch { /* already gone */ } } })

describe('web tracker — a visitor with storage blocked', () => {
  test('constructing and running the tracker never throws', async () => {
    // NohmoProvider builds this inside an effect. A throw here reached React,
    // which unmounted the host app's tree — the analytics script blanked the site.
    browser({ storageThrows: true })
    let t
    assert.doesNotThrow(() => { t = new NohmoTracker({ projectId: 'p', apiKey: 'k' }) })
    await assert.doesNotReject(() => t.init())
    assert.doesNotThrow(() => t.send('click'))
    assert.doesNotThrow(() => t.destroy())
  })
})

describe('web tracker — failures are reported, not swallowed', () => {
  test('a rejected API key says so once, naming the fix', async () => {
    browser({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ detail: 'bad key' }) }) })
    const errs = []
    const orig = console.error
    console.error = (...a) => errs.push(a.map(String).join(' '))
    const t = new NohmoTracker({ projectId: 'p', apiKey: 'WRONG', autoCapture: false, autoErrors: false })
    await t.init()
    await t.linkUser('u-1')
    t.destroy()
    console.error = orig

    const cred = errs.filter((e) => /rejected the SDK credentials/.test(e))
    assert.equal(cred.length, 1, `expected one credentials error, got ${cred.length}: ${JSON.stringify(errs)}`)
    assert.match(cred[0], /projectId/)
    assert.match(cred[0], /apiKey/)
  })

  test('a linkUser the server refused does not claim success', async () => {
    const { net } = browser({ fetchImpl: async (url) => String(url).includes('link-user')
      ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { deviceId: 'did_srv' } }) } })
    const t = new NohmoTracker({ projectId: 'p', apiKey: 'k', autoPageView: false, autoCapture: false, autoErrors: false })
    await t.init()
    const orig = console.error; console.error = () => {}
    await t.linkUser('u-1')
    console.error = orig
    t.destroy()
    const linked = net.filter((n) => n.body?.events).flatMap((n) => n.body.events).filter((e) => e.event === 'USER_LINKED')
    assert.equal(linked.length, 0, 'USER_LINKED was emitted for a link the server rejected')
  })
})

describe('web tracker — events survive a bad moment', () => {
  test('an offline flush keeps its events for the next one', async () => {
    browser({ beacon: () => false, fetchImpl: async () => { throw new Error('offline') } })
    const t = new NohmoTracker({ projectId: 'p', apiKey: 'k', autoPageView: false, autoCapture: false, autoErrors: false })
    await t.init()
    t.send('purchase', { amount: 99 })
    t.queue.flush()
    await new Promise((r) => setTimeout(r, 40))
    assert.ok(t.queue.queue.length > 0, 'the batch was cleared before sending and never put back')
    t.destroy()
  })
})

describe('web tracker — lifecycle', () => {
  test('destroy() takes its listeners off the page', async () => {
    const b = browser()
    const t = new NohmoTracker({ projectId: 'p', apiKey: 'k' })
    await t.init()
    assert.ok(b.listenerCount() > 0, 'expected the tracker to attach listeners')
    t.destroy()
    assert.equal(b.listenerCount(), 0,
      'listeners outlived the tracker — a remount stacks another set and the dead one keeps firing')
  })

  test('a destroyed tracker goes quiet', async () => {
    const { net } = browser()
    const t = new NohmoTracker({ projectId: 'p', apiKey: 'k', autoCapture: false, autoErrors: false })
    await t.init()
    t.destroy()
    const before = net.length
    t.send('after_destroy')
    t.queue.flush()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(net.length, before, 'a destroyed tracker still sent an event')
  })

  test('StrictMode’s double mount reports one page view', async () => {
    // React 18/19 StrictMode mounts, unmounts and remounts every effect in
    // development, so the provider builds two trackers. The first is destroyed
    // while its async init is still running; when that init finished it used to
    // report a page view too, and dev saw every number doubled.
    const b = browser()
    const { net } = b
    // Its own path: the duplicate guard is page-wide by design (that is what
    // makes the double mount report once), so it also spans tests in one process.
    b.win.location.pathname = '/strict-mount'
    const cfg = { projectId: 'p', apiKey: 'k', autoCapture: false, autoErrors: false }
    const first = new NohmoTracker(cfg)
    const firstInit = first.init()
    first.destroy()                      // StrictMode cleanup, mid-init
    const second = new NohmoTracker(cfg)
    await Promise.all([firstInit, second.init()])
    second.queue.flush()
    await new Promise((r) => setTimeout(r, 40))
    second.destroy()

    const views = net.filter((n) => n.body?.events).flatMap((n) => n.body.events).filter((e) => e.event === 'PAGE_VIEW')
    assert.equal(views.length, 1, `expected one PAGE_VIEW across the double mount, got ${views.length}`)
  })
})
