/**
 * Small async semaphore with a bounded wait queue for fetch and transform stages.
 * Rejecting excess work keeps memory use and tail latency bounded under load.
 */
export class SemaphoreQueueFullError extends Error {
  constructor() {
    super('Concurrency queue is full')
  }
}

export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(limit: number, private readonly maxQueue: number) {
    this.available = limit
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--
      return this.releaseOnce()
    }

    if (this.waiters.length >= this.maxQueue) {
      throw new SemaphoreQueueFullError()
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve))
    return this.releaseOnce()
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.available++
  }
}
