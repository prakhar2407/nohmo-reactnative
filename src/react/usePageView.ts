import { useEffect } from 'react'
import { useNohmo } from './NohmoProvider'

/**
 * Report a page view by hand.
 *
 * Rarely needed: the provider already turns every route change into a PAGE_VIEW.
 * Use it for a screen that changes without touching the URL — a wizard step, a
 * tab, a modal you treat as a page — or to report a path of your own choosing.
 *
 * Safe to leave in place while upgrading: it goes through the same
 * trackPageView() as the automatic tracking, so calling it on a screen that also
 * changes the URL is ignored as a duplicate rather than counted twice.
 */
export function usePageView(path?: string) {
  const { trackPageView } = useNohmo()

  useEffect(() => {
    trackPageView(path)
  }, [path])
}
