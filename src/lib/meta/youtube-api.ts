/**
 * YouTube Data API `videos.list` for `yoinks meta` metadata.
 *
 * The key travels only as a query parameter of the request URL, which is
 * never logged, never put in an error, and never returned. Every failure is
 * a {@link MetaError} whose message passed through `sanitize()`.
 */
import {fail, metaError, ok, registerSecret, type Result} from './errors.js'
import {backoffMs, parseRetryAfter, withJitter, type Sleep} from './pacing.js'
import type {LiveStatus, Metadata, ThumbnailRef} from './types.js'

export const API_BATCH = 50
const ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos'
const MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 20_000

export type ApiVideo = {
  metadata: Metadata
  thumbnail: ThumbnailRef | null
  /** `contentDetails.caption`: a hint that captions exist, nothing more. */
  captionHint: boolean | null
}

export type ApiDeps = {
  key: string
  fetch: typeof globalThis.fetch
  sleep: Sleep
  rand: () => number
  now: () => number
  timeoutMs?: number
}

type ApiThumb = {url?: string; width?: number; height?: number}
type ApiItem = {
  id?: string
  snippet?: {
    title?: string
    description?: string
    channelTitle?: string
    channelId?: string
    publishedAt?: string
    defaultAudioLanguage?: string
    defaultLanguage?: string
    liveBroadcastContent?: string
    thumbnails?: Record<string, ApiThumb | undefined>
  }
  contentDetails?: {duration?: string; caption?: string}
}
type ApiResponse = {items?: ApiItem[]; error?: {code?: number; message?: string; errors?: {reason?: string}[]}}

/**
 * Fetch up to {@link API_BATCH} ids in one request. Ids absent from the
 * response are simply absent from the map (private or removed videos).
 */
export async function fetchVideos(ids: string[], deps: ApiDeps): Promise<Result<Map<string, ApiVideo>>> {
  if (ids.length > API_BATCH) throw new Error(`fetchVideos: at most ${API_BATCH} ids per call`)
  registerSecret(deps.key)
  const url = new URL(ENDPOINT)
  url.searchParams.set('part', 'snippet,contentDetails')
  url.searchParams.set('id', ids.join(','))
  url.searchParams.set('maxResults', String(API_BATCH))
  url.searchParams.set('key', deps.key)

  for (let attempt = 1; ; attempt++) {
    let response: Response
    let text: string
    try {
      // one timeout covers headers and body; a body that stalls is a timeout too
      response = await deps.fetch(url.toString(), {signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)})
      text = await response.text()
    } catch (error) {
      if (attempt < MAX_ATTEMPTS) {
        await deps.sleep(transientBackoffMs(attempt, deps.rand))
        continue
      }
      return fail(metaError('metadata', isTimeout(error) ? 'timeout' : 'network', error))
    }

    if (response.status === 429) {
      if (attempt < MAX_ATTEMPTS) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'), deps.now())
        await deps.sleep(retryAfter ?? backoffMs(attempt, deps.rand))
        continue
      }
      return fail(metaError('metadata', 'rate_limited', 'Data API rate limited (HTTP 429)'))
    }
    if (response.status >= 500) {
      if (attempt < MAX_ATTEMPTS) {
        await deps.sleep(transientBackoffMs(attempt, deps.rand))
        continue
      }
      return fail(metaError('metadata', 'provider', `Data API error HTTP ${response.status}`))
    }

    let body: ApiResponse
    try {
      body = JSON.parse(text) as ApiResponse
    } catch (error) {
      return fail(metaError('metadata', 'parse', `Data API HTTP ${response.status}: unreadable body (${describe(error)})`))
    }

    if (!response.ok) {
      const reason = body.error?.errors?.[0]?.reason ?? ''
      const message = `Data API HTTP ${response.status}${reason ? ` (${reason})` : ''}${body.error?.message ? `: ${body.error.message}` : ''}`
      if (/^(quotaExceeded|dailyLimitExceeded|rateLimitExceeded|userRateLimitExceeded)$/.test(reason)) {
        return fail(metaError('metadata', 'quota', message))
      }
      if (response.status === 403 || response.status === 401 || reason === 'keyInvalid' || /API key/i.test(body.error?.message ?? '')) {
        return fail(metaError('metadata', 'auth', message))
      }
      return fail(metaError('metadata', 'provider', message))
    }

    const out = new Map<string, ApiVideo>()
    for (const item of body.items ?? []) {
      if (!item.id) continue
      out.set(item.id, mapItem(item))
    }
    return ok(out)
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function transientBackoffMs(attempt: number, rand: () => number): number {
  return withJitter(attempt <= 1 ? 2_000 : 6_000, rand)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const THUMB_ORDER = ['maxres', 'standard', 'high', 'medium', 'default']

export function mapItem(item: ApiItem): ApiVideo {
  const s = item.snippet ?? {}
  const c = item.contentDetails ?? {}
  let thumbnail: ThumbnailRef | null = null
  for (const size of THUMB_ORDER) {
    const t = s.thumbnails?.[size]
    if (t?.url) {
      thumbnail = {url: t.url, width: t.width ?? null, height: t.height ?? null}
      break
    }
  }
  return {
    metadata: {
      title: s.title ?? null,
      description: s.description ?? null,
      channel: s.channelTitle ?? null,
      channelId: s.channelId ?? null,
      publishedAt: s.publishedAt ?? null,
      durationSec: c.duration ? parseIsoDuration(c.duration) : null,
      audioLanguage: s.defaultAudioLanguage ?? s.defaultLanguage ?? null,
      liveStatus: liveStatusOf(s.liveBroadcastContent),
      chapters: null,
    },
    thumbnail,
    captionHint: c.caption === undefined ? null : c.caption === 'true',
  }
}

function liveStatusOf(value: string | undefined): LiveStatus {
  if (value === 'live') return 'live'
  if (value === 'upcoming') return 'upcoming'
  return 'none'
}

/** `PT1H2M3S` → 3723; `P1DT2H` → 93600; null when unparseable. */
export function parseIsoDuration(value: string): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim())
  if (!m) return null
  const [, d, h, min, s] = m
  if (d === undefined && h === undefined && min === undefined && s === undefined) return null
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min ?? 0) * 60 + Math.round(Number(s ?? 0))
}
