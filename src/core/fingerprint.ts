import { readStore, writeStore } from './storage'
let cachedDeviceId: string | null = null
let cachedStableId: string | null = null
let cachedDeviceInfo: DeviceInfo | null = null

export interface DeviceInfo {
  type: 'mobile' | 'tablet' | 'desktop'
  os: string
  browser: string
  browserVersion: string
  screenW: number
  screenH: number
  viewportW: number
  viewportH: number
  pixelRatio: number
  language: string
  timezone: string
  touch: boolean
}

export function getDeviceInfo(): DeviceInfo {
  if (cachedDeviceInfo) return cachedDeviceInfo

  const ua = navigator.userAgent

  let type: DeviceInfo['type'] = 'desktop'
  if (/iPad|Android(?!.*Mobile)/i.test(ua)) type = 'tablet'
  else if (/Mobi|Android.*Mobile|iPhone|iPod/i.test(ua)) type = 'mobile'

  let os = 'Unknown'
  if (/Windows NT/.test(ua)) os = 'Windows'
  else if (/iPhone|iPod/.test(ua)) os = 'iOS'
  else if (/iPad/.test(ua)) os = 'iPadOS'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/Mac OS X/.test(ua)) os = 'macOS'
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Linux/.test(ua)) os = 'Linux'

  let browser = 'Unknown'
  let browserVersion = ''
  const edgeM = ua.match(/Edg\/(\d+)/)
  const operaM = ua.match(/OPR\/(\d+)/)
  const chromeM = ua.match(/Chrome\/(\d+)/)
  const firefoxM = ua.match(/Firefox\/(\d+)/)
  const safariM = ua.match(/Version\/(\d+).*Safari/)
  if (edgeM)    { browser = 'Edge';    browserVersion = edgeM[1] }
  else if (operaM)   { browser = 'Opera';   browserVersion = operaM[1] }
  else if (chromeM)  { browser = 'Chrome';  browserVersion = chromeM[1] }
  else if (firefoxM) { browser = 'Firefox'; browserVersion = firefoxM[1] }
  else if (safariM)  { browser = 'Safari';  browserVersion = safariM[1] }

  cachedDeviceInfo = {
    type,
    os,
    browser,
    browserVersion,
    screenW: screen.width,
    screenH: screen.height,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    pixelRatio: window.devicePixelRatio ?? 1,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    touch: navigator.maxTouchPoints > 0,
  }
  return cachedDeviceInfo
}

function stableSignals(): string {
  const nav = navigator
  const scr = screen
  return [
    nav.userAgent,
    nav.language,
    nav.platform,
    String(nav.hardwareConcurrency ?? ''),
    String((nav as unknown as Record<string, unknown>)['deviceMemory'] ?? ''),
    String(nav.maxTouchPoints ?? ''),
    String(scr.width),
    String(scr.height),
    String(scr.colorDepth),
    String(window.devicePixelRatio ?? ''),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ].join('|')
}

async function hash(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

export async function getStableId(): Promise<string> {
  if (cachedStableId) return cachedStableId

  const stored = readStore('local', '_nohmo_sid')
  if (stored) {
    cachedStableId = stored
    return stored
  }

  const id = await hash(stableSignals())
  writeStore('local', '_nohmo_sid', id)
  cachedStableId = id
  return id
}

export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId

  const stored = readStore('local', '_nohmo_did')
  if (stored) {
    cachedDeviceId = stored
    return stored
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const id = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  writeStore('local', '_nohmo_did', id)
  cachedDeviceId = id
  return id
}
