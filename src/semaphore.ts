/**
 * Small async semaphore used to bound the expensive decode/resize/encode stage.
 * With a 512 MiB container, allowing many large decodes at once is a much bigger
 * risk than having a small queue behind the CDN.
 */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(limit: number) {
    this.available = limit
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--
      return () => this.release()
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve))
    return () => this.release()
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.available++
  }
}
