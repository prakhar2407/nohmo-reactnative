/**
 * Browser storage that cannot throw.
 *
 * Reading `localStorage` or `sessionStorage` is not safe: with cookies blocked,
 * in Safari's private mode, or behind a strict privacy extension, merely
 * touching the property raises a SecurityError. The SDK read them bare in six
 * places, one of them in the tracker's constructor — which NohmoProvider calls
 * inside an effect with no try/catch, so the throw propagated into React and it
 * unmounted the host app's tree. A visitor with strict privacy settings was
 * served a blank page by the analytics script.
 *
 * Nothing the SDK stores is worth a broken site, so every access degrades to
 * "no value" instead. Identity then lasts only for the page, which is the
 * correct trade and is exactly what such a visitor is asking for anyway.
 */

type Kind = 'local' | 'session'

function area(kind: Kind): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    const s = kind === 'local' ? window.localStorage : window.sessionStorage
    // Presence is not enough — some browsers expose the object and throw on use.
    const probe = '__nohmo_probe__'
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    return null
  }
}

let localArea: Storage | null | undefined
let sessionArea: Storage | null | undefined

function resolve(kind: Kind): Storage | null {
  if (kind === 'local') {
    if (localArea === undefined) localArea = area('local')
    return localArea
  }
  if (sessionArea === undefined) sessionArea = area('session')
  return sessionArea
}

export function readStore(kind: Kind, key: string): string | null {
  try {
    return resolve(kind)?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeStore(kind: Kind, key: string, value: string): void {
  try {
    resolve(kind)?.setItem(key, value)
  } catch {
    // Quota exceeded, or a mode that allows the probe but not this write.
  }
}
