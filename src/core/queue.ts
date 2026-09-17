import type { NohmoEvent } from './types'

/**
 * The outgoing event buffer.
 *
 * Two things it now gets right that it used to not:
 *
 *  · A failed batch goes back. flush() cleared the queue before handing the
 *    events over and nothing put them back, so one offline moment lost them for
 *    good. The React Native and Flutter SDKs both re-queue; this one did not.
 *  · Its listeners come off on destroy(). They were anonymous and never removed,
 *    so a remount — which React StrictMode does on every mount in development —
 *    stacked another set, and the dead queue kept flushing.
 */
export class EventQueue {
  private queue: NohmoEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flushFn: (events: NohmoEvent[]) => void | Promise<boolean | void>
  private interval: number
  private teardown: (() => void)[] = []
  private destroyed = false

  /** Bound on the queue so the retry has a ceiling; the newest are kept, since an
   *  ancient un-delivered event is the least useful one. */
  private static readonly MAX_QUEUED = 500

  constructor(
    flushFn: (events: NohmoEvent[]) => void | Promise<boolean | void>,
    interval: number = 3000
  ) {
    this.flushFn = flushFn
    this.interval = interval
  }

  start() {
    // init() is async and can finish after the tracker was destroyed — React
    // StrictMode's mount/unmount/mount does exactly that. Starting then would
    // leave a flush interval running for the life of the page with nothing on
    // the other end of it.
    if (this.destroyed) return
    this.timer = setInterval(() => this.flush(), this.interval)

    const on = (
      target: EventTarget | undefined,
      type: string,
      handler: () => void,
    ) => {
      if (!target) return
      target.addEventListener(type, handler)
      this.teardown.push(() => target.removeEventListener(type, handler))
    }

    const onHidden = () => { if (document.hidden) this.flush() }
    const onLeave = () => this.flush()

    if (typeof document !== 'undefined') on(document, 'visibilitychange', onHidden)
    if (typeof window !== 'undefined') {
      on(window, 'pagehide', onLeave)
      on(window, 'beforeunload', onLeave)
    }
  }

  push(event: NohmoEvent) {
    if (this.destroyed) return
    this.queue.push(event)
    if (this.queue.length > EventQueue.MAX_QUEUED) {
      this.queue.splice(0, this.queue.length - EventQueue.MAX_QUEUED)
    }
  }

  flush() {
    if (!this.queue.length) return
    const batch = [...this.queue]
    this.queue = []

    // flushFn reports false when the server never took the batch. Anything else —
    // including the old void-returning shape — is treated as delivered.
    void Promise.resolve(this.flushFn(batch)).then((delivered) => {
      if (delivered === false && !this.destroyed) this.requeue(batch)
    }).catch(() => {
      if (!this.destroyed) this.requeue(batch)
    })
  }

  /** Failed events go back in front: they are older than whatever arrived since. */
  private requeue(batch: NohmoEvent[]) {
    this.queue.unshift(...batch)
    if (this.queue.length > EventQueue.MAX_QUEUED) {
      this.queue.splice(0, this.queue.length - EventQueue.MAX_QUEUED)
    }
  }

  destroy() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const off of this.teardown.splice(0)) {
      try { off() } catch { /* target already gone */ }
    }
    this.flush()
    this.destroyed = true
  }
}
