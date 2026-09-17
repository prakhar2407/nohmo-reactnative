'use client'

import React from 'react'
import { NohmoProvider } from '../react/NohmoProvider'
import type { NohmoConfig } from '../core/types'

/**
 * Next.js entry point.
 *
 * Kept as its own export because it is what the Next docs tell people to import,
 * but there is nothing Next-specific left in it. Route tracking used to live
 * here, in a child component that watched the History API; it now lives in
 * NohmoProvider, which means every React app gets it rather than only Next ones.
 *
 * Moving it also fixed two things that were invisible from the outside: the
 * child's first PAGE_VIEW was dropped (its effect ran before the provider had
 * built the tracker), and route changes went through send() rather than
 * trackPageView(), so the page clock was never restarted and every TIME_SPENT
 * after the first navigation measured the whole visit.
 */
export function NohmoNextProvider({
  children,
  projectId,
  apiKey,
  options = {},
}: {
  children: React.ReactNode
  projectId: string
  apiKey: string
  options?: Partial<NohmoConfig>
}) {
  return (
    <NohmoProvider projectId={projectId} apiKey={apiKey} options={options}>
      {children}
    </NohmoProvider>
  )
}
