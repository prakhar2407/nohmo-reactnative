export interface NohmoStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}

export interface NohmoRNConfig {
  projectId: string
  apiKey: string
  appVersion?: string
  flushInterval?: number
  debug?: boolean
  autoAppLifecycle?: boolean
  /**
   * Automatically capture JS errors and crashes. Non-fatal errors are sent as
   * JS_ERROR; a fatal crash is persisted and reported as APP_CRASH on the next
   * app launch. Defaults to true. Catches JS-thread errors only (not native
   * crashes). Set false to disable.
   */
  autoErrors?: boolean
  storage?: NohmoStorage
}

export interface NohmoRNEvent {
  deviceId: string
  userId: string | null
  sessionId: string
  event: string
  data: Record<string, unknown>
  screen: string
  referrer: string
  ts: number
  platform: 'ios' | 'android'
  appVersion: string
  utm?: Record<string, string>
  install_utm?: Record<string, string>
  /** Which client library produced this — 'react-native' here. Distinct from platform:
   *  a Flutter app reports platform 'android' too, and without this the server cannot
   *  tell which SDK sent a malformed payload. Cannot be backfilled later. */
  sdk?: string
  /** The SDK's own package version, stamped at build time. */
  sdkVersion?: string
}

export interface NohmoRNContextValue {
  send: (event: string, data?: Record<string, unknown>) => void
  trackScreenView: (screenName: string) => void
  trackConversion: (slug: string, properties?: Record<string, unknown>) => void
  buildInviteLink: (opts?: { channel?: string; campaign?: string; source?: string }) => Promise<string>
  linkUser: (userId: string, email?: string, meta?: Record<string, unknown>) => Promise<void>
  registerPushToken: (token: string) => Promise<void>
  setInstallReferrer: (referrerString: string) => Promise<void>
  /** The resolved Smart Link destination (e.g. "product/123"), or null if none. */
  getDeepLink: () => string | null
  /** Subscribe to Smart Link destinations (direct + deferred). Returns an unsubscribe. */
  onDeepLink: (cb: (value: string) => void) => () => void
}
