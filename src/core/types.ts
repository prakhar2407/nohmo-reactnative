export type { DeviceInfo } from './fingerprint'
export type { UTMParams } from './utm'

export interface NohmoConfig {
  projectId: string
  apiKey: string
  flushInterval?: number
  debug?: boolean
  autoPageView?: boolean
  autoScrollDepth?: boolean
  autoTimeSpent?: boolean
  autoCapture?: boolean
  /**
   * Automatically capture uncaught JS errors, unhandled promise rejections,
   * failed network requests (fetch/XHR 4xx/5xx), and resource 404s as
   * JS_ERROR / HTTP_ERROR events. Defaults to true. Set false to disable.
   */
  autoErrors?: boolean
  /**
   * The build currently running, e.g. "2.4.1" or a commit SHA. Reported on init so
   * Nohmo can build a deploy timeline and line metric movements up against releases
   * ("conversions fell 18% — that lines up with 2.4.1 shipping"). Optional: without it
   * the timeline only contains releases reported by CI or added by hand.
   */
  release?: string
  /**
   * Custom URL parameter names to treat as attribution when no utm_* params
   * are present. Checked in order; the first match becomes source and the
   * param name itself becomes medium so it's identifiable in the dashboard.
   * Defaults to ['ref'].
   * Example: ['ref', 'reference', 'src', 'from']
   */
  attributionParams?: string[]
}

export interface NohmoEvent {
  deviceId: string
  userId: string | null
  sessionId: string
  event: string
  data: Record<string, unknown>
  page: string
  referrer: string
  ts: number
  utm?: import('./utm').UTMParams
  /** Which client library produced this event — 'web' | 'react-native' | 'flutter' |
   *  'server'. Distinct from platform: a Flutter app and a React Native app both
   *  report platform 'android', and without this the server cannot tell them apart. */
  sdk?: string
  /** The SDK's own package version, stamped at build time. */
  sdkVersion?: string
}

export interface NohmoUser {
  userId: string
  email?: string
  meta?: Record<string, unknown>
}

export interface NohmoState {
  deviceId: string | null
  userId: string | null
  sessionId: string
  ready: boolean
}
