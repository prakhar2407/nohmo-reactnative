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
      __hasAppStateHandler: () => appStateHandler !== null,
      __reset: () => { stub.__initialUrl = null; stub.NativeModules = {} },
    }
    module.exports = stub
  `)

  // IS_DEV is captured at module scope, so __DEV__ must exist before the require.
  // Safe for every other test: the wiring check also needs 30s of elapsed session,
  // which no test reaches.
  global.__DEV__ = true

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
function mockFetch({ status = 200, body = {}, statusFor } = {}) {
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
    // A rejected call still answers with parseable JSON — that is exactly why
    // ignoring the status looked like success for so long.
    const st = statusFor?.(String(url)) ?? status
    return { ok: st < 400, status: st, json: async () => payload }
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

  test('install attribution does not ride on every other event', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t.setInstallReferrer('utm_source=google-play&utm_medium=organic')
    t.trackScreenView('/cart')
    t.send('ADD_TO_CART')
    await t._flush()

    // The attribution itself is still reported, as its own event.
    const attributed = calls.events().find(e => e.event === 'INSTALL_ATTRIBUTED')
    assert.ok(attributed, 'no INSTALL_ATTRIBUTED')

    // But it used to be stamped onto every event for the life of the install —
    // roughly 88 bytes on every SCREEN_VIEW, PRESS and CONVERSION — and
    // ingestion never read the field. It is not referenced anywhere in the
    // backend or the dashboard, and is not even stored, because only `data` is
    // persisted as JSON. The attribution is already durable server-side in
    // InstallAttribution, keyed to the device.
    for (const e of calls.events()) {
      assert.equal(e.install_utm, undefined,
        `${e.event} still carries a field nothing reads`)
    }
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
    t.screenStart = Date.now() - 4000         // stand in for four seconds on Home
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

  test('coming back after a long absence starts a new session', async () => {
    // A genuine return — the app was away longer than sessionTimeout. Anything
    // shorter resumes instead, which the 'a moment in another app' test covers;
    // this one guards the other side of that line.
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start({ sessionTimeout: 50 })
    const first = t.sessionId
    t.sessionStart = Date.now() - 3000
    rn.__appState('background')
    await new Promise((r) => setTimeout(r, 90))     // longer than sessionTimeout
    rn.__appState('active')
    await t._flush()

    const events = calls.events()
    assert.ok(events.some(e => e.event === 'APP_BACKGROUND'))
    assert.notEqual(t.sessionId, first, 'a real return did not mint a new session')
    assert.ok(events.filter(e => e.event === 'APP_OPEN').length >= 2)
  })
})

/**
 * The safety net for screen tracking, which is the one failure the SDK cannot see
 * from the outside: events keep flowing, they are just all stamped with a screen the
 * user left. This check is downstream of every cause — a container the Babel plugin
 * could not instrument, Expo Router, createStaticNavigation, or nobody wiring it at
 * all — so these tests pin the signal, not any particular cause.
 */
describe('React Native tracker — screen tracking wiring check', () => {
  function captureWarn(fn) {
    const seen = []
    const orig = console.warn
    console.warn = (...a) => seen.push(a.join(' '))
    try { fn() } finally { console.warn = orig }
    return seen
  }

  test('warns once when the app is busy but the screen never changes', async () => {
    rn.__reset()
    mockFetch()
    const { t } = await start()
    // As if the session has been running a while — the check deliberately ignores a
    // burst of taps on the launch screen in the first seconds.
    t.startedAt = Date.now() - 60_000
    t.screenViewCount = 1        // launch screen captured, nothing since
    t.nonScreenEventCount = 0
    t.navWiringChecked = false

    const warnings = captureWarn(() => {
      for (let i = 0; i < 15; i++) t.send('PRESS', { text: 'Next' })
    })

    assert.equal(warnings.length, 1, 'expected exactly one warning, not one per event')
    assert.match(warnings[0], /Screen tracking does not look wired up/)
    // The warning has to carry the fix, not just the complaint.
    assert.match(warnings[0], /onNohmoStateChange/)
  })

  test('says nothing when screens are actually changing', async () => {
    rn.__reset()
    mockFetch()
    const { t } = await start()
    t.startedAt = Date.now() - 60_000
    t.screenViewCount = 0
    t.nonScreenEventCount = 0
    t.navWiringChecked = false

    const warnings = captureWarn(() => {
      t.trackScreenView('Home')
      t.trackScreenView('Cart')
      for (let i = 0; i < 15; i++) t.send('PRESS', { text: 'Next' })
    })

    assert.deepEqual(warnings, [], 'a correctly wired app was warned at')
  })

  test('the warning names a fix for apps that do not use React Navigation', async () => {
    rn.__reset()
    mockFetch()
    const { t } = await start()
    t.startedAt = Date.now() - 60_000
    t.screenViewCount = 0
    t.nonScreenEventCount = 0
    t.navWiringChecked = false

    const warnings = captureWarn(() => {
      for (let i = 0; i < 15; i++) t.send('PRESS', { text: 'Next' })
    })

    assert.equal(warnings.length, 1)
    // Advice that only mentions NavigationContainer is useless to an app routing on
    // its own state, so both paths have to be named.
    assert.match(warnings[0], /useScreenView/, 'no fix offered for a non-navigator app')
    assert.match(warnings[0], /setupWarnings: false/, 'no way to silence it was offered')
  })

  test('setupWarnings: false silences it for single-screen apps', async () => {
    rn.__reset()
    mockFetch()
    const { t } = await start({ setupWarnings: false })
    t.startedAt = Date.now() - 60_000
    t.screenViewCount = 1
    t.nonScreenEventCount = 0
    t.navWiringChecked = false

    const warnings = captureWarn(() => {
      for (let i = 0; i < 15; i++) t.send('PRESS', { text: 'Next' })
    })

    assert.deepEqual(warnings, [], 'an app that opted out was still warned at')
  })

  test('says nothing about a quiet session that simply has not navigated yet', async () => {
    rn.__reset()
    mockFetch()
    const { t } = await start()
    t.startedAt = Date.now() - 60_000
    t.screenViewCount = 1
    t.nonScreenEventCount = 0
    t.navWiringChecked = false

    // Below NAV_CHECK_MIN_EVENTS — not enough activity to conclude anything.
    const warnings = captureWarn(() => {
      for (let i = 0; i < 5; i++) t.send('PRESS', { text: 'Next' })
    })

    assert.deepEqual(warnings, [], 'warned on too little evidence')
  })
})

/** Runs `fn` with console.error captured, returning everything it logged. */
async function captureErrors(fn) {
  const original = console.error
  const lines = []
  console.error = (...args) => lines.push(args.join(' '))
  try { await fn() } finally { console.error = original }
  return lines
}

describe('React Native tracker — a rejected call is never reported as success', () => {
  // All four of these were silent. The SDK read res.json() off every response and
  // never looked at the status, so a 404 or a 401 logged success and carried on —
  // the integration was doing nothing and saying nothing.

  test('linkUser reports a rejected link instead of swallowing it', async () => {
    rn.__reset()
    mockFetch({ statusFor: (url) => (url.includes('/link-user/') ? 404 : 200) })
    const { t } = await start()

    const errors = await captureErrors(() => t.linkUser('user_42', 'a@b.com'))

    assert.ok(errors.length > 0, 'a rejected linkUser logged nothing at all')
    assert.ok(
      errors.some((l) => l.includes('404') || l.toLowerCase().includes('does not know this device')),
      `the error did not say what went wrong: ${JSON.stringify(errors)}`,
    )
  })

  test('a rejected linkUser does not emit USER_LINKED', async () => {
    rn.__reset()
    const calls = mockFetch({ statusFor: (url) => (url.includes('/link-user/') ? 404 : 200) })
    const { t } = await start()

    await captureErrors(() => t.linkUser('user_42'))
    await t._flush()

    // USER_LINKED is what the dashboard counts as "this device has a user", so
    // emitting it for a link the server refused reports a user who is not linked.
    assert.ok(
      !calls.events().some((e) => e.event === 'USER_LINKED'),
      'USER_LINKED was sent for a link the server rejected',
    )
  })

  test('an accepted linkUser still emits USER_LINKED', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()

    await t.linkUser('user_42', 'a@b.com')
    await t._flush()

    const linked = calls.events().find((e) => e.event === 'USER_LINKED')
    assert.ok(linked, 'the happy path stopped emitting USER_LINKED')
    assert.equal(linked.data.userId, 'user_42')
    assert.equal(calls.to('/link-user/').length, 1)
    assert.equal(calls.to('/link-user/')[0].body.userId, 'user_42')
  })

  test('rejected credentials are reported once, naming the fix', async () => {
    rn.__reset()
    mockFetch({ status: 401 })

    const errors = await captureErrors(async () => {
      const { t } = await start()
      await t.linkUser('user_42')
      await t.registerPushToken('tok')
    })

    const credential = errors.filter((l) => l.includes('rejected the SDK credentials'))
    assert.equal(credential.length, 1, `expected exactly one credentials error, got ${credential.length}`)
    // The message has to be actionable: three calls failing with "HTTP 401" tells
    // nobody which of projectId, apiKey or host is wrong.
    assert.ok(credential[0].includes('apiKey') && credential[0].includes('projectId'))
  })
})

describe('React Native tracker — identity survives a reinstall', () => {
  // An uninstall wipes AsyncStorage, so the device id the SDK generated is gone.
  // The backend can only recognise the returning phone by `stableId`, which React
  // Native never sent — every reinstall became a new anonymous device.

  test('identify carries the native stable id', async () => {
    rn.__reset()
    rn.NativeModules.NohmoStableId = { getStableId: async () => 'stable-abc' }
    const calls = mockFetch()
    await start()

    assert.equal(calls.to('/identify/')[0].body.stableId, 'stable-abc')
  })

  test('the same phone reports the same stable id across a reinstall', async () => {
    rn.__reset()
    rn.NativeModules.NohmoStableId = { getStableId: async () => 'stable-abc' }

    const calls = mockFetch()
    await start({}, memStorage())            // first install
    await start({}, memStorage())            // uninstall wipes storage, then reinstall

    const [first, second] = calls.to('/identify/')
    assert.notEqual(first.body.deviceId, second.body.deviceId, 'storage was not actually cleared')
    // Asserted present before being compared — two missing values are equal too,
    // which is exactly the broken state this test exists to catch.
    assert.equal(first.body.stableId, 'stable-abc', 'the first install sent no stable id')
    assert.equal(second.body.stableId, 'stable-abc',
      'the reinstall reported a different stable id, so the backend cannot match it')
  })

  test('a reinstall adopts the device id the backend matched it to', async () => {
    rn.__reset()
    rn.NativeModules.NohmoStableId = { getStableId: async () => 'stable-abc' }

    // What the server does with a known stableId: hand back the ORIGINAL device
    // id so the returning phone resumes its own history instead of starting over.
    const seen = []
    global.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      seen.push({ url: String(url), body })
      if (String(url).includes('/identify/')) {
        return { ok: true, status: 200,
          json: async () => ({ success: true, data: { deviceId: 'did_original', userId: 'user_7' } }) }
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
    }

    const storage = memStorage()
    const { t } = await start({}, storage)
    await t._flush()

    assert.equal(storage.store['@nohmo_did'], 'did_original',
      'the canonical device id was not persisted, so the next launch starts over again')
    const events = seen.filter((c) => c.url.includes('/track/')).flatMap((c) => c.body.events)
    assert.ok(events.length > 0)
    for (const e of events) {
      assert.equal(e.deviceId, 'did_original', `${e.event} was still sent under the throwaway id`)
    }
  })

  test('no stable id is sent when the native module is missing', async () => {
    rn.__reset()                              // Expo Go, or a build from before this shipped
    const calls = mockFetch()
    await start()

    // Absent, not empty: the backend treats '' as "no stable id", but sending the
    // key at all would have it match every other device that sent ''.
    assert.ok(!('stableId' in calls.to('/identify/')[0].body))
  })

  test('a native module that never answers does not hang startup', async () => {
    rn.__reset()
    rn.NativeModules.NohmoStableId = { getStableId: () => new Promise(() => {}) }
    const calls = mockFetch()

    // init() awaits the stable id, so an unresolved Keychain read would otherwise
    // mean an app that never finishes starting.
    await start()

    assert.equal(calls.to('/identify/').length, 1, 'init never reached identify')
    assert.ok(!('stableId' in calls.to('/identify/')[0].body))
  })
})

describe('React Native tracker — a failed link is retried, not lost', () => {
  test('a link the server refused is re-sent on the next start', async () => {
    rn.__reset()
    const storage = memStorage()

    // Login while the link endpoint is down.
    mockFetch({ statusFor: (url) => (url.includes('/link-user/') ? 503 : 200) })
    const { t } = await start({}, storage)
    await captureErrors(() => t.linkUser('user_42'))
    assert.equal(storage.store['@nohmo_linked_uid'], undefined,
      'a refused link was recorded as confirmed')

    // Next app start, endpoint healthy. Nothing in the app calls linkUser again —
    // without the retry the user stays anonymous until they log in a second time.
    const calls = mockFetch()
    await start({}, storage)

    const links = calls.to('/link-user/')
    assert.equal(links.length, 1, 'the unconfirmed link was not retried on startup')
    assert.equal(links[0].body.userId, 'user_42')
    assert.equal(storage.store['@nohmo_linked_uid'], 'user_42')
  })

  test('a confirmed link costs no request on later starts', async () => {
    rn.__reset()
    const storage = memStorage()

    mockFetch()
    const { t } = await start({}, storage)
    await t.linkUser('user_42')

    // Reopening the app is the common case by far, so it must not re-link.
    const calls = mockFetch()
    await start({}, storage)
    assert.equal(calls.to('/link-user/').length, 0,
      'every app open re-sent a link the server had already confirmed')
  })
})

describe('React Native tracker — a refused event batch is not dropped in silence', () => {
  test('a 4xx on /track is reported', async () => {
    rn.__reset()
    mockFetch({ statusFor: (url) => (url.includes('/track/') ? 400 : 200) })

    // /track authenticates by body rather than header, so it can be refused on its
    // own while identify still succeeds. A 4xx there is not retried — the batch is
    // gone — which makes saying so the only thing standing between the developer
    // and an integration that records nothing and complains about nothing.
    const errors = await captureErrors(async () => {
      const { t } = await start()
      await t._flush()
    })

    assert.ok(
      errors.some((l) => l.includes('event delivery') && l.includes('400')),
      `a refused event batch was dropped without a word: ${JSON.stringify(errors)}`,
    )
  })

  test('a 5xx on /track still re-queues instead of reporting a drop', async () => {
    rn.__reset()
    const calls = mockFetch({ statusFor: (url) => (url.includes('/track/') ? 503 : 200) })
    const { t } = await start()
    await t._flush()

    // The existing contract: the server never took the batch, so the events stay.
    // Reporting must not have quietly changed that into a drop.
    const before = calls.to('/track/').length
    await t._flush()
    assert.ok(calls.to('/track/').length > before, 'the batch was dropped instead of retried')
  })
})

describe('React Native tracker — lifecycle under a remount', () => {
  // React StrictMode mounts, unmounts and remounts every effect in development,
  // and NohmoProvider builds a tracker in that effect. init() is async, so the
  // first tracker is destroyed while its identify is still in flight and then
  // carries on setting up timers, listeners and events for a tracker nobody
  // holds. Everything here is what that produces on a phone.

  test('a tracker destroyed mid-init leaves no flush timer behind', async () => {
    rn.__reset()
    mockFetch()
    const t = new NohmoRNTracker({ projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage: memStorage() })
    trackers.push(t)
    const initing = t.init()
    t.destroy()               // the StrictMode cleanup, before init resolves
    await initing

    // A live interval here fires for the life of the app, on a tracker that was
    // thrown away — and it is invisible, because the events go nowhere useful.
    assert.equal(t.flushTimer, null, 'init() armed a flush timer after destroy()')
  })

  test('a tracker destroyed mid-init attaches no listeners', async () => {
    rn.__reset()
    mockFetch()
    const t = new NohmoRNTracker({ projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage: memStorage() })
    trackers.push(t)
    const initing = t.init()
    t.destroy()
    await initing

    assert.equal(t.appStateSubscription, null,
      'an AppState listener was attached after destroy() — a dead tracker still reacts to backgrounding')
  })

  test('a destroyed tracker sends nothing more', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()
    const before = calls.to('/track/').length

    t.destroy()
    t.send('after_destroy', {})
    await t._flush()

    const sentAfter = calls.to('/track/').slice(before)
      .flatMap((c) => c.body.events).filter((e) => e.event === 'after_destroy')
    assert.equal(sentAfter.length, 0, 'a destroyed tracker still delivered an event')
  })

  test('a double mount reports one install, not two', async () => {
    // APP_INSTALL is the headline mobile metric. The guard against duplicates is
    // per-tracker (initStarted), but a remount builds a SECOND tracker, so both
    // read the first-open flag as unset and both report an install.
    rn.__reset()
    const calls = mockFetch()
    const storage = memStorage()

    const first = new NohmoRNTracker({ projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage })
    trackers.push(first)
    const firstInit = first.init()
    first.destroy()
    const second = new NohmoRNTracker({ projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage })
    trackers.push(second)
    await Promise.all([firstInit, second.init()])
    await second._flush()

    const installs = calls.events().filter((e) => e.event === 'APP_INSTALL')
    assert.equal(installs.length, 1, `expected one APP_INSTALL across the remount, got ${installs.length}`)
  })
})

describe('React Native tracker — storage that fails', () => {
  test('a storage backend that throws does not stop the SDK', async () => {
    // A host app can hand us any NohmoStorage. Secure storage on a locked device,
    // a full disk, or a hot-reloaded native module all reject — and analytics must
    // not take the app down with it.
    rn.__reset()
    mockFetch()
    const hostile = {
      getItem: async () => { throw new Error('storage unavailable') },
      setItem: async () => { throw new Error('storage unavailable') },
    }
    const t = new NohmoRNTracker({ projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage: hostile })
    trackers.push(t)

    await assert.doesNotReject(() => t.init(), 'init() rejected when storage threw')
    assert.doesNotThrow(() => t.send('still_works', {}))
    await assert.doesNotReject(() => t._flush())
  })

  test('events still reach the server when storage is unusable', async () => {
    rn.__reset()
    const calls = mockFetch()
    const hostile = {
      getItem: async () => { throw new Error('nope') },
      setItem: async () => { throw new Error('nope') },
    }
    const t = new NohmoRNTracker({ projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage: hostile })
    trackers.push(t)
    await t.init()
    t.send('purchase', { amount: 99 })
    await t._flush()

    assert.ok(calls.events().some((e) => e.event === 'purchase'),
      'nothing was delivered — a device with unusable storage reports no analytics at all')
  })
})

describe('React Native tracker — a dead tracker stays dead', () => {
  test('backgrounding after destroy reports nothing', async () => {
    // AppState fires app-wide. A tracker that did not release its subscription
    // keeps reporting sessions for a screen nobody is on.
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()
    const before = calls.events().length

    t.destroy()
    rn.__appState('background')
    rn.__appState('active')
    await new Promise((r) => setTimeout(r, 30))

    const after = calls.events().slice(before).map((e) => e.event)
    assert.deepEqual(after.filter((e) => e === 'APP_BACKGROUND' || e === 'APP_OPEN'), [],
      `a destroyed tracker still reported ${after.join(', ')}`)
  })

  test('a deep link after destroy notifies nobody', async () => {
    rn.__reset()
    mockFetch()
    const { t } = await start()
    const seen = []
    t.onDeepLink((v) => seen.push(v))
    t.destroy()
    rn.__openUrl('myapp://open?nohmo_dl=/promo')
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(seen, [], 'a destroyed tracker still delivered a deep link')
  })

  test('three remounts do not stack app-state listeners', async () => {
    // Each mount must leave the app exactly as it found it, or a screen that
    // remounts often turns one backgrounding into many reports.
    rn.__reset()
    mockFetch()
    for (let i = 0; i < 3; i++) {
      const t = new NohmoRNTracker({ projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage: memStorage() })
      trackers.push(t)
      await t.init()
      t.destroy()
    }
    // The stub keeps a single handler slot and clears it on remove(); anything
    // left attached means a subscription outlived its tracker.
    assert.equal(rn.__hasAppStateHandler(), false, 'an AppState listener outlived its tracker')
  })
})

describe('React Native tracker — identity before init finishes', () => {
  test('linkUser called immediately still links', async () => {
    // Child effects run before the provider's, so an app that links on mount
    // calls this before the tracker has a deviceId. It has to wait, not drop.
    rn.__reset()
    const calls = mockFetch()
    const t = new NohmoRNTracker({ projectId: 'proj_t', apiKey: 'pk_t', host: HOST, storage: memStorage() })
    trackers.push(t)
    const linking = t.linkUser('user_early', 'a@b.com')   // before init()
    await t.init()
    await linking
    await t._flush()

    const links = calls.to('/link-user/')
    assert.equal(links.length, 1, 'the early linkUser never reached the server')
    assert.equal(links[0].body.userId, 'user_early')
    assert.ok(links[0].body.deviceId, 'linkUser went out without a deviceId')
  })
})

describe('React Native tracker — session and screen clocks', () => {
  // Both of these are already right in the Flutter SDK, whose comments say what
  // they cost when they are wrong. The React Native tracker never got them.

  test('session duration is the whole session, not the last screen', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()

    // A ten-minute session: the user has been in the app a while.
    t.sessionStart = Date.now() - 600_000
    t.currentScreen = 'Home'
    t.trackScreenView('Checkout')      // a normal navigation, moments ago
    rn.__appState('background')
    await new Promise((r) => setTimeout(r, 20))
    await t._flush()

    const bg = calls.events().find((e) => e.event === 'APP_BACKGROUND')
    assert.ok(bg, 'no APP_BACKGROUND was reported')
    assert.ok(bg.data.sessionDurationSecs > 500,
      `session reported as ${bg.data.sessionDurationSecs}s — the screen change reset the session clock, so Avg. Session Time is measuring the last screen`)
  })

  test('a moment in another app resumes the session, it does not start one', async () => {
    // Reading an OTP, approving a payment, picking a photo. Minting a session for
    // each splits one real journey into several and inflates the session count.
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    await t._flush()
    const sessionBefore = t.sessionId

    rn.__appState('background')
    await new Promise((r) => setTimeout(r, 30))
    rn.__appState('active')
    await new Promise((r) => setTimeout(r, 20))
    await t._flush()

    assert.equal(t.sessionId, sessionBefore,
      'a few seconds away started a brand-new session')
    const opens = calls.events().filter((e) => e.event === 'APP_OPEN')
    assert.equal(opens.length, 1, `expected the launch APP_OPEN only, got ${opens.length}`)
  })

  test('time spent in the background is not billed to the screen', async () => {
    rn.__reset()
    const calls = mockFetch()
    const { t } = await start()
    t.trackScreenView('Home')
    await t._flush()

    rn.__appState('background')
    // Simulate a long lunch break while backgrounded.
    t.sessionStart = Date.now() - 3_600_000
    rn.__appState('active')
    t.trackScreenView('Profile')
    await new Promise((r) => setTimeout(r, 20))
    await t._flush()

    const spent = calls.events().filter((e) => e.event === 'TIME_SPENT' && e.data.screen === 'Home')
    for (const e of spent) {
      assert.ok(e.data.seconds < 120,
        `Home was credited with ${e.data.seconds}s — the user's time in another app was billed to the screen they left open`)
    }
  })
})
