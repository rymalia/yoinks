/**
 * Native thumbnail fetching for `yoinks meta`: the Data API's URL, or a
 * direct `i.ytimg.com` probe when there is no key. yt-dlp's
 * `--write-thumbnail` (in ytdlp-meta.ts) covers every other site.
 */
import {fail, metaError, ok, type Result} from './errors.js'
import {backoffMs, parseRetryAfter, type Sleep} from './pacing.js'

const MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 20_000

export type FetchDeps = {
  fetch: typeof globalThis.fetch
  sleep: Sleep
  rand: () => number
  now: () => number
  timeoutMs?: number
}

export type FetchedImage = {
  bytes: Uint8Array
  contentType: string
  /** File extension from the content type: jpg, png, webp, gif, or `img`. */
  ext: string
  width: number | null
  height: number | null
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

export function extFromContentType(contentType: string): string {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  return EXT_BY_TYPE[type] ?? 'img'
}

/** GET one image URL: 200 + `image/*` + non-empty body, with the 429 policy. */
export async function fetchImage(url: string, deps: FetchDeps): Promise<Result<FetchedImage>> {
  for (let attempt = 1; ; attempt++) {
    let response: Response
    try {
      response = await deps.fetch(url, {signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)})
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      return fail(metaError('thumbnail', timedOut ? 'timeout' : 'network', error))
    }
    if (response.status === 429) {
      if (attempt < MAX_ATTEMPTS) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'), deps.now())
        await deps.sleep(retryAfter ?? backoffMs(attempt, deps.rand))
        continue
      }
      return fail(metaError('thumbnail', 'rate_limited', 'thumbnail host rate limited (HTTP 429)'))
    }
    if (response.status === 404) return fail(metaError('thumbnail', 'not_found', 'thumbnail not found (HTTP 404)'))
    if (!response.ok) return fail(metaError('thumbnail', 'provider', `thumbnail fetch failed (HTTP ${response.status})`))

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith('image/')) {
      return fail(metaError('thumbnail', 'provider', `thumbnail response is not an image (${contentType || 'no content-type'})`))
    }
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      return fail(metaError('thumbnail', timedOut ? 'timeout' : 'network', error))
    }
    if (bytes.length === 0) return fail(metaError('thumbnail', 'provider', 'thumbnail response was empty'))
    const dims = jpegDimensions(bytes)
    return ok({bytes, contentType, ext: extFromContentType(contentType), width: dims?.width ?? null, height: dims?.height ?? null})
  }
}

/** Sizes to try without an API key, best first. */
export function ytimgUrls(videoId: string): string[] {
  return ['maxresdefault', 'hqdefault'].map((name) => `https://i.ytimg.com/vi/${videoId}/${name}.jpg`)
}

/** Probe `maxresdefault.jpg` then `hqdefault.jpg`; a 404 moves to the next size. */
export async function fetchYoutubeThumbnail(
  videoId: string,
  deps: FetchDeps,
): Promise<Result<FetchedImage & {url: string}>> {
  let last: Result<FetchedImage> | null = null
  for (const url of ytimgUrls(videoId)) {
    const result = await fetchImage(url, deps)
    if (result.ok) return ok({...result.value, url}, result.warnings)
    last = result
    if (result.error.kind !== 'not_found') break
  }
  return fail(last!.error)
}

/** Width and height from a JPEG's first SOF marker; null for anything else. */
export function jpegDimensions(bytes: Uint8Array): {width: number; height: number} | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]!
    if (marker === 0xff) {
      offset++
      continue
    }
    // standalone markers carry no length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!
      return width > 0 && height > 0 ? {width, height} : null
    }
    if (marker === 0xda || marker === 0xd9) return null // image data / end: no SOF seen
    offset += 2 + length
  }
  return null
}
