export type Sleep = (ms: number) => Promise<void>

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MAX_RETRY_AFTER_MS = 300_000

/** Parse Retry-After delta-seconds or an HTTP date, clamped to five minutes. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (value == null || !value.trim()) return null
  const trimmed = value.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
  }
  const date = Date.parse(trimmed)
  if (!Number.isFinite(date)) return null
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS)
}

/** Apply symmetric proportional jitter; rand is expected to return [0, 1). */
export function withJitter(ms: number, rand: () => number, fraction = 0.3): number {
  return ms * (1 - fraction + 2 * fraction * rand())
}

/** Retry delays for the first two (and all later) attempts. */
export function backoffMs(attempt: number, rand: () => number): number {
  return withJitter(attempt <= 1 ? 30_000 : 90_000, rand)
}

export function isYtdlpRateLimited(stderr: string): boolean {
  return stderr.includes('HTTP Error 429')
}

/** Opens after two consecutive item-level final caption rate limits. */
export class CaptionBreaker {
  private consecutiveRateLimits = 0
  private isOpen = false

  record(outcome: 'rate_limited' | 'ok' | 'unavailable' | 'other'): void {
    if (this.isOpen || outcome === 'other') return
    if (outcome === 'rate_limited') {
      this.consecutiveRateLimits += 1
      if (this.consecutiveRateLimits >= 2) this.isOpen = true
      return
    }
    this.consecutiveRateLimits = 0
  }

  get open(): boolean {
    return this.isOpen
  }
}
