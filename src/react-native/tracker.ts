import { AppState, Platform, Dimensions, Linking, NativeModules } from 'react-native'
import type { NohmoRNConfig, NohmoRNEvent, NohmoStorage } from './types'

// Identifies the client library on every event, so a Flutter app and a React Native app
// both reporting platform 'android' can still be told apart server-side.
const SDK_NAME = 'react-native'
const SDK_VERSION = '__NOHMO_VERSION__'


function makeMemoryStorage(): NohmoStorage {
  const store: Record<string, string> = {}
  return {
    getItem: async (key) => store[key] ?? null,
    setItem: async (key, value) => { store[key] = value },
  }
}

const DEFAULT_HOST = 'https://www.nohmo.in'
const _p = {
  i:   '/api/tracker/identify/',
  t:   '/api/tracker/track/',
  l:   '/api/tracker/link-user/',
  pt:  '/api/tracker/push-token/',
  a:   '/api/tracker/attribute/',
  inv: '/api/tracker/invite-link/',
}

const KEYS = {
  deviceId:     '@nohmo_did',
  userId:       '@nohmo_uid',
  firstOpen:    '@nohmo_first',
  installAttr:  '@nohmo_install_attr',
  deepLink:     '@nohmo_deeplink',
  pendingCrash: '@nohmo_pending_crash',
  // Undelivered events, so a batch survives the process being killed. Without this the
  // queue was memory-only: an APP_INSTALL sat there for up to flushInterval ms and was
  // lost for good if the app closed first — and because the firstOpen flag had already
  // been written, it was never re-sent. First launch is exactly when that happens most
  // (cold start, cold network, highest chance the user bounces), so the loss landed
  // squarely on installs.
  queue:        '@nohmo_queue',
}

// Cap on events held in persistent storage. Bounds how much a long offline stretch can
// write; the newest are kept, since an ancient un-flushed event is the least useful.
const MAX_PERSISTED_EVENTS = 500

function genId(prefix: string) {
  return `${prefix}_` + Math.random().toString(36).slice(2, 14) + Date.now().toString(36)
}

/**
 * Attribution exactly as it appeared in the URL — `utm_source`, `ref`, … — with
 * no renaming. This shape is what the INSTALL_ATTRIBUTED event body and
 * `install_utm` carry, because the dashboard's journey view renders that event
 * by reading `data.utm_source` directly.
 */
function parseRawUtmParams(url: string | null): Record<string, string> {
  if (!url) return {}
  try {
    const params = new URLSearchParams(url.includes('?') ? url.split('?')[1] : '')
    const utm: Record<string, string> = {}
    params.forEach((v, k) => {
      if (k.startsWith('utm_') || k === 'ref') utm[k] = v
    })
    return utm
  } catch {
    return {}
  }
}

/**
 * Session attribution, in the shape ingestion actually reads: `source`,
 * `medium`, `campaign`, `term`, `content` — not the raw `utm_*` query names.
 *
 * This used to return the raw names, which meant process_events read
 * `utm.source` off an object that only had `utm_source` and quietly wrote a
 * blank source onto every mobile session. The web SDK has always sent the bare
 * shape (see core/utm.ts); this brings React Native in line with it.
 *
 * A custom attribution param (`?ref=partner`) wins over utm_source/utm_medium,
 * matching the web SDK; campaign, term and content are kept either way.
 */
function parseDeepLinkUtm(url: string | null): Record<string, string> {
  const raw = parseRawUtmParams(url)
  if (Object.keys(raw).length === 0) return {}

  const utm: Record<string, string> = {}
  const put = (key: string, value?: string) => { if (value) utm[key] = value }
  put('source', raw.utm_source)
  put('medium', raw.utm_medium)
  put('campaign', raw.utm_campaign)
  put('term', raw.utm_term)
  put('content', raw.utm_content)

  if (raw.ref) {
    utm.source = raw.ref
    utm.medium = 'ref'
    // Only ever set when true — the backend coerces this with a plain
    // truthiness check, so a literal 'false' would read as true.
    utm._custom = '1'
  }
  return utm
}

// Pull the deep-link destination out of an incoming link URL — either an explicit
// ?dlv=<value> param (what Nohmo Smart Links carry) or the path of a custom-scheme
// URL (e.g. yourapp://product/123 → "product/123"). Used for DIRECT deep linking
// when the app is already installed and opened via a link.
function parseDeepLinkValue(url: string | null): string {
  if (!url) return ''
  try {
    const qs = url.includes('?') ? url.split('?')[1] : ''
    const dlv = new URLSearchParams(qs).get('dlv')
    if (dlv) return dlv
    const schemeMatch = url.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i)
    if (schemeMatch) return schemeMatch[1].split('?')[0].replace(/\/+$/, '')
    return ''
  } catch {
    return ''
  }
}

type PartialEvent = Omit<NohmoRNEvent, 'deviceId'>

export class NohmoRNTracker {
  private config: Required<NohmoRNConfig>
  private storage: NohmoStorage
  private deviceId: string | null = null
  private userId: string | null = null
  private sessionId: string
  private currentScreen = ''
  private sessionStart = Date.now()
  private queue: NohmoRNEvent[] = []
  private pendingEvents: PartialEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null
  private initResolve: () => void = () => {}
  private readonly initPromise: Promise<void>
  private initStarted = false
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private deepLinkUtm: Record<string, string> = {}
  private installAttr: Record<string, string> = {}
  private installAttrAttempted = false
  // Distinct from installAttrAttempted: that one is set even when the auto-read
  // found nothing, to stop the empty probabilistic ping repeating. This one only
  // becomes true once a real referrer string has been forwarded.
  private installReferrerSent = false
  // Whether we have actually been backgrounded. Without this, the 'active'
  // AppState event that fires right after launch is treated as a return from
  // background: every cold start minted a second session and a second APP_OPEN,
  // stranding APP_INSTALL alone in a session with no other activity.
  private backgrounded = false
  private inviteCache: Record<string, string> = {}
  // Resolved deep-link destination (OneLink-style) — from a direct link when the app
  // is already installed, or restored from the install match (deferred deep linking).
  private deepLink: string | null = null
  private deepLinkListeners: ((value: string) => void)[] = []
  private linkingSub: { remove: () => void } | null = null
  private prevErrorHandler: ((error: Error, isFatal?: boolean) => void) | null = null

  constructor(config: NohmoRNConfig) {
    this.config = {
      flushInterval: 5000,
      debug: false,
      autoAppLifecycle: true,
      autoErrors: true,
      appVersion: '',
      storage: makeMemoryStorage(),
      host: DEFAULT_HOST,
      ...config,
    }
    this.storage = this.config.storage
    this.sessionId = genId('sess')
    this.initPromise = new Promise(r => { this.initResolve = r })
  }

  /**
   * Idempotent. A second call returns the first call's promise instead of running again.
   *
   * Without this guard two concurrent init()s — a double-mounted provider, StrictMode, a
   * host app calling init twice — both read firstOpen as null across the await below,
   * both wrote it, and both sent APP_INSTALL. That produced duplicate installs
   * milliseconds apart (and duplicate /identify calls, duplicate APP_OPEN, and a leaked
   * flush timer, since the second setInterval overwrote the handle the first one needed
   * to be cleared).
   */
  async init(): Promise<void> {
    if (this.initStarted) return this.initPromise
    this.initStarted = true
    try {
      // Read persisted IDs
      const [storedDeviceId, storedUserId, firstOpenDone, initialUrl, storedInstallAttr, storedCrash, storedQueue] = await Promise.all([
        this.storage.getItem(KEYS.deviceId),
        this.storage.getItem(KEYS.userId),
        this.storage.getItem(KEYS.firstOpen),
        Linking.getInitialURL(),
        this.storage.getItem(KEYS.installAttr),
        this.storage.getItem(KEYS.pendingCrash),
        this.storage.getItem(KEYS.queue),
      ])

      // Events that outlived a previous process. Restored first so they keep their
      // place at the front of the queue and their original timestamps.
      if (storedQueue) {
        try {
          const restored = JSON.parse(storedQueue) as NohmoRNEvent[]
          if (Array.isArray(restored) && restored.length) {
            this.queue.unshift(...restored)
            this._log(`Restored ${restored.length} unsent events`)
          }
        } catch { /* corrupt payload — drop it rather than fail init */ }
      }

      this.deepLinkUtm = parseDeepLinkUtm(initialUrl)
      // DIRECT deep link: the app was opened via a link that carries a destination
      // (universal/app link or custom scheme) — resolve it immediately.
      const directValue = parseDeepLinkValue(initialUrl)
      if (directValue) this._resolveDeepLink(directValue, 'direct')
      // Restore a destination resolved on a previous run (e.g. a deferred deep link
      // that hadn't been consumed by a listener yet).
      const storedDeepLink = await this.storage.getItem(KEYS.deepLink)
      if (storedDeepLink && !this.deepLink) this.deepLink = storedDeepLink
      // Keep resolving destinations from links opened while the app is running.
      this.linkingSub = Linking.addEventListener('url', ({ url }) => {
        const v = parseDeepLinkValue(url)
        if (v) this._resolveDeepLink(v, 'direct')
      })
      if (storedInstallAttr) {
        try { this.installAttr = JSON.parse(storedInstallAttr) } catch { /* ignore */ }
      }

      // Device ID — generate once, persist forever
      let deviceId = storedDeviceId ?? genId('did')
      if (!storedDeviceId) await this.storage.setItem(KEYS.deviceId, deviceId)

      this.userId = storedUserId ?? null

      // Identify with backend
      try {
        const screen = Dimensions.get('screen')
        const res = await fetch(`${this.config.host}${_p.i}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
          body: JSON.stringify({
            deviceId,
            knownUserId: this.userId ?? undefined,
            platform: Platform.OS,
            appVersion: this.config.appVersion,
            osVersion: `${Platform.OS} ${Platform.Version}`,
            deviceInfo: {
              type: 'mobile',
              os: Platform.OS,
              browser: 'native',
              browserVersion: this.config.appVersion,
              screenW: screen.width,
              screenH: screen.height,
              viewportW: screen.width,
              viewportH: screen.height,
              pixelRatio: screen.scale,
              language: 'en',
              timezone: (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function')
                ? Intl.DateTimeFormat().resolvedOptions().timeZone
                : 'UTC',
              touch: true,
              platform: Platform.OS,
              appVersion: this.config.appVersion,
            },
          }),
        })
        const json = await res.json() as { success: boolean; data?: { deviceId?: string; userId?: string } }
        const data = json.data ?? {}
        deviceId = data.deviceId ?? deviceId
        if (data.userId) this.userId = data.userId
      } catch {
        // fallback to local deviceId
      }

      this.deviceId = deviceId
      await this.storage.setItem(KEYS.deviceId, deviceId)

      // Drain buffered pre-init events
      for (const e of this.pendingEvents) {
        this.queue.push({ ...e, deviceId , sdk: SDK_NAME, sdkVersion: SDK_VERSION })
      }
      this.pendingEvents = []
      if (this.queue.length) this._schedulePersist()

      // Report a fatal crash recorded on the previous run, attributed back to the
      // session/time it actually happened in (so it lands in the right journey).
      // A fatal JS crash in a release build also aborts the native process, so we
      // remember its (session, ts) to suppress the duplicate native record below.
      let jsCrashHint: { ts?: number; sessionId?: string } | null = null
      if (storedCrash) {
        try {
          const c = JSON.parse(storedCrash) as {
            message?: string; stack?: string; screen?: string; sessionId?: string; ts?: number
          }
          jsCrashHint = { ts: c.ts, sessionId: c.sessionId }
          this._enqueueRaw('APP_CRASH', {
            kind: 'fatal',
            message: c.message ?? 'Unknown crash',
            stack: c.stack ?? '',
            isFatal: true,
            screen: c.screen ?? '',
            crashedAt: c.ts ?? null,
          }, { sessionId: c.sessionId, ts: c.ts, screen: c.screen })
        } catch { /* corrupt payload — ignore */ }
        await this.storage.setItem(KEYS.pendingCrash, '') // clear (shim has no removeItem)
      }

      // Native (Android/iOS) crashes captured by the NohmoCrash module on a
      // previous run — drain and report, attributed to the run they happened in.
      if (this.config.autoErrors) {
        await this._drainNativeCrashes(jsCrashHint)
      }

      // Track install (only on very first open).
      //
      // Ordering matters and used to be wrong: the flag was written first, and the event
      // went into a memory-only queue. Anything that ended the process before the next
      // flush lost the install permanently, because the flag said it had been reported.
      // Now the event is made durable FIRST and the flag is written only once it is
      // safely on disk, so the worst case is a duplicate-on-retry (which the backend
      // de-duplicates) rather than a silent loss.
      if (!firstOpenDone) {
        this.send('APP_INSTALL', {
          platform: Platform.OS,
          appVersion: this.config.appVersion,
          osVersion: String(Platform.Version),
        })
        await this._persistQueue()
        await this.storage.setItem(KEYS.firstOpen, '1')

        // Attempt attribution on all platforms:
        //   Android — reads Play Store referrer via native module (deterministic)
        //   iOS     — reads pasteboard token written by the Nohmo click-link page (deterministic)
        //   Both    — fall back to a backend attribution ping for probabilistic IP matching
        await this._autoReadInstallReferrer()
      }

      // Track open
      this.send('APP_OPEN', {
        platform: Platform.OS,
        appVersion: this.config.appVersion,
      })

      // App lifecycle
      if (this.config.autoAppLifecycle) {
        this.appStateSubscription = AppState.addEventListener('change', this._onAppStateChange)
      }

      // JS error / crash capture via the RN global error handler
      if (this.config.autoErrors && typeof ErrorUtils !== 'undefined') {
        this.prevErrorHandler = ErrorUtils.getGlobalHandler()
        ErrorUtils.setGlobalHandler(this._onGlobalError)
      }

      // Native crash capture (Android Java/Kotlin, iOS Obj-C + signals):
      // install the native handlers and seed the current session/screen so a
      // native crash can be tied back to the journey that led to it.
      if (this.config.autoErrors) {
        try { this._nativeCrash?.installCrashHandler?.() } catch { /* native module absent */ }
        this._syncCrashContext()
      }

      // Flush timer
      this.flushTimer = setInterval(() => this._flush(), this.config.flushInterval)

      this.initResolve()
      this._log('Nohmo RN initialized', { deviceId, userId: this.userId })
    } catch (err) {
      this.initResolve()
      console.error('[Nohmo RN] Init failed:', err)
    }
  }

  send(event: string, data: Record<string, unknown> = {}) {
    const partial: PartialEvent = {
      userId: this.userId,
      sessionId: this.sessionId,
      event,
      data,
      screen: this.currentScreen,
      referrer: '',
      ts: Date.now(),
      platform: Platform.OS as 'ios' | 'android',
      appVersion: this.config.appVersion,
      ...(Object.keys(this.deepLinkUtm).length > 0 ? { utm: this.deepLinkUtm } : {}),
      ...(Object.keys(this.installAttr).length > 0 ? { install_utm: this.installAttr } : {}),
    }

    if (!this.deviceId) {
      this.pendingEvents.push(partial)
      this._log('Buffered pre-init event:', event)
      return
    }

    this.queue.push({ ...partial, deviceId: this.deviceId , sdk: SDK_NAME, sdkVersion: SDK_VERSION })
    this._schedulePersist()
    this._log('Event queued:', event)
  }

  trackScreenView(screenName: string) {
    const prev = this.currentScreen
    if (prev && prev !== screenName) {
      const secs = Math.round((Date.now() - this.sessionStart) / 1000)
      if (secs > 0) {
        this.send('TIME_SPENT', { screen: prev, seconds: secs })
      }
    }
    this.currentScreen = screenName
    this.sessionStart = Date.now()
    this._syncCrashContext()
    this.send('SCREEN_VIEW', { screen: screenName })
  }

  trackConversion(slug: string, properties: Record<string, unknown> = {}) {
    this.send('CONVERSION', { slug, ...properties })
  }

  /**
   * Build a short, shareable Nohmo attribution link for "invite a friend" flows.
   * Share THIS (not the raw store URL) so installs are attributed back to the
   * sharer: the current linked user id rides along as utm_content, so you can
   * see who referred whom. Returns a tidy short URL (https://www.nohmo.in/api/l/
   * <code>); the same user + options always resolves to the same code. Falls back
   * to the full click URL if the device is offline. Call linkUser first so the
   * referrer is captured.
   *
   * @example
   *   const link = await nohmo.buildInviteLink({ channel: 'whatsapp' })
   *   Share.share({ message: `Join me! ${link}` })
   */
  async buildInviteLink(opts: { channel?: string; campaign?: string; source?: string } = {}): Promise<string> {
    const source = opts.source || 'referral'
    const key = `${source}|${opts.channel || ''}|${opts.campaign || ''}|${this.userId || ''}`
    if (this.inviteCache[key]) return this.inviteCache[key]

    try {
      const res = await fetch(`${this.config.host}${_p.inv}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
        body: JSON.stringify({
          source,
          medium: opts.channel || '',
          campaign: opts.campaign || '',
          content: this.userId || '',
        }),
      })
      const data = await res.json()
      if (data && data.shortCode) {
        const url = `${this.config.host}/api/l/${data.shortCode}/`
        this.inviteCache[key] = url
        return url
      }
    } catch (err) {
      this._log('buildInviteLink: short link unavailable, using full URL:', err)
    }

    // Offline / error fallback — the long but always-working click URL
    return this._fullInviteLink(opts)
  }

  private _fullInviteLink(opts: { channel?: string; campaign?: string; source?: string }): string {
    const parts: string[] = []
    const add = (key: string, value?: string | null) => {
      if (value) parts.push(`${key}=${encodeURIComponent(value)}`)
    }
    add('utm_source', opts.source || 'referral')
    add('utm_medium', opts.channel)
    add('utm_campaign', opts.campaign)
    add('utm_content', this.userId)
    const qs = parts.length ? `?${parts.join('&')}` : ''
    return `${this.config.host}/api/click/${this.config.projectId}/${qs}`
  }

  async linkUser(userId: string, email?: string, meta?: Record<string, unknown>): Promise<void> {
    await this.initPromise
    this.userId = userId
    await this.storage.setItem(KEYS.userId, userId)
    this._flush()

    try {
      await fetch(`${this.config.host}${_p.l}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
        body: JSON.stringify({
          deviceId: this.deviceId,
          userId,
          email: email ?? '',
          meta: meta ?? {},
        }),
      })
      this.send('USER_LINKED', { userId, email })
      this._log('User linked:', userId)
    } catch (err) {
      console.error('[Nohmo RN] linkUser failed:', err)
    }
  }

  async setInstallReferrer(referrerString: string): Promise<void> {
    // Skip the await when deviceId is already set — avoids a deadlock when this
    // is called from within init() via _autoReadInstallReferrer (initResolve()
    // hasn't fired yet at that point, so awaiting initPromise would hang forever).
    if (!this.deviceId) await this.initPromise
    if (!referrerString) return
    // Guard on whether a REAL referrer has already gone out, not on whether the
    // auto-read merely ran. On first open _autoReadInstallReferrer sets
    // installAttrAttempted even when it found nothing, which silently swallowed
    // every manual setInstallReferrer() call on the one launch where install
    // attribution is still possible. Re-sending is safe: the backend returns the
    // cached attribution once a device already has one.
    if (this.installReferrerSent) return
    this.installReferrerSent = true
    this.installAttrAttempted = true

    // Raw `utm_*` names here, not the normalised ones: this map becomes the
    // INSTALL_ATTRIBUTED body and `install_utm`, and the dashboard reads
    // `data.utm_source` off it.
    const parsed = parseRawUtmParams('?' + referrerString)
    if (Object.keys(parsed).length > 0) {
      this.installAttr = parsed
      await this.storage.setItem(KEYS.installAttr, JSON.stringify(parsed))
      this.send('INSTALL_ATTRIBUTED', { ...parsed })
      this._log('Install attributed:', parsed)
    }

    // Always forward the raw string — backend extracts nohmo_click for deterministic matching
    // even when the referrer contains no utm_* params. The response carries the
    // deferred deep-link destination (if the matched click had one).
    try {
      const res = await fetch(`${this.config.host}${_p.a}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
        body: JSON.stringify({
          deviceId: this.deviceId,
          installReferrer: referrerString,
          platform: Platform.OS,
        }),
      })
      const dlv = (await res.json())?.data?.deepLinkValue
      if (dlv && !this.deepLink) this._resolveDeepLink(dlv, 'deferred')
    } catch { /* non-critical */ }
  }

  // Record a resolved destination, persist it, emit a DEEP_LINK event, and notify
  // any onDeepLink listeners. `source` is 'direct' (app already installed) or
  // 'deferred' (restored after install).
  private _resolveDeepLink(value: string, source: 'direct' | 'deferred') {
    if (!value || this.deepLink === value) return
    this.deepLink = value
    this.storage.setItem(KEYS.deepLink, value).catch(() => {})
    this.send('DEEP_LINK', { value, source })
    for (const cb of this.deepLinkListeners) {
      try { cb(value) } catch { /* listener threw */ }
    }
    this._log('Deep link resolved:', { value, source })
  }

  /** The resolved deep-link destination (e.g. "product/123"), or null if none. */
  getDeepLink(): string | null {
    return this.deepLink
  }

  /**
   * Route users to the screen a Smart Link points at — for both an installed app
   * opened via a link (direct) and a new user restored after install (deferred).
   * Fires immediately if a destination is already resolved, then on every future
   * one. Returns an unsubscribe function.
   *
   * @example
   *   nohmo.onDeepLink(dest => navigation.navigate(...routeFor(dest)))
   */
  onDeepLink(cb: (value: string) => void): () => void {
    this.deepLinkListeners.push(cb)
    if (this.deepLink) { try { cb(this.deepLink) } catch { /* listener threw */ } }
    return () => {
      const i = this.deepLinkListeners.indexOf(cb)
      if (i >= 0) this.deepLinkListeners.splice(i, 1)
    }
  }

  /** Manually resolve a destination from an incoming link URL (if you handle Linking yourself). */
  handleUrl(url: string): void {
    const v = parseDeepLinkValue(url)
    if (v) this._resolveDeepLink(v, 'direct')
  }

  private async _autoReadInstallReferrer(): Promise<void> {
    // Android: Play Store preserves the referrer query string set by ClickView.
    // iOS: pasteboard token written by the Nohmo click-link interstitial page.
    // Both expose the same NativeModules.NohmoInstallReferrer.getReferrer() API.
    try {
      const mod = NativeModules.NohmoInstallReferrer
      if (mod?.getReferrer) {
        const referrer: string = await mod.getReferrer()
        if (referrer) {
          await this.setInstallReferrer(referrer)
          return
        }
      }
    } catch { /* native module unavailable */ }

    // Fallback: ping the attribution endpoint with no referrer string so the
    // backend can attempt probabilistic IP matching (covers iOS users who didn't
    // tap the interstitial button, or any platform without the native module).
    if (this.installAttrAttempted) return
    this.installAttrAttempted = true
    try {
      const res = await fetch(`${this.config.host}${_p.a}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
        body: JSON.stringify({
          deviceId: this.deviceId,
          installReferrer: '',
          platform: Platform.OS,
        }),
      })
      // A probabilistic match can still carry a deferred deep-link destination.
      const dlv = (await res.json())?.data?.deepLinkValue
      if (dlv && !this.deepLink) this._resolveDeepLink(dlv, 'deferred')
    } catch { /* non-critical */ }
  }

  async registerPushToken(token: string): Promise<void> {
    await this.initPromise
    if (!token || !this.deviceId) return
    try {
      await fetch(`${this.config.host}${_p.pt}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
        body: JSON.stringify({ deviceId: this.deviceId, pushToken: token }),
      })
      this._log('Push token registered')
    } catch (err) {
      this._log('registerPushToken failed:', err)
    }
  }

  // RN global error handler. Fires for both caught-by-RN and fatal JS errors.
  // Fatal → persist for next-launch reporting (a fetch won't finish as the app
  // dies). Non-fatal → send immediately. Always defer to the previous handler
  // so the app still red-boxes / crashes normally.
  private _onGlobalError = (error: Error, isFatal?: boolean) => {
    try {
      const message = error?.message ? String(error.message).slice(0, 1000) : 'Unknown error'
      const stack = error?.stack ? String(error.stack).slice(0, 4000) : ''
      if (isFatal) {
        this.storage.setItem(KEYS.pendingCrash, JSON.stringify({
          message, stack, screen: this.currentScreen, sessionId: this.sessionId, ts: Date.now(),
        })).catch(() => { /* best effort */ })
      } else {
        this.send('JS_ERROR', { kind: 'error', message, stack, isFatal: false, screen: this.currentScreen })
      }
    } catch { /* our handler must never throw */ }
    this.prevErrorHandler?.(error, isFatal)
  }

  // Enqueue an event with explicit session/ts/screen overrides — used to replay a
  // persisted crash so it's attributed to the run it happened in, not this launch.
  private _enqueueRaw(
    event: string,
    data: Record<string, unknown>,
    opts: { sessionId?: string; ts?: number; screen?: string },
  ) {
    const partial: PartialEvent = {
      userId: this.userId,
      sessionId: opts.sessionId || this.sessionId,
      event,
      data,
      screen: opts.screen ?? this.currentScreen,
      referrer: '',
      ts: opts.ts || Date.now(),
      platform: Platform.OS as 'ios' | 'android',
      appVersion: this.config.appVersion,
      ...(Object.keys(this.deepLinkUtm).length > 0 ? { utm: this.deepLinkUtm } : {}),
      ...(Object.keys(this.installAttr).length > 0 ? { install_utm: this.installAttr } : {}),
    }
    if (!this.deviceId) { this.pendingEvents.push(partial); return }
    this.queue.push({ ...partial, deviceId: this.deviceId , sdk: SDK_NAME, sdkVersion: SDK_VERSION })
    this._schedulePersist()
  }

  // The optional NohmoCrash native module (absent on web / Expo Go / older hosts).
  private get _nativeCrash() {
    return (NativeModules as Record<string, unknown>).NohmoCrash as {
      installCrashHandler?: () => void
      setSessionContext?: (sessionId: string, screen: string) => void
      getStoredCrashes?: () => Promise<Array<Record<string, unknown>>>
    } | undefined
  }

  // Push the current JS session/screen to native so a native crash record can be
  // attributed to the session it happened in. Fire-and-forget, never throws.
  private _syncCrashContext() {
    try { this._nativeCrash?.setSessionContext?.(this.sessionId, this.currentScreen) } catch { /* ignore */ }
  }

  // Read native crashes recorded on a previous run and emit them as APP_CRASH,
  // attributed to the original session/time. The native call consumes (deletes)
  // the records. `jsCrashHint` is the (session, ts) of a JS fatal crash already
  // reported this launch — a native record within ~4s of it is the same crash's
  // process-abort, so we skip it (the JS record has the richer stack).
  private async _drainNativeCrashes(jsCrashHint?: { ts?: number; sessionId?: string } | null) {
    let list: Array<Record<string, unknown>> | undefined
    try {
      list = await this._nativeCrash?.getStoredCrashes?.()
    } catch {
      return
    }
    if (!Array.isArray(list)) return
    for (const r of list) {
      const ts = typeof r.ts === 'number' && r.ts > 0 ? r.ts : Date.now()
      const screen = typeof r.screen === 'string' ? r.screen : ''

      // Skip the native duplicate of an already-reported fatal JS crash.
      if (jsCrashHint?.ts && Math.abs(ts - jsCrashHint.ts) < 4000) {
        const sameSession = !jsCrashHint.sessionId || !r.sessionId || r.sessionId === jsCrashHint.sessionId
        if (sameSession) continue
      }
      this._enqueueRaw('APP_CRASH', {
        kind: 'native',
        platform: r.platform ?? Platform.OS,
        nativeType: r.type ?? '',
        signal: r.signal ?? '',
        message: r.message ?? 'Native crash',
        stack: r.stack ?? '',
        thread: r.thread ?? '',
        screen,
        crashedAt: ts,
      }, {
        sessionId: typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : undefined,
        ts,
        screen,
      })
    }
  }

  private _onAppStateChange = (nextState: string) => {
    // 'inactive' is deliberately not treated as backgrounding. On iOS it fires
    // transiently — Control Centre, the notification shade, a permission sheet —
    // and acting on it mints a new session every time the user glances away,
    // shredding real sessions into one-event fragments. 'background' is the
    // state that actually means backgrounded, and it fires on both platforms.
    if (nextState === 'background') {
      if (this.backgrounded) return
      this.backgrounded = true
      const secs = Math.round((Date.now() - this.sessionStart) / 1000)
      if (secs > 0) {
        this.send('APP_BACKGROUND', {
          platform: Platform.OS,
          sessionDurationSecs: secs,
          screen: this.currentScreen,
        })
      }
      // Persist before flushing: backgrounding is the last moment we are reliably given
      // before the OS may kill the process, and the flush might not complete.
      void this._persistQueue().then(() => this._flush())
    } else if (nextState === 'active') {
      // Only a genuine return from background starts a new session; the
      // 'active' that arrives moments after launch is not one.
      if (!this.backgrounded) return
      this.backgrounded = false
      this.sessionId = genId('sess')
      this.sessionStart = Date.now()
      this._syncCrashContext()
      this.send('APP_OPEN', { platform: Platform.OS, appVersion: this.config.appVersion })
    }
  }

  /**
   * Write the pending queue to storage so it survives the process ending.
   *
   * Throttled: enqueueing is hot (every screen view, every tap) and a storage write per
   * event would be wasteful. `immediate` skips the throttle for the cases that must not
   * be lost — the install, and going to background.
   */
  private _schedulePersist() {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this._persistQueue()
    }, 1000)
  }

  private async _persistQueue(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    try {
      const tail = this.queue.slice(-MAX_PERSISTED_EVENTS)
      await this.storage.setItem(KEYS.queue, tail.length ? JSON.stringify(tail) : '')
    } catch { /* storage full or unavailable — in-memory delivery still works */ }
  }

  private async _flush() {
    if (!this.queue.length) return
    const batch = this.queue.splice(0)

    const body = JSON.stringify({
      events: batch.map(e => ({
        deviceId: e.deviceId,
        userId: e.userId,
        sessionId: e.sessionId,
        event: e.event,
        data: e.data,
        page: e.screen,
        referrer: e.referrer,
        ts: e.ts,
        // The queued event has always carried this; it was dropped here, on the way out.
        // Ingestion needs it: when /track arrives before a Device row exists — the very
        // first launch, or any launch where /identify failed — the backend seeds the
        // device from the model default 'web'. It then denormalises 'web' onto these
        // events, and an APP_INSTALL stamped 'web' is invisible to every mobile install
        // metric. Sending the platform lets the device be created correctly the first
        // time, instead of relying on a later /identify to come back and repair it.
        platform: e.platform,
        // Also stamped on the queued event and also dropped here until now.
        // Ingestion reads the SDK name off the event batch (not off /identify),
        // so without these every React Native device was indistinguishable from
        // a Flutter one and `sdk` stayed empty on every Device row.
        sdk: e.sdk,
        sdkVersion: e.sdkVersion,
        ...(e.utm ? { utm: e.utm } : {}),
        ...(e.install_utm ? { install_utm: e.install_utm } : {}),
      })),
      apiKey: this.config.apiKey,
    })

    try {
      const res = await fetch(`${this.config.host}${_p.t}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      // A 5xx means the server never took the batch, so treat it like a network failure
      // and keep the events. Only a response the server actually accepted clears them.
      // Previously any response at all — including a 502 from a proxy — was treated as
      // success and the batch was dropped.
      if (!res.ok && res.status >= 500) throw new Error(`HTTP ${res.status}`)
      this._log(`Flushed ${batch.length} events`)
      await this._persistQueue()   // delivered — drop them from durable storage too
    } catch (err) {
      // Re-queue on failure, and persist so the retry survives the process ending.
      this.queue.unshift(...batch)
      this._log('Flush failed, re-queued:', err)
      await this._persistQueue()
    }
  }

  private _log(...args: unknown[]) {
    if (this.config.debug) console.log('[Nohmo RN]', ...args)
  }

  destroy() {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
    void this._persistQueue()
    this.appStateSubscription?.remove()
    this.linkingSub?.remove()
    this.deepLinkListeners = []
    if (this.prevErrorHandler && typeof ErrorUtils !== 'undefined') {
      ErrorUtils.setGlobalHandler(this.prevErrorHandler)
    }
    this._flush()
  }
}
