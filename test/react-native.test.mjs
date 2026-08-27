/**
 * Runtime tests for the React Native tracker.
 *
 * The tracker is the one part of the SDK that never runs under any test: it
 * imports `react-native`, so it cannot be loaded in Node, and exercising it on a
 * device needs a full Gradle/Xcode build. So this compiles the real source and
 * loads it against a stubbed `react-native`, which is enough to pin the things
 * that are invisible from the outside and were in fact wrong: the exact shape of
 * what goes on the wire, and what survives a restart.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let NohmoRNTracker
let rn // the react-native stub, so tests can drive AppState / NativeModules

before(() => {
  const out = mkdtempSync(path.join(tmpdir(), 'nohmo-rn-'))

  // tsc reports errors for the ambient `react-native` module and ErrorUtils but
  // still emits, which is all we need — the stub below supplies them at runtime.
  try {
    execFileSync('npx', ['tsc',
      'src/react-native/tracker.ts', 'src/react-native/env.d.ts',
      '--outDir', out, '--module', 'commonjs', '--target', 'es2020',
      '--esModuleInterop', '--skipLibCheck', '--moduleResolution', 'node',
    ], { cwd: repo, stdio: 'pipe' })
  } catch { /* emit-on-error is the point */ }

  const compiled = path.join(out, 'tracker.js')
  assert.ok(existsSync(compiled), 'tracker.ts failed to compile at all')

  mkdirSync(path.join(out, 'node_modules', 'react-native'), { recursive: true })
  writeFileSync(path.join(out, 'node_modules', 'react-native', 'package.json'),
    JSON.stringify({ name: 'react-native', main: 'index.js' }))
  writeFileSync(path.join(out, 'node_modules', 'react-native', 'index.js'), `
    let appStateHandler = null
    let urlHandler = null
    const stub = {
      Platform: { OS: 'android', Version: 34 },
      Dimensions: { get: () => ({ width: 393, height: 851, scale: 2.75, fontScale: 1 }) },
      AppState: {
        addEventListener: (_e, h) => { appStateHandler = h; return { remove() { appStateHandler = null } } },
      },
      Linking: {
        getInitialURL: async () => stub.__initialUrl ?? null,
        addEventListener: (_e, h) => { urlHandler = h; return { remove() { urlHandler = null } } },
      },
      NativeModules: {},
      __initialUrl: null,
      __appState: (s) => appStateHandler && appStateHandler(s),
      __openUrl: (url) => urlHandler && urlHandler({ url }),
      __reset: () => { stub.__initialUrl = null; stub.NativeModules = {} },
    }
    module.exports = stub
  `)

  const req = createRequire(path.join(out, 'x.js'))
  NohmoRNTracker = req(compiled).NohmoRNTracker
  rn = req('react-native')
})

const HOST = 'http://localhost:9'

function memStorage(seed = {}) {
  const store = { ...seed }
  return {
    store,
    getItem: async (k) => (k in store ? store[k] : null),
    setItem: async (k, v) => { store[k] = v },
  }
}

/** Captures every request and lets a test choose the status per path. */
function mockFetch({ status = 200, body = {} } = {}) {
  const calls = []
  global.fetch = async (url, init) => {
    const parsed = JSON.parse(init.body)
    calls.push({ url, apiKeyHeader: init.headers['X-API-Key'] ?? null, body: parsed })
    let payload = body
    if (String(url).includes('/identify/')) {
      payload = { success: true, data: { deviceId: parsed.deviceId, userId: null } }
    } else if (String(url).includes('/invite-link/')) {
      payload = { shortCode: 'ABC123' }
    } else if (String(url).includes('/attribute/')) {
      payload = { success: true, data: {} }
    }
    return { ok: status < 400, status, json: async () => payload }
  }
  calls.events = () => calls
    .filter(c => String(c.url).includes('/track/'))
    .flatMap(c => c.body.events)
  calls.to = (frag) => calls.filter(c => String(c.url).includes(frag))
  return calls
}

// init() starts a flush setInterval that keeps the Node event loop alive, so
// every tracker has to be torn down or the test process simply never exits.
const trackers = []
after(() => {
  for (const t of trackers) {
    try { t.destroy() } catch { /* already gone */ }
  }
})

async function start(opts = {}, storage = memStorage()) {
  const t = new NohmoRNTracker({
    projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage, ...opts,
  })
  trackers.push(t)
  await t.init()
  return { t, storage }
}

describe('React Native tracker — wire format', () => {
  test('every event carries the SDK identity ingestion reads', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()

    const events = calls.events()
    assert.ok(events.length > 0, 'no events were sent')
    for (const e of events) {
      // These were stamped on the queued event and then dropped on the way out,
      // so `sdk` stayed empty on every React Native device row.
      assert.equal(e.sdk, 'react-native', `${e.event} lost its sdk name`)
      assert.ok(e.sdkVersion, `${e.event} lost its sdkVersion`)
      assert.equal(e.platform, 'android')
      assert.ok('page' in e, 'the backend reads `page`, not `screen`')
    }
    assert.ok(events.some(e => e.event === 'APP_INSTALL'))
    assert.ok(events.some(e => e.event === 'APP_OPEN'))
  })

  test('requests go to the configured host', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()
    assert.ok(calls.length > 0)
    for (const c of calls) {
      assert.ok(String(c.url).startsWith(HOST), `${c.url} ignored the host option`)
    }
  })

  test('/track authenticates by body, the rest by header', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()
    assert.equal(calls.to('/identify/')[0].apiKeyHeader, 'pk_t')
    const track = calls.to('/track/')[0]
    assert.equal(track.apiKeyHeader, null)
    assert.equal(track.body.apiKey, 'pk_t')
  })
})

describe('React Native tracker — attribution', () => {
  test('session utm uses the bare keys ingestion reads', async () => {
    rn.__reset()
    rn.__initialUrl = 'myapp://open?utm_source=meta&utm_medium=cpc&utm_campaign=summer'
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()

    const e = calls.events().find(x => x.utm)
    assert.ok(e, 'no event carried utm')
    // process_events reads utm.source; sending utm_source wrote a blank source
    // onto every mobile session.
    assert.deepEqual(e.utm, { source: 'meta', medium: 'cpc', campaign: 'summer' })
  })

  test('a custom attribution param overrides source and medium', async () => {
    rn.__reset()
    rn.__initialUrl = 'myapp://open?utm_source=meta&ref=partner_a&utm_campaign=x'
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()
    const e = calls.events().find(x => x.utm)
    assert.equal(e.utm.source, 'partner_a')
    assert.equal(e.utm.medium, 'ref')
    assert.equal(e.utm._custom, '1')
    assert.equal(e.utm.campaign, 'x')
  })

  test('INSTALL_ATTRIBUTED keeps the raw utm_* names', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t.setInstallReferrer('utm_source=google-play&utm_medium=organic')
    await t._flush()

    const attributed = calls.events().find(e => e.event === 'INSTALL_ATTRIBUTED')
    assert.ok(attributed, 'no INSTALL_ATTRIBUTED')
    // The dashboard renders this event by reading data.utm_source directly, so
    // normalising here would blank the source in every journey view.
    assert.equal(attributed.data.utm_source, 'google-play')
    assert.equal(attributed.data.utm_medium, 'organic')

    // Two /attribute calls is correct, not a duplicate: the auto-read on first
    // open fires an empty probabilistic ping, and a manual referrer arriving
    // afterwards is strictly better information. The backend returns the cached
    // attribution once a device has one, so the second call cannot overwrite.
    const attempts = calls.to('/attribute/')
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].body.installReferrer, '')
    assert.equal(attempts[1].body.installReferrer,
      'utm_source=google-play&utm_medium=organic')
  })

  test('a real referrer is never sent twice', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t.setInstallReferrer('utm_source=google-play')
    await t.setInstallReferrer('utm_source=someone-else')
    await t._flush()

    const withReferrer = calls.to('/attribute/')
      .filter(c => c.body.installReferrer !== '')
    assert.equal(withReferrer.length, 1, 'attribution was sent more than once')
    assert.equal(withReferrer[0].body.installReferrer, 'utm_source=google-play')
    assert.equal(
      calls.events().filter(e => e.event === 'INSTALL_ATTRIBUTED').length, 1)
  })

  test('the Play referrer is read from the native module on first open', async () => {
    rn.__reset()
    rn.NativeModules.NohmoInstallReferrer = {
      getReferrer: async () => 'utm_source=google-play&nohmo_click=abc',
    }
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()
    assert.equal(calls.to('/attribute/')[0].body.installReferrer,
      'utm_source=google-play&nohmo_click=abc')
  })
})

describe('React Native tracker — durability', () => {
  test('a failed flush re-queues and persists', async () => {
    rn.__reset()
    mockFetch({ status: 500 })
    const { t, storage } = await start()
    await t._flush()
    const queued = JSON.parse(storage.store['@nohmo_queue'])
    assert.ok(queued.length > 0, '5xx dropped the batch instead of keeping it')
    assert.ok(queued.some(e => e.event === 'APP_INSTALL'))
  })

  test('events outliving the process are restored and delivered', async () => {
    rn.__reset()
    mockFetch({ status: 500 })
    const { storage } = await start()          // first run: nothing gets through
    assert.ok(storage.store['@nohmo_queue'])

    const calls = mockFetch()                  // second run: network is back
    const t2 = new NohmoRNTracker({
      projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage,
    })
    trackers.push(t2)
    await t2.init()
    await t2._flush()

    const events = calls.events()
    assert.ok(events.some(e => e.event === 'APP_INSTALL'),
      'the install from the previous process was lost')
    // The flag was written, so the second run must not mint a second install.
    assert.equal(events.filter(e => e.event === 'APP_INSTALL').length, 1)
  })
})

describe('React Native tracker — crash reporting', () => {
  test('a stored native crash is drained and attributed to its own run', async () => {
    rn.__reset()
    rn.NativeModules.NohmoCrash = {
      installCrashHandler: () => {},
      setSessionContext: () => {},
      getStoredCrashes: async () => ([{
        platform: 'android', type: 'uncaught_exception',
        message: 'java.lang.IllegalStateException: boom', stack: 'at com.example.Foo',
        thread: 'main', sessionId: 'sess_crashed_run', screen: 'Checkout',
        ts: 1700000000000,
      }]),
    }
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()

    const crash = calls.events().find(e => e.event === 'APP_CRASH')
    assert.ok(crash, 'the stored native crash was never reported')
    assert.equal(crash.sessionId, 'sess_crashed_run')
    assert.equal(crash.ts, 1700000000000)
    assert.equal(crash.page, 'Checkout')
    assert.equal(crash.data.kind, 'native')
    assert.equal(crash.data.crashedAt, 1700000000000)
  })

  test('no stored crashes means no APP_CRASH', async () => {
    rn.__reset()
    rn.NativeModules.NohmoCrash = {
      installCrashHandler: () => {}, setSessionContext: () => {},
      getStoredCrashes: async () => [],
    }
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()
    assert.equal(calls.events().filter(e => e.event === 'APP_CRASH').length, 0)
  })
})

describe('React Native tracker — screens and lifecycle', () => {
  test('leaving a screen reports time spent on it', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    t.trackScreenView('Home')
    t.sessionStart = Date.now() - 4000        // stand in for four seconds on Home
    t.trackScreenView('Cart')
    await t._flush()

    const events = calls.events()
    const spent = events.find(e => e.event === 'TIME_SPENT')
    assert.ok(spent, 'no TIME_SPENT on leaving a screen')
    assert.equal(spent.data.screen, 'Home')
    assert.ok(spent.data.seconds >= 4)
    assert.deepEqual(
      events.filter(e => e.event === 'SCREEN_VIEW').map(e => e.data.screen),
      ['Home', 'Cart'])
  })

  test('the active event at launch does not start a second session', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    const launchSession = t.sessionId
    // AppState reports 'active' moments after launch. Acting on it stranded
    // APP_INSTALL alone in a session with no other activity, and made the real
    // first session look like a return visit.
    rn.__appState('active')
    await t._flush()

    assert.equal(t.sessionId, launchSession, 'launch minted a second session')
    const events = calls.events()
    assert.equal(events.filter(e => e.event === 'APP_OPEN').length, 1)
    const install = events.find(e => e.event === 'APP_INSTALL')
    const open = events.find(e => e.event === 'APP_OPEN')
    assert.equal(install.sessionId, open.sessionId,
      'the install landed in a different session from the open')
  })

  test('a transient inactive state is not a backgrounding', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    const before = t.sessionId
    rn.__appState('inactive')   // iOS: Control Centre, notification shade
    rn.__appState('active')
    await t._flush()

    assert.equal(t.sessionId, before, 'a glance at Control Centre split the session')
    assert.equal(calls.events().filter(e => e.event === 'APP_BACKGROUND').length, 0)
  })

  test('backgrounding then returning starts a new session', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    const first = t.sessionId
    t.sessionStart = Date.now() - 3000
    rn.__appState('background')
    rn.__appState('active')
    await t._flush()

    const events = calls.events()
    assert.ok(events.some(e => e.event === 'APP_BACKGROUND'))
    assert.notEqual(t.sessionId, first, 'returning did not mint a new session')
    assert.ok(events.filter(e => e.event === 'APP_OPEN').length >= 2)
  })
})
