'use client'

import React, { createContext, useContext, useEffect, useRef } from 'react'
import { NohmoTracker } from '../core/tracker'
import { currentPath, onRouteChange } from '../core/route'
import type { NohmoConfig } from '../core/types'

interface NohmoContextValue {
  send: (event: string, data?: Record<string, unknown>) => void
  trackConversion: (slug: string, properties?: Record<string, unknown>) => void
  trackTimeSpent: (path?: string) => void
  /** Report a page view. Goes through the tracker's duplicate guard, so it is
   *  safe to call on a screen the route watcher already reported. */
  trackPageView: (path?: string) => void
  linkUser: (
    userId: string,
    email?: string,
    meta?: Record<string, unknown>
  ) => Promise<void>
}

const NohmoContext = createContext<NohmoContextValue>({
  send: () => undefined,
  trackConversion: () => undefined,
  trackTimeSpent: () => undefined,
  trackPageView: () => undefined,
  linkUser: async () => undefined,
})

interface NohmoProviderProps {
  children: React.ReactNode
  projectId: string
  apiKey: string
  options?: Partial<NohmoConfig>
}

export function NohmoProvider({
  children,
  projectId,
  apiKey,
  options = {},
}: NohmoProviderProps) {
  const trackerRef = useRef<NohmoTracker | null>(null)

  // Queue for linkUser calls that arrive before the tracker useEffect has run.
  // This happens when a child component calls linkUser in its own useEffect —
  // React runs child effects before parent effects, so trackerRef.current is
  // still null at that point. We drain this queue once the tracker is ready.
  type PendingLink = [string, string | undefined, Record<string, unknown> | undefined]
  const pendingLinksRef = useRef<PendingLink[]>([])

  useEffect(() => {
    // Nothing analytics does is worth taking the host app down with it. The
    // tracker is careful about this internally, but it constructs and starts a
    // lot of browser machinery and this effect is the last place an unexpected
    // throw could still reach React — which would unmount the app's tree.
    let tracker: NohmoTracker
    try {
      tracker = new NohmoTracker({
        projectId,
        apiKey,
        ...options,
      })
    } catch (err) {
      console.error('[Nohmo] Disabled — the tracker could not start:', err)
      return
    }

    trackerRef.current = tracker

    // Drain any linkUser calls that arrived before this effect ran
    const pending = pendingLinksRef.current.splice(0)
    if (pending.length > 0) {
      // tracker.linkUser already awaits initPromise internally, so it's safe
      // to call these right away — they'll wait for init to complete
      for (const [userId, email, meta] of pending) {
        tracker.linkUser(userId, email, meta)
      }
    }

    tracker.init()


    // Client-side route changes become PAGE_VIEWs, for every router.
    //
    // This used to live only in NohmoNextProvider, so a Vite or CRA app saw one
    // PAGE_VIEW for the whole visit and had to call usePageView() by hand on
    // every screen. Nothing about the watcher was ever Next-specific — it reads
    // the History API (see core/route) — so the plain provider does it too and
    // React Router, Wouter, TanStack Router and hand-rolled routing all work
    // with no per-page code.
    //
    // Subscribed here rather than from a child component on purpose: a child's
    // effect runs BEFORE the parent's, so the tracker did not exist yet and the
    // child's first send() was silently dropped. It only looked correct because
    // the tracker's own autoPageView had already sent one.
    let cleanupRoute: (() => void) | undefined
    if (options.autoPageView !== false) {
      // init() already sent the PAGE_VIEW for the page we landed on; this
      // handler is for the navigations after it.
      let lastPath = currentPath()
      cleanupRoute = onRouteChange((path) => {
        if (path === lastPath) return   // replaceState for a query/hash change
        tracker.trackTimeSpent(lastPath)
        // trackPageView, not send: it also restarts the page clock, so the next
        // TIME_SPENT measures this page rather than everything since the visit
        // began.
        tracker.trackPageView(path)
        lastPath = path
      })
    }

    return () => {
      cleanupRoute?.()
      tracker.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const send = (event: string, data: Record<string, unknown> = {}) => {
    trackerRef.current?.send(event, data)
  }

  const trackConversion = (slug: string, properties?: Record<string, unknown>) => {
    trackerRef.current?.trackConversion(slug, properties)
  }

  const trackTimeSpent = (path?: string) => {
    trackerRef.current?.trackTimeSpent(path)
  }

  const trackPageView = (path?: string) => {
    trackerRef.current?.trackPageView(path)
  }

  const linkUser = async (
    userId: string,
    email?: string,
    meta?: Record<string, unknown>
  ) => {
    if (!trackerRef.current) {
      // Tracker not yet mounted — queue this call.
      // The useEffect above will drain it once the tracker is initialised.
      pendingLinksRef.current.push([userId, email, meta])
      return
    }
    await trackerRef.current.linkUser(userId, email, meta)
  }

  return (
    <NohmoContext.Provider value={{ send, trackConversion, trackTimeSpent, trackPageView, linkUser }}>
      {children}
    </NohmoContext.Provider>
  )
}

export function useNohmo() {
  return useContext(NohmoContext)
}
