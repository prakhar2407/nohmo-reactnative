import { AutoCapture } from './autocapture'
import { ErrorCapture } from './errors'
import { getDeviceId, getDeviceInfo, getStableId } from './fingerprint'
import { EventQueue } from './queue'
import { readStore, writeStore } from './storage'
import type { NohmoConfig, NohmoEvent, NohmoState } from './types'
import { getUTMParams } from './utm'

// Identifies the client library on every event. __NOHMO_VERSION__ is replaced with the
// real package version at build time by the rollup versionPlugin.
const SDK_NAME = 'web'
const SDK_VERSION = '__NOHMO_VERSION__'

const _b = (s: string) => atob(s)
const _h = _b('aHR0cHM6Ly93d3cubm9obW8uaW4=')
const _p = {
  i: _b('L2FwaS90cmFja2VyL2lkZW50aWZ5Lw=='),
  t: _b('L2FwaS90cmFja2VyL3RyYWNrLw=='),
  l: _b('L2FwaS90cmFja2VyL2xpbmstdXNlci8='),
}

type PartialEvent = Omit<NohmoEvent, 'deviceId'>

/**
 * Last page view reported by ANY tracker on this page, and when.
 *
 * Deliberately module scope. React StrictMode mounts every effect twice in
 * development, so the provider builds two trackers and a per-instance guard sees
 * one report each and lets both through — every dev sees doubled numbers and
 * cannot tell whether their integration is wrong. Two providers mounted by
 * mistake collapse the same way.
 */
let lastPageView: { path: string; at: number } = { path: '', at: 0 }

export class NohmoTracker {
  private config: Required<NohmoConfig>
  private state: NohmoState
  private queue: EventQueue
  private pageStart: number = Date.now()
  // Set once the server has rejected our credentials, so the identical error is
  // reported once rather than on every call.
  private credentialsRejected = false
  /** Listener removers, run by destroy(). */
  private teardown: (() => void)[] = []
  /**
   * A destroyed tracker must go completely quiet.
   *
   * init() is async, so React StrictMode's mount → unmount → mount can destroy
   * the first tracker while its init is still in flight. When that init finished
   * it went on to report a page view, which claimed the page-wide duplicate slot
   * and then had nowhere to go — its queue was already shut. The second, live
   * tracker's report was then suppressed as a duplicate and the page view was
   * lost entirely.
   */
  private destroyed = false
  private autoCapture: AutoCapture | null = null
  private errorCapture: ErrorCapture | null = null
  // Events queued before init() resolves the canonical deviceId
  private pendingEvents: PartialEvent[] = []
  private initResolve: () => void = () => {}
  private readonly initPromise: Promise<void>

  constructor(config: NohmoConfig) {
    this.config = {
      flushInterval: 3000,
      debug: false,
      autoPageView: true,
      autoScrollDepth: true,
      autoTimeSpent: true,
      autoCapture: true,
      autoErrors: true,
      release: '',
      attributionParams: ['ref'],
      ...config,
    }

    this.state = {
      deviceId: null,
      userId: null,
      sessionId: this.generateSessionId(),
      ready: false,
    }

    this.initPromise = new Promise(resolve => { this.initResolve = resolve })

    this.queue = new EventQueue(
      (events) => this.sendBatch(events),
      this.config.flushInterval
    )
  }

  async init(): Promise<void> {
    if (typeof window === 'undefined') {
      this.initResolve()
      return
    }

    try {
      const [deviceId, stableId] = [getDeviceId(), await getStableId()]

      let canonicalId = deviceId
      let userId: string | null = null

      try {
        const res = await fetch(
          `${_h}${_p.i}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': this.config.apiKey,
            },
            body: JSON.stringify({
              deviceId,
              stableId,
              knownUserId: readStore('local', '_nohmo_uid') ?? undefined,
              page: typeof window !== 'undefined' ? window.location.pathname : '',
              referrer: typeof document !== 'undefined' ? document.referrer : '',
              deviceInfo: getDeviceInfo(),
              // First sighting of a build is what seeds the deploy timeline the
              // narrative correlates metric movements against. Omitted when unset so
              // the backend can tell "no release configured" from "release is empty".
              ...(this.config.release ? { release: this.config.release } : {}),
            }),
          }
        )

        // A failed identify is the one that hurts most: the server never creates
        // the device row, so every later call for it is refused too.
        if (!this.resOk(res, 'identify')) throw new Error(`identify HTTP ${res.status}`)

        const json = await res.json() as { success: boolean; data?: { deviceId?: string; userId?: string; attributionParams?: string[] } }
        const respData = json.data ?? {}
        canonicalId = respData.deviceId ?? deviceId
        userId = respData.userId ?? null
        if (respData.attributionParams?.length) {
          this.config.attributionParams = respData.attributionParams
        }

        if (canonicalId !== deviceId) {
          writeStore('local', '_nohmo_did', canonicalId)
        }
      } catch {
        // Identify failed — fall back to local deviceId. Events will be stored
        // once the device is created on the next successful identify.
      }

      // Destroyed while identify was in flight (StrictMode remount, or a page
      // navigated away from). Everything below attaches listeners and timers to
      // a tracker nobody holds any more.
      if (this.destroyed) {
        this.initResolve()
        return
      }

      this.state.deviceId = canonicalId
      this.state.userId = userId
      this.state.ready = true

      // Drain events that were sent before init completed
      for (const e of this.pendingEvents) {
        this.queue.push({ ...e, deviceId: canonicalId , sdk: SDK_NAME, sdkVersion: SDK_VERSION })
      }
      this.pendingEvents = []

      if (this.config.autoTimeSpent) {
        // Named and tracked, not anonymous: destroy() has to be able to take
        // them off again. Left attached, a replaced tracker went on reporting
        // TIME_SPENT for a page nobody was on, and every remount added a set.
        const onHidden = () => { if (document.hidden) this.trackTimeSpent() }
        const onLeave = () => this.trackTimeSpent()
        document.addEventListener('visibilitychange', onHidden)
        window.addEventListener('pagehide', onLeave)
        this.teardown.push(() => document.removeEventListener('visibilitychange', onHidden))
        this.teardown.push(() => window.removeEventListener('pagehide', onLeave))
      }

      this.queue.start()
      this.initResolve()

      if (this.config.autoPageView) {
        this.trackPageView()
      }

      if (this.config.autoScrollDepth) {
        // Keep the remover. Dropping it left the scroll listener attached for the
        // life of the page, and NohmoProvider called this a second time on top,
        // so every mount attached two and reported SCROLL_DEPTH twice.
        this.teardown.push(this.startScrollTracking())
      }

      if (this.config.autoCapture) {
        this.autoCapture = new AutoCapture(this)
        this.autoCapture.start()
      }

      if (this.config.autoErrors) {
        this.errorCapture = new ErrorCapture(this)
        this.errorCapture.start()
      }

      this.log('Nohmo initialized', this.state)
    } catch (err) {
      this.pendingEvents = []
      this.initResolve()
      console.error('[Nohmo] Failed to initialize:', err)
    }
  }

  send(event: string, data: Record<string, unknown> = {}) {
    if (this.destroyed) return
    const utm = getUTMParams(this.config.attributionParams)
    const partial: PartialEvent = {
      userId: this.state.userId,
      sessionId: this.state.sessionId,
      event,
      data,
      page: typeof window !== 'undefined' ? window.location.pathname : '',
      referrer: typeof document !== 'undefined' ? document.referrer : '',
      ts: Date.now(),
      ...(Object.keys(utm).length > 0 ? { utm } : {}),
    }

    if (!this.state.deviceId) {
      // init() hasn't resolved the canonical deviceId yet — buffer and drain later
      this.pendingEvents.push(partial)
      this.log('Buffered pre-init event:', event)
      return
    }

    this.queue.push({ ...partial, deviceId: this.state.deviceId , sdk: SDK_NAME, sdkVersion: SDK_VERSION })
    this.log('Event queued:', event)
  }

  async linkUser(
    userId: string,
    email?: string,
    meta?: Record<string, unknown>
  ): Promise<void> {
    // Wait for init to complete so we have a valid deviceId and the device
    // record exists in the backend before we try to link it.
    await this.initPromise

    this.state.userId = userId
    this.queue.flush()

    try {
      const res = await fetch(`${_h}${_p.l}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.config.apiKey,
        },
        body: JSON.stringify({
          deviceId: this.state.deviceId,
          userId,
          email: email ?? '',
          meta: meta ?? {},
        }),
      })
      if (!this.resOk(res, 'linkUser')) return

      writeStore('local', '_nohmo_uid', userId)
      this.send('USER_LINKED', { userId, email })
      this.log('User linked:', userId)
    } catch (err) {
      console.error('[Nohmo] Failed to link user:', err)
    }
  }

  trackConversion(slug: string, properties: Record<string, unknown> = {}) {
    this.send('CONVERSION', { slug, ...properties })
  }

  /**
   * Report a page view, ignoring an immediate repeat of the same path.
   *
   * Two things now report a navigation — the provider's History watcher, and any
   * usePageView() the app still calls on that screen — and an app that was
   * written before the watcher existed has those calls everywhere. Without this
   * guard, upgrading would silently double every page-view number in the
   * dashboard, which is worse than the missing tracking it replaced: the old
   * behaviour was visibly absent, this would look plausible and be wrong.
   *
   * React 18 StrictMode double-invokes effects in development, which fires the
   * same duplicate, so this covers that too.
   *
   * Scoped as tightly as it can be: the same path, inside half a second. Both
   * reports of one navigation land in the same tick or the next; a person
   * genuinely leaving a page and returning to it cannot.
   */
  trackPageView(path?: string) {
    if (this.destroyed) return
    const resolved = path ?? (typeof window !== 'undefined' ? window.location.pathname : '')
    const now = Date.now()
    if (resolved === lastPageView.path && now - lastPageView.at < 500) {
      this.log('Duplicate PAGE_VIEW ignored:', resolved)
      return
    }
    lastPageView = { path: resolved, at: now }

    this.send('PAGE_VIEW', {
      path: resolved,
      title: typeof document !== 'undefined' ? document.title : '',
    })
    this.pageStart = Date.now()
  }

  trackTimeSpent(path?: string) {
    const seconds = Math.round((Date.now() - this.pageStart) / 1000)
    if (seconds < 1) return
    this.send('TIME_SPENT', {
      path: path ?? (typeof window !== 'undefined' ? window.location.pathname : ''),
      seconds,
    })
    this.pageStart = Date.now()
  }

  startScrollTracking(): () => void {
    if (typeof window === 'undefined') return () => undefined

    let maxDepth = 0

    const onScroll = () => {
      const scrolled = window.scrollY
      const total = document.body.scrollHeight - window.innerHeight
      if (total <= 0) return

      const depth = Math.round((scrolled / total) * 100)
      const milestone = [25, 50, 75, 100].find(
        (m) => depth >= m && maxDepth < m
      )

      if (milestone !== undefined) {
        maxDepth = milestone
        this.send('SCROLL_DEPTH', {
          depth: milestone,
          page: window.location.pathname,
        })
      }
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }

  /** Returns false when the server never took the batch, so the queue can keep it. */
  private async sendBatch(events: NohmoEvent[]): Promise<boolean> {
    if (!events.length) return true

    const body = JSON.stringify({ events, apiKey: this.config.apiKey })
    const url = `${_h}${_p.t}`

    // sendBeacon returns false (not an exception) when it fails — e.g. in some
    // incognito modes or when the browser queue is full. Always fall back to fetch.
    const beaconSent = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
    if (beaconSent) {
      this.log(`Flushed ${events.length} events via beacon`)
      return true
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
      // 5xx means the server never took it — keep the events and retry on the
      // next flush. A 4xx will not be fixed by retrying, so the batch is dropped,
      // but it is reported rather than vanishing.
      if (res.status >= 500) {
        console.error(`[Nohmo] Event delivery failed: HTTP ${res.status} — retrying`)
        return false
      }
      if (!this.resOk(res, 'event delivery')) return true
      this.log(`Flushed ${events.length} events via fetch`)
      return true
    } catch (err) {
      // Offline, DNS, CORS — the batch never left. Keep it.
      this.log('Flush failed, re-queued:', err)
      return false
    }
  }

  private generateSessionId(): string {
    if (typeof window !== 'undefined') {
      const stored = readStore('session', '_nohmo_sess')
      if (stored) return stored
    }
    const id = 'sess_' + Math.random().toString(36).slice(2, 14)
    if (typeof window !== 'undefined') {
      writeStore('session', '_nohmo_sess', id)
    }
    return id
  }

  /**
   * Did the server accept this call?
   *
   * identify and linkUser read res.json() straight off the response and never
   * looked at the status. A rejected API key comes back 401 with a perfectly
   * parseable body, so the SDK took the miss for a hit: nothing was recorded and
   * nothing was said. The React Native and Flutter SDKs were fixed for this; the
   * web one, which is the biggest surface, was not.
   *
   * console.error rather than log(), because the person whose integration is
   * silently dropping everything is the one who has not enabled debug.
   */
  private resOk(res: { ok: boolean; status: number }, what: string): boolean {
    if (res.ok) return true

    if (res.status === 401 || res.status === 403) {
      if (!this.credentialsRejected) {
        this.credentialsRejected = true
        console.error(
          `[Nohmo] Server rejected the SDK credentials (HTTP ${res.status}).\n\n` +
          `Nothing will be recorded until this is fixed — no page views, no events, ` +
          `no linkUser.\n\n` +
          `Check that projectId and apiKey on <NohmoProvider> match a live key in ` +
          `Dashboard → Settings → Setup.`
        )
      }
      return false
    }

    console.error(`[Nohmo] ${what} failed: HTTP ${res.status}`)
    return false
  }

  private log(...args: unknown[]) {
    if (this.config.debug) {
      console.log('[Nohmo]', ...args)
    }
  }

  getState(): NohmoState {
    return { ...this.state }
  }

  /** Flush queued events immediately. Used by error capture so a crash-class
   *  event isn't lost to the periodic batch if the page is about to unload. */
  flushNow() {
    this.queue.flush()
  }

  destroy() {
    this.destroyed = true
    this.autoCapture?.stop()
    this.errorCapture?.stop()
    for (const off of this.teardown.splice(0)) {
      try { off() } catch { /* target already gone */ }
    }
    this.queue.destroy()
  }
}
