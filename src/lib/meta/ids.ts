/**
 * URL → video identity for `yoinks meta` (pure, no I/O).
 *
 * YouTube URLs are recognised locally so the Data API can be batched and
 * duplicates collapsed before anything touches the network. Everything else
 * is identified later from yt-dlp's `extractor_key` + `id`.
 */
import {createHash} from 'node:crypto'
import {safeIdPart} from '../naming.js'

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
])

/** Path prefixes whose next segment is the video id. */
const ID_PATHS = ['shorts', 'embed', 'live', 'v', 'e']

/**
 * The 11-character YouTube video id in `input`, or null if it is not a
 * single-video YouTube URL (channels, playlists, search, or other sites).
 */
export function youtubeVideoId(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = url.pathname.split('/')[1] ?? ''
    return VIDEO_ID.test(id) ? id : null
  }
  if (!YOUTUBE_HOSTS.has(host)) return null

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] === 'watch') {
    const id = url.searchParams.get('v') ?? ''
    return VIDEO_ID.test(id) ? id : null
  }
  if (segments.length >= 2 && ID_PATHS.includes(segments[0]!)) {
    const id = segments[1]!
    return VIDEO_ID.test(id) ? id : null
  }
  return null
}

/** Canonical watch URL for a YouTube id. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`
}

/**
 * Key used to collapse duplicate inputs: `youtube:<id>` for YouTube videos,
 * the trimmed URL otherwise.
 */
export function dedupeKey(input: string): string {
  const id = youtubeVideoId(input)
  return id ? `youtube:${id}` : input.trim()
}

/** Drop blank lines, `#` comments and duplicates (first occurrence wins). */
export function collectInputs(lines: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const key = dedupeKey(line)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

/**
 * File stem for an item's artifacts: the YouTube id; else
 * `<extractor>-<id>` from yt-dlp (cleaned like `naming.ts` ids); else a hash
 * of the input URL. Never contains `/`, `\` or `%`.
 */
export function artifactStem(item: {
  videoId?: string | null
  extractorKey?: string | null
  id?: string | null
  inputUrl: string
}): string {
  if (item.videoId && VIDEO_ID.test(item.videoId)) return item.videoId
  const extractor = (item.extractorKey ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (extractor && item.id) return `${extractor}-${safeIdPart(item.id)}`
  const digest = createHash('sha1').update(dedupeKey(item.inputUrl)).digest('hex').slice(0, 12)
  return `url-${digest}`
}
