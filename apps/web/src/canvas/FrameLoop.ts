/** A frame task: returns true to ask for another frame. `dtSec` is the time since the last frame. */
export type FrameTask = (dtSec: number, nowMs: number) => boolean

type Raf = (cb: (t: number) => void) => unknown

/**
 * The one requestAnimationFrame loop. Each frame runs every task in the order added; another frame
 * is scheduled only when a task returned true or `request()` was called, so an idle board draws
 * nothing.
 */
export class FrameLoop {
  private readonly tasks = new Set<FrameTask>()
  private scheduled = false
  private inFrame = false
  private again = false
  private last: number | null = null
  private frames = 0

  constructor(
    private readonly raf: Raf = (cb) => requestAnimationFrame(cb),
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Register a task; the returned function removes it. */
  add(task: FrameTask): () => void {
    const own: FrameTask = (dt, now) => task(dt, now)
    this.tasks.add(own)
    return () => {
      this.tasks.delete(own)
    }
  }

  /** Ask for a frame. Calls coalesce: many requests before the frame give one frame. */
  request(): void {
    if (this.inFrame) this.again = true
    else this.schedule()
  }

  /** True while a frame is scheduled or running. */
  get running(): boolean {
    return this.scheduled || this.inFrame
  }

  /** Frames run so far. */
  get framesDrawn(): number {
    return this.frames
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.raf(() => this.frame())
  }

  private frame(): void {
    this.scheduled = false
    this.inFrame = true
    this.again = false
    const now = this.now()
    let dt = this.last === null ? 1 / 60 : Math.max(0, (now - this.last) / 1000)
    if (!Number.isFinite(dt)) dt = 0
    for (const task of [...this.tasks]) {
      if (!this.tasks.has(task)) continue
      try {
        if (task(dt, now)) this.again = true
      } catch (e) {
        queueMicrotask(() => {
          throw e
        })
      }
    }
    this.frames++
    this.inFrame = false
    if (this.again) {
      if (Number.isFinite(now)) this.last = now
      this.schedule()
    } else this.last = null
  }
}
