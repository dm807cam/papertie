import type { Clock } from '../../src/clock'

export class FakeClock implements Clock {
  private ms: number

  constructor(iso = '2026-10-27T10:00:00.000Z') {
    this.ms = Date.parse(iso)
  }

  now(): Date {
    return new Date(this.ms)
  }

  set(iso: string): void {
    this.ms = Date.parse(iso)
  }

  advance(ms: number): void {
    this.ms += ms
  }
}
