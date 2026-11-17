import { resolve } from 'node:path'

const PAPERTIE_FILE = /\.papertie$/i

/**
 * The `.papertie` files named on a command line (Windows and Linux open a file by launching the app
 * with its path; a second launch's line arrives in `second-instance`), resolved against `cwd`.
 * The executable (the first argument), switches and anything else are left alone.
 */
export function papertieFiles(argv: readonly string[], cwd: string): string[] {
  const out: string[] = []
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-') || !PAPERTIE_FILE.test(arg)) continue
    const path = resolve(cwd, arg)
    if (!out.includes(path)) out.push(path)
  }
  return out
}

/**
 * Files opened before the page can take them (at launch, or while it reloads) wait here; the page
 * attaches once its preload has asked for them, and takes each one from then on.
 */
export class OpenQueue {
  private readonly waiting: string[] = []
  private sink: ((path: string) => void) | null = null

  open(path: string): void {
    if (this.sink) this.sink(path)
    else this.waiting.push(path)
  }

  attach(sink: (path: string) => void): void {
    this.sink = sink
    for (const path of this.waiting.splice(0)) sink(path)
  }

  detach(): void {
    this.sink = null
  }
}
