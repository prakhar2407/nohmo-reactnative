type Sender = {
  send: (event: string, data: Record<string, unknown>) => void
  trackScreenView: (screenName: string) => void
}

// Store the sender on globalThis so both the react-native bundle (which inlines this module)
// and the separately-loaded autocapture bundle (imported by the Babel plugin) share one instance.
// Module-level variables don't work here because Metro/Rollup can create two separate copies.
const _g = globalThis as unknown as Record<string, unknown>
const _KEY = '__nohmo_sender__'

export function setAutoCaptureTracker(sender: Sender): void {
  _g[_KEY] = sender
}

function _getSender(): Sender | null {
  return (_g[_KEY] as Sender | undefined) ?? null
}

// ── Screen tracking ────────────────────────────────────────────────────────

function getActiveRouteName(state: any): string | undefined {
  if (!state?.routes) return undefined
  const route = state.routes[state.index ?? state.routes.length - 1]
  if (!route) return undefined
  // Nested navigators — recurse into the active child state
  if (route.state) return getActiveRouteName(route.state)
  return route.name as string
}

/**
 * Pass directly to NavigationContainer's onStateChange prop.
 * Fires SCREEN_VIEW + TIME_SPENT automatically on every navigation.
 *
 * @example
 * import { onNohmoStateChange } from 'nohmo/react-native/autocapture'
 * <NavigationContainer onStateChange={onNohmoStateChange}>
 */
export function onNohmoStateChange(state: any): void {
  const s = _getSender()
  if (!s) return
  const name = getActiveRouteName(state)
  if (name) s.trackScreenView(name)
}

/**
 * Pass to NavigationContainer's onReady prop to also capture the initial screen.
 * Requires passing your navigationRef so the current route can be read.
 *
 * @example
 * import { onNohmoStateChange, makeNohmoReadyHandler } from 'nohmo/react-native/autocapture'
 * <NavigationContainer
 *   onStateChange={onNohmoStateChange}
 *   onReady={makeNohmoReadyHandler(navigationRef)}
 * >
 */
export function makeNohmoReadyHandler(
  navigationRef: { current: { getCurrentRoute: () => { name: string } | undefined } | null }
): () => void {
  return () => {
    const s = _getSender()
    if (!s) return
    const route = navigationRef.current?.getCurrentRoute()
    if (route?.name) s.trackScreenView(route.name)
  }
}

/**
 * Compose Nohmo's screen tracking with an `onStateChange` the app already passes.
 *
 * The plugin used to skip injection entirely when the prop was already set, which is
 * silent and total: you keep the one SCREEN_VIEW that `onReady` captures at startup and
 * never get another for the rest of the session. An app with its own onStateChange is
 * common (its own analytics, a screen-title sync), so the skip hit exactly the apps that
 * were already thinking about navigation. Nohmo runs first, then the app's handler.
 */
export function composeNohmoStateChange<T extends ((state: any) => unknown) | null | undefined>(
  userHandler: T
): (state: any) => unknown {
  return (state: any) => {
    onNohmoStateChange(state)
    return (userHandler as ((s: any) => unknown) | null | undefined)?.(state)
  }
}

/** Same composition for `onReady`, which additionally needs the navigationRef to read
 *  the initial route. */
export function composeNohmoReady<T extends ((...args: any[]) => unknown) | null | undefined>(
  userHandler: T,
  navigationRef: { current: { getCurrentRoute: () => { name: string } | undefined } | null }
): (...args: any[]) => unknown {
  const nohmoReady = makeNohmoReadyHandler(navigationRef)
  return (...args: any[]) => {
    nohmoReady()
    return (userHandler as ((...a: any[]) => unknown) | null | undefined)?.(...args)
  }
}

// ── Press autocapture (injected by babel-plugin) ───────────────────────────

/**
 * Coerce a captured label to clean text. A dynamic label expression can resolve
 * at runtime to a React element or object (e.g. `label={icon}`, or a template
 * fragment that is itself an element) — `String()` would turn that into the
 * useless "[object Object]". So: drop non-string/object values entirely, and
 * strip any "[object Object]" that leaked into an otherwise-good string before
 * trimming and capping. Returns null when nothing meaningful remains.
 */
function _coerceLabel(v: unknown): string | null {
  let s: string
  if (typeof v === 'string') s = v
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v)
  else return null // null/undefined, objects, React elements, arrays, functions
  s = s.replace(/\[object Object\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return s || null
}

// Marks a function as already wrapped, so nested wraps can de-duplicate.
const _WRAPPED = '__nohmoWrapped__'

// ── Rage presses ───────────────────────────────────────────────────────────
// The web SDK emits RAGE_CLICK when someone jabs the same spot three times in a
// second. Mobile users do exactly the same thing to an unresponsive button, and
// without this the whole signal was web-only. Keyed by the press target rather than
// by coordinates — RN gives us the component identity, which is more precise than a
// screen position and survives scrolling.
const RAGE_WINDOW_MS = 1000
const RAGE_THRESHOLD = 3
const _rageCounts = new Map<string, { count: number; ts: number }>()

function _trackRage(sender: Sender, key: string, payload: Record<string, unknown>): void {
  const now = Date.now()
  const prev = _rageCounts.get(key)
  if (prev && now - prev.ts < RAGE_WINDOW_MS) {
    prev.count++
    prev.ts = now
    // Fire once on crossing the threshold, not on every press after it.
    if (prev.count === RAGE_THRESHOLD) sender.send('RAGE_CLICK', payload)
    return
  }
  _rageCounts.set(key, { count: 1, ts: now })
  // A long session touching many controls would otherwise grow this map without
  // bound; the entries are only meaningful for a second anyway.
  if (_rageCounts.size > 100) {
    for (const [k, v] of _rageCounts) {
      if (now - v.ts > RAGE_WINDOW_MS) _rageCounts.delete(k)
    }
  }
}

/**
 * Injected by the Nohmo Babel plugin around every onPress / onLongPress.
 * Fires a PRESS or LONG_PRESS event then calls the original handler.
 *
 * De-duplication: design-system buttons (e.g. <Button> → internal <Pressable
 * onPress={onPress}/>) thread the app's handler down, so the plugin wraps the
 * SAME handler at two levels. To avoid a double press (and the inner component's
 * "[object Object]" label), a wrapper whose handler is ITSELF a wrapper stays
 * silent — the app-level wrapper it delegates to carries the real label.
 */
export function __nohmoWrap<T extends ((...args: unknown[]) => unknown) | null | undefined>(
  handler: T,
  meta: {
    c?: string | null  // component name
    p?: string         // prop name (onPress | onLongPress)
    t?: unknown        // text — static (children/prop) or a runtime prop value
    f?: string | null  // filename (without extension)
    l?: number         // line number
  }
): (...args: unknown[]) => unknown {
  const wrapped = (...args: unknown[]) => {
    const s = _getSender()
    const handlerIsWrapped =
      typeof handler === 'function' && (handler as unknown as Record<string, unknown>)[_WRAPPED] === true
    if (s && !handlerIsWrapped) {
      const isLong = meta.p === 'onLongPress'
      const payload = {
        component: meta.c ?? null,
        text: _coerceLabel(meta.t),
        file: meta.f ?? null,
        line: meta.l ?? null,
      }
      s.send(isLong ? 'LONG_PRESS' : 'PRESS', payload)
      // Repeated jabs at the same control are the mobile equivalent of a rage click.
      // Long-presses are excluded: holding a control is intentional, not frustration.
      if (!isLong) {
        _trackRage(s, `${meta.f ?? ''}:${meta.l ?? ''}:${meta.c ?? ''}`, payload)
      }
    }
    return (handler as ((...a: unknown[]) => unknown) | null | undefined)?.(...args)
  }
  ;(wrapped as unknown as Record<string, unknown>)[_WRAPPED] = true
  return wrapped
}
