/**
 * yt-dlp for `yoinks meta`: an in-memory `-J` probe (the TUI's `probe()`
 * persists the ~11 MB JSON to $TMPDIR and is not reused), one caption track
 * per run into a staging directory, and the thumbnail fallback for sites
 * without a native thumbnail source.
 */
import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fail, metaError, ok, type MetaArtifact, type MetaErrorKind, type Result} from './errors.js'
import type {YtdlpCaptionInfo} from './tracks.js'
import type {Chapter, LiveStatus, Metadata, ThumbnailRef} from './types.js'

export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000

export type ExecResult = {code: number | null; stdout: string; stderr: string; timedOut: boolean}
export type Exec = (bin: string, args: string[], opts: {timeoutMs: number}) => Promise<ExecResult>

export type ProbeInfo = {
  id: string | null
  extractorKey: string | null
  webpageUrl: string | null
  metadata: Metadata
  thumbnail: ThumbnailRef | null
  captions: YtdlpCaptionInfo
}

export type YtdlpRunner = {
  probe(url: string): Promise<Result<ProbeInfo>>
  /** Download exactly one track; resolves to the file's absolute path. */
  captions(opts: {url: string; ytdlpKey: string; format: string; stagingDir: string}): Promise<Result<string>>
  /** Save the best thumbnail; resolves to the file's absolute path. */
  thumbnail(opts: {url: string; stagingDir: string}): Promise<Result<string>>
}

export type RunnerOptions = {
  ytdlp: string
  /** Passed as --ffmpeg-location when set (findFfmpeg returns undefined for PATH ffmpeg). */
  ffmpegLocation?: string
  /** Add --convert-thumbnails jpg (needs ffmpeg on PATH or bundled). */
  convertThumbnails: boolean
  sleepSubtitlesSec: number
  timeoutMs?: number
  exec?: Exec
}

export function createYtdlpRunner(options: RunnerOptions): YtdlpRunner {
  const exec = options.exec ?? execProcess
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS
  const common = ['--no-playlist', '--skip-download']
  const ffmpeg = options.ffmpegLocation ? ['--ffmpeg-location', options.ffmpegLocation] : []

  return {
    async probe(url) {
      const result = await exec(options.ytdlp, ['-J', '--no-warnings', ...common, url], {timeoutMs})
      if (result.code !== 0 || result.timedOut) return fail(classifyFailure('metadata', result))
      let raw: RawInfo
      try {
        raw = JSON.parse(result.stdout) as RawInfo
      } catch {
        return fail(metaError('metadata', 'parse', 'could not parse yt-dlp JSON output'))
      }
      return ok(extractInfo(raw))
    },

    async captions({url, ytdlpKey, format, stagingDir}) {
      const args = [
        ...common,
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        `^${escapeRegex(ytdlpKey)}$`,
        '--sub-format',
        format,
        '--sleep-subtitles',
        String(options.sleepSubtitlesSec),
        '--sleep-requests',
        '0.75',
        '--force-overwrites',
        '-o',
        path.join(stagingDir, 'captions.%(ext)s'),
        url,
      ]
      // no --no-warnings: the "PO token" refusal is only ever a warning
      const result = await exec(options.ytdlp, args, {timeoutMs})
      if (result.code !== 0 || result.timedOut) return fail(classifyFailure('captions', result))
      const file = await findProduced(stagingDir, (name) => name.startsWith('captions.') && name.endsWith(`.${format}`))
      if (file) return ok(file)
      if (/po.?token/i.test(result.stderr)) {
        return fail(metaError('captions', 'login_required', lastLine(result.stderr) || 'YouTube requires a PO token for subtitles'))
      }
      return fail(metaError('captions', 'provider', lastLine(result.stderr) || 'yt-dlp wrote no caption file'))
    },

    async thumbnail({url, stagingDir}) {
      const args = [
        ...common,
        '--no-warnings',
        '--write-thumbnail',
        ...(options.convertThumbnails ? ['--convert-thumbnails', 'jpg'] : []),
        ...ffmpeg,
        '-o',
        path.join(stagingDir, 'thumb.%(ext)s'),
        url,
      ]
      const result = await exec(options.ytdlp, args, {timeoutMs})
      if (result.code !== 0 || result.timedOut) return fail(classifyFailure('thumbnail', result))
      const file = await findProduced(stagingDir, (name) => name.startsWith('thumb.') && !name.endsWith('.part'))
      return file ? ok(file) : fail(metaError('thumbnail', 'unavailable', 'yt-dlp found no thumbnail'))
    },
  }
}

async function findProduced(dir: string, match: (name: string) => boolean): Promise<string | null> {
  const names = (await fs.readdir(dir)).filter(match).sort()
  return names.length > 0 ? path.join(dir, names[0]!) : null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lastLine(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
  const errors = lines.filter((l) => l.startsWith('ERROR:'))
  const line = errors.at(-1) ?? lines.at(-1) ?? ''
  return line.replace(/^(ERROR|WARNING):\s*(\[[^\]]+\]\s*)?/, '')
}

/** Map a failed yt-dlp run to an error kind from its stderr (exported for tests). */
export function classifyFailure(artifact: MetaArtifact, result: ExecResult) {
  const kind = classifyStderr(result.stderr, result.timedOut)
  const detail = result.timedOut ? 'yt-dlp timed out' : lastLine(result.stderr) || `yt-dlp exited with code ${result.code}`
  return metaError(artifact, kind, detail)
}

export function classifyStderr(stderr: string, timedOut: boolean): MetaErrorKind {
  if (timedOut) return 'timeout'
  if (/HTTP Error 429/.test(stderr)) return 'rate_limited'
  if (/sign in to confirm|login required|requires? (?:a )?login|cookies|po.?token|not a bot|age[- ]restricted|private video|members[- ]only/i.test(stderr)) {
    return 'login_required'
  }
  if (/video unavailable|has been removed|does not exist|no longer available|HTTP Error 404|not found/i.test(stderr)) {
    return 'not_found'
  }
  if (/unable to download|connection|timed out|network|HTTP Error 5\d\d|EOF occurred|Remote end closed/i.test(stderr)) {
    return 'network'
  }
  return 'provider'
}

// ---------------------------------------------------------------------------
// -J field extraction
// ---------------------------------------------------------------------------

type RawThumb = {url?: string; width?: number; height?: number; preference?: number}
export type RawInfo = {
  id?: string
  extractor_key?: string
  webpage_url?: string
  title?: string
  description?: string
  channel?: string
  uploader?: string
  channel_id?: string
  uploader_id?: string
  timestamp?: number
  release_timestamp?: number
  upload_date?: string
  duration?: number
  language?: string
  live_status?: string
  chapters?: {title?: string; start_time?: number; end_time?: number}[] | null
  thumbnail?: string
  thumbnails?: RawThumb[]
  subtitles?: YtdlpCaptionInfo['subtitles']
  automatic_captions?: YtdlpCaptionInfo['automatic_captions']
}

export function extractInfo(raw: RawInfo): ProbeInfo {
  return {
    id: raw.id ?? null,
    extractorKey: raw.extractor_key ?? null,
    webpageUrl: raw.webpage_url ?? null,
    metadata: {
      title: raw.title ?? null,
      description: raw.description ?? null,
      channel: raw.channel ?? raw.uploader ?? null,
      channelId: raw.channel_id ?? raw.uploader_id ?? null,
      publishedAt: publishedAt(raw),
      durationSec: typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? Math.round(raw.duration) : null,
      audioLanguage: raw.language ?? null,
      liveStatus: liveStatusOf(raw.live_status),
      chapters: chaptersOf(raw.chapters),
    },
    thumbnail: bestThumbnail(raw),
    captions: {extractor_key: raw.extractor_key, subtitles: raw.subtitles, automatic_captions: raw.automatic_captions},
  }
}

function publishedAt(raw: RawInfo): string | null {
  const ts = raw.timestamp ?? raw.release_timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw.upload_date ?? '')
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : null
}

function liveStatusOf(value: string | undefined): LiveStatus {
  switch (value) {
    case 'is_live':
      return 'live'
    case 'is_upcoming':
      return 'upcoming'
    case 'was_live':
      return 'was_live'
    case 'post_live':
      return 'post_live'
    default:
      return 'none'
  }
}

function chaptersOf(raw: RawInfo['chapters']): Chapter[] | null {
  if (!Array.isArray(raw)) return null
  const chapters: Chapter[] = []
  for (const c of raw) {
    if (typeof c?.start_time !== 'number') continue
    chapters.push({title: c.title ?? null, startSec: c.start_time, endSec: typeof c.end_time === 'number' ? c.end_time : null})
  }
  return chapters
}

function bestThumbnail(raw: RawInfo): ThumbnailRef | null {
  const list = (raw.thumbnails ?? []).filter((t): t is RawThumb & {url: string} => typeof t?.url === 'string')
  if (raw.thumbnail) {
    const match = list.find((t) => t.url === raw.thumbnail)
    return {url: raw.thumbnail, width: match?.width ?? null, height: match?.height ?? null}
  }
  if (list.length === 0) return null
  const best = [...list].sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0) || (b.width ?? 0) - (a.width ?? 0))[0]!
  return {url: best.url, width: best.width ?? null, height: best.height ?? null}
}

// ---------------------------------------------------------------------------
// process runner
// ---------------------------------------------------------------------------

export const execProcess: Exec = (bin, args, {timeoutMs}) =>
  new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, {stdio: ['ignore', 'pipe', 'pipe']})
    } catch (error) {
      resolve({code: null, stdout: '', stderr: `ERROR: ${error instanceof Error ? error.message : String(error)}`, timedOut: false})
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({code: null, stdout: '', stderr: `ERROR: ${error.message}`, timedOut})
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut})
    })
  })
