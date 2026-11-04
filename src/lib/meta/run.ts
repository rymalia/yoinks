/**
 * Orchestrates one `yoinks meta` batch into a schema-1 document. Every
 * side effect comes through {@link RunDeps}, so the tests run with fakes and
 * no network, no yt-dlp and no sleeping.
 */
import path from 'node:path'
import type {SubFormat} from './args.js'
import {metaError, registerSecret, type MetaError, type Result} from './errors.js'
import {artifactStem, youtubeVideoId, youtubeWatchUrl} from './ids.js'
import {backoffMs, CaptionBreaker, withJitter, type Sleep} from './pacing.js'
import {fetchImage, fetchYoutubeThumbnail, type FetchedImage} from './thumbnail.js'
import {availableLanguages, candidatesFromYtdlp, selectTracks, type SelectedTrack} from './tracks.js'
import {transcriptText} from './transcript.js'
import type {CaptionOutput, MetaDocument, MetaItem, ThumbnailOutput} from './types.js'
import {API_BATCH, fetchVideos, type ApiVideo} from './youtube-api.js'
import type {ProbeInfo, YtdlpRunner} from './ytdlp-meta.js'

export type RunOptions = {
  inputs: string[]
  subs: boolean
  subLangs: string[]
  subFormat: SubFormat
  thumbnail: boolean
  outputDir: string
  sleepSec: number
}

export type RunFs = {
  mkdir(dir: string): Promise<void>
  writeFile(file: string, data: Uint8Array | string): Promise<void>
  readFile(file: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  rm(target: string): Promise<void>
}

export type RunDeps = {
  apiKey: string | null
  fetch: typeof globalThis.fetch
  sleep: Sleep
  rand: () => number
  now: () => Date
  ytdlp: YtdlpRunner
  fs: RunFs
  /** Progress and diagnostics; never stdout. */
  log: (line: string) => void
  version: string
  pid: number
}

export type RunResult = {document: MetaDocument; exitCode: 0 | 1}

const MAX_CAPTION_RUNS = 3

export async function runMeta(opts: RunOptions, deps: RunDeps): Promise<RunResult> {
  registerSecret(deps.apiKey)
  const wantArtifacts = opts.subs || opts.thumbnail
  if (wantArtifacts) await deps.fs.mkdir(opts.outputDir)

  const api = await prefetchApi(opts.inputs, deps)
  const breaker = new CaptionBreaker()
  const items: MetaItem[] = []
  let staging = 0
  const pacer = new Pacer(opts.sleepSec, deps)
  const withStaging = <T>(work: (dir: string) => Promise<T>) => useStaging(stagingDir(opts.outputDir, deps.pid, staging++), deps.fs, work)

  for (const inputUrl of opts.inputs) {
    const item = emptyItem(inputUrl)
    const videoId = item.videoId
    const apiVideo = videoId ? api.videos.get(videoId) : undefined
    if (videoId && api.active) item.warnings.push(...api.warningsFor(videoId))

    // -- metadata ---------------------------------------------------------
    let probe: Result<ProbeInfo> | null = null
    const needProbe = async (): Promise<Result<ProbeInfo>> => {
      if (!probe) {
        probe = await deps.ytdlp.probe(inputUrl)
        if (probe.ok) {
          item.extractor ??= probe.value.extractorKey?.toLowerCase() ?? null
          item.webpageUrl ??= probe.value.webpageUrl
        }
      }
      return probe
    }

    let knownMissing = false
    if (apiVideo) {
      item.metadata = apiVideo.metadata
      item.providers.metadata = 'youtube-api'
    } else if (videoId && api.active && api.succeededFor(videoId)) {
      // the API answered for this batch but left the id out: private or removed
      knownMissing = true
      item.errors.push(metaError('metadata', 'not_found', 'video not found by the Data API (private or removed)'))
    } else {
      const result = await needProbe()
      if (result.ok) {
        item.metadata = result.value.metadata
        item.providers.metadata = 'ytdlp'
      } else {
        item.errors.push(result.error)
      }
    }

    // -- captions ---------------------------------------------------------
    if (opts.subs) {
      if (knownMissing) {
        item.errors.push(metaError('captions', 'not_found', 'video not found by the Data API (private or removed)'))
      } else if (breaker.open) {
        item.errors.push(metaError('captions', 'circuit_open', 'caption fetching paused for the rest of the run after repeated rate limits'))
      } else {
        const outcome = await captionsFor(item, inputUrl, opts, deps, needProbe, withStaging, pacer)
        breaker.record(outcome)
        if (breaker.open && outcome === 'rate_limited') deps.log('captions: two consecutive rate limits; skipping captions for the remaining items')
      }
    }

    // -- thumbnail --------------------------------------------------------
    if (opts.thumbnail) {
      if (knownMissing) {
        item.errors.push(metaError('thumbnail', 'not_found', 'video not found by the Data API (private or removed)'))
      } else {
        await thumbnailFor(item, inputUrl, apiVideo, opts, deps, needProbe, withStaging, pacer)
      }
    }

    items.push(item)
  }

  const document: MetaDocument = {
    schema: 1,
    generatedAt: deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    yoinksVersion: deps.version,
    items,
  }
  const failed = items.some((item) => item.errors.some((e) => e.kind !== 'unavailable'))
  return {document, exitCode: failed ? 1 : 0}
}

export function emptyItem(inputUrl: string): MetaItem {
  const videoId = youtubeVideoId(inputUrl)
  return {
    inputUrl,
    videoId,
    extractor: videoId ? 'youtube' : null,
    webpageUrl: videoId ? youtubeWatchUrl(videoId) : null,
    metadata: null,
    captions: null,
    thumbnail: null,
    providers: {metadata: null, captions: null, thumbnail: null},
    warnings: [],
    errors: [],
  }
}

// ---------------------------------------------------------------------------
// Data API prefetch: all YouTube ids, ≤50 per request, before the item loop
// ---------------------------------------------------------------------------

type ApiState = {
  active: boolean
  videos: Map<string, ApiVideo>
  succeededFor(videoId: string): boolean
  warningsFor(videoId: string): MetaError[]
}

async function prefetchApi(inputs: string[], deps: RunDeps): Promise<ApiState> {
  const videos = new Map<string, ApiVideo>()
  const answered = new Set<string>()
  const warnings = new Map<string, MetaError[]>()
  const state: ApiState = {
    active: deps.apiKey !== null,
    videos,
    succeededFor: (id) => answered.has(id),
    warningsFor: (id) => warnings.get(id) ?? [],
  }
  if (!deps.apiKey) return state

  const ids = [...new Set(inputs.map(youtubeVideoId).filter((id): id is string => id !== null))]
  let disabled: MetaError | null = null
  for (let start = 0; start < ids.length; start += API_BATCH) {
    const batch = ids.slice(start, start + API_BATCH)
    if (disabled) {
      for (const id of batch) warnings.set(id, [disabled])
      continue
    }
    const result = await fetchVideos(batch, {key: deps.apiKey, fetch: deps.fetch, sleep: deps.sleep, rand: deps.rand, now: () => deps.now().getTime()})
    if (result.ok) {
      for (const [id, video] of result.value) videos.set(id, video)
      for (const id of batch) answered.add(id)
      continue
    }
    // Any API failure means yt-dlp for this batch; quota and auth failures
    // also disable the API for the rest of the run.
    const warning = metaError('metadata', result.error.kind, `${result.error.message}; used yt-dlp`, {retryable: result.error.retryable})
    for (const id of batch) warnings.set(id, [warning])
    if (result.error.kind === 'quota' || result.error.kind === 'auth') {
      disabled = warning
      deps.log(`Data API: ${result.error.message}; using yt-dlp for the rest of the run`)
    }
  }
  return state
}

// ---------------------------------------------------------------------------
// captions
// ---------------------------------------------------------------------------

type CaptionOutcome = 'rate_limited' | 'ok' | 'unavailable' | 'other'

async function captionsFor(
  item: MetaItem,
  inputUrl: string,
  opts: RunOptions,
  deps: RunDeps,
  needProbe: () => Promise<Result<ProbeInfo>>,
  withStaging: <T>(work: (dir: string) => Promise<T>) => Promise<T>,
  pacer: Pacer,
): Promise<CaptionOutcome> {
  const probe = await needProbe()
  if (!probe.ok) {
    // a failed probe is not a caption attempt, so it never counts toward the breaker
    item.errors.push(metaError('captions', probe.error.kind, probe.error.message, {retryable: probe.error.retryable}))
    return 'other'
  }
  // yt-dlp distinguishes post_live; the Data API reports an ended stream as none
  const probeLive = probe.value.metadata.liveStatus
  const live = probeLive !== 'none' ? probeLive : (item.metadata?.liveStatus ?? probeLive)
  if (live !== 'none' && live !== 'was_live') {
    item.captions = []
    item.errors.push(metaError('captions', 'unavailable', `captions are not complete while the video is ${live}`))
    return 'unavailable'
  }

  const candidates = candidatesFromYtdlp(probe.value.captions, opts.subFormat)
  const audioLanguage = item.metadata?.audioLanguage ?? probe.value.metadata.audioLanguage
  const {selected, missing} = selectTracks(candidates, opts.subLangs, audioLanguage)
  if (missing.length > 0) {
    const have = availableLanguages(candidates)
    item.errors.push(
      metaError(
        'captions',
        'unavailable',
        have.length > 0 ? `no caption tracks in: ${missing.join(', ')} (available: ${have.join(', ')})` : `no caption tracks in: ${missing.join(', ')}`,
      ),
    )
  }
  if (selected.length === 0) {
    item.captions = []
    return 'unavailable'
  }

  const stem = artifactStem({videoId: item.videoId, extractorKey: probe.value.extractorKey, id: probe.value.id, inputUrl})
  const written: CaptionOutput[] = []
  let outcome: CaptionOutcome = 'ok'
  for (const track of selected) {
    await pacer.wait()
    const result = await downloadTrack(track, inputUrl, opts, deps, withStaging)
    pacer.mark()
    if (!result.ok) {
      item.errors.push(result.error)
      if (result.error.kind === 'rate_limited') outcome = 'rate_limited'
      else if (outcome !== 'rate_limited') outcome = 'other'
      continue
    }
    const target = path.join(opts.outputDir, `${stem}.${track.sourceLang}.${track.kind}.${opts.subFormat}`)
    try {
      await deps.fs.rename(result.value, target)
    } catch (error) {
      await deps.fs.rm(result.value).catch(() => undefined)
      item.errors.push(metaError('captions', 'provider', `could not place caption file: ${describe(error)}`))
      if (outcome !== 'rate_limited') outcome = 'other'
      continue
    }
    let text = ''
    try {
      text = transcriptText(opts.subFormat, await deps.fs.readFile(target))
    } catch (error) {
      item.warnings.push(metaError('captions', 'parse', `caption file saved but not readable as text: ${describe(error)}`))
    }
    written.push({
      sourceLang: track.sourceLang,
      requestedLangs: track.requestedLangs,
      kind: track.kind,
      translated: track.translated,
      vssId: track.vssId,
      name: track.name,
      format: opts.subFormat,
      path: target,
      text,
    })
  }
  if (written.length > 0) {
    item.captions = written
    item.providers.captions = 'ytdlp'
  }
  return outcome === 'ok' && missing.length > 0 && written.length === 0 ? 'unavailable' : outcome
}

async function downloadTrack(
  track: SelectedTrack,
  inputUrl: string,
  opts: RunOptions,
  deps: RunDeps,
  withStaging: <T>(work: (dir: string) => Promise<T>) => Promise<T>,
): Promise<Result<string>> {
  if (!track.ytdlpKey) return {ok: false, error: metaError('captions', 'provider', 'track has no yt-dlp key'), warnings: []}
  let last: Result<string> | null = null
  for (let run = 1; run <= MAX_CAPTION_RUNS; run++) {
    let result: Result<string>
    try {
      result = await withStaging(async (dir) => {
        const produced = await deps.ytdlp.captions({url: inputUrl, ytdlpKey: track.ytdlpKey!, format: opts.subFormat, stagingDir: dir})
        if (!produced.ok) return produced
        // move out of staging before the directory is dropped
        const kept = path.join(opts.outputDir, `${path.basename(dir)}-${path.basename(produced.value)}`) // dir already starts with a dot
        await deps.fs.rename(produced.value, kept)
        return {ok: true, value: kept, warnings: produced.warnings}
      })
    } catch (error) {
      return {ok: false, error: metaError('captions', 'provider', `caption staging failed: ${describe(error)}`), warnings: []}
    }
    if (result.ok) return result
    last = result
    if (result.error.kind !== 'rate_limited' || run === MAX_CAPTION_RUNS) break
    deps.log(`captions: rate limited (attempt ${run}/${MAX_CAPTION_RUNS}); backing off`)
    await deps.sleep(backoffMs(run, deps.rand))
  }
  return last!
}

// ---------------------------------------------------------------------------
// thumbnail
// ---------------------------------------------------------------------------

async function thumbnailFor(
  item: MetaItem,
  inputUrl: string,
  apiVideo: ApiVideo | undefined,
  opts: RunOptions,
  deps: RunDeps,
  needProbe: () => Promise<Result<ProbeInfo>>,
  withStaging: <T>(work: (dir: string) => Promise<T>) => Promise<T>,
  pacer: Pacer,
): Promise<void> {
  const fetchDeps = {fetch: deps.fetch, sleep: deps.sleep, rand: deps.rand, now: () => deps.now().getTime()}
  const stemFor = (p: ProbeInfo | null) => artifactStem({videoId: item.videoId, extractorKey: p?.extractorKey, id: p?.id, inputUrl})

  const place = async (image: FetchedImage & {url: string}, provider: 'youtube-api' | 'ytimg', hint?: {width: number | null; height: number | null}) => {
    const target = path.join(opts.outputDir, `${stemFor(null)}.thumb.${image.ext}`)
    const tmp = `${target}.tmp-${deps.pid}`
    await deps.fs.writeFile(tmp, image.bytes)
    try {
      await deps.fs.rename(tmp, target)
    } catch (error) {
      await deps.fs.rm(tmp)
      throw error
    }
    item.thumbnail = {url: image.url, width: image.width ?? hint?.width ?? null, height: image.height ?? hint?.height ?? null, path: target}
    item.providers.thumbnail = provider
  }

  try {
    if (apiVideo?.thumbnail) {
      await pacer.wait()
      const result = await fetchImage(apiVideo.thumbnail.url, fetchDeps)
      pacer.mark()
      if (result.ok) return await place({...result.value, url: apiVideo.thumbnail.url}, 'youtube-api', apiVideo.thumbnail)
      item.warnings.push(metaError('thumbnail', result.error.kind, `${result.error.message}; trying yt-dlp`, {retryable: result.error.retryable}))
    } else if (item.videoId) {
      await pacer.wait()
      const result = await fetchYoutubeThumbnail(item.videoId, fetchDeps)
      pacer.mark()
      if (result.ok) return await place(result.value, 'ytimg')
      item.warnings.push(metaError('thumbnail', result.error.kind, `${result.error.message}; trying yt-dlp`, {retryable: result.error.retryable}))
    }

    // yt-dlp fallback (and the only path for other sites)
    const probe = await needProbe()
    if (!probe.ok) {
      item.errors.push(metaError('thumbnail', probe.error.kind, probe.error.message, {retryable: probe.error.retryable}))
      return
    }
    const placed = await withStaging(async (dir) => {
      const result = await deps.ytdlp.thumbnail({url: inputUrl, stagingDir: dir})
      if (!result.ok) return result
      const ext = path.extname(result.value).slice(1) || 'img'
      const target = path.join(opts.outputDir, `${stemFor(probe.value)}.thumb.${ext}`)
      await deps.fs.rename(result.value, target)
      return {ok: true as const, value: target, warnings: result.warnings}
    })
    if (!placed.ok) {
      item.errors.push(placed.error)
      return
    }
    const target = placed.value
    const ref = probe.value.thumbnail
    const out: ThumbnailOutput = {url: ref?.url ?? '', width: ref?.width ?? null, height: ref?.height ?? null, path: target}
    item.thumbnail = out
    item.providers.thumbnail = 'ytdlp'
  } catch (error) {
    item.errors.push(metaError('thumbnail', 'provider', error))
  }
}

function stagingDir(outputDir: string, pid: number, n: number): string {
  return path.join(outputDir, `.yoinks-staging-${pid}-${n}`)
}

/**
 * A fresh staging directory for one yt-dlp run: anything left there by an
 * earlier crash is removed first, and the directory is removed afterwards
 * whether the work succeeded, failed or threw.
 */
async function useStaging<T>(dir: string, fs: RunFs, work: (dir: string) => Promise<T>): Promise<T> {
  await fs.rm(dir)
  await fs.mkdir(dir)
  try {
    return await work(dir)
  } finally {
    await fs.rm(dir).catch(() => undefined)
  }
}

/** `--sleep` with jitter between network fetches to YouTube hosts (captions and ytimg). */
class Pacer {
  private fetched = false
  constructor(
    private readonly sleepSec: number,
    private readonly deps: Pick<RunDeps, 'sleep' | 'rand'>,
  ) {}

  /** Pause before a fetch, unless it is the first of the run. */
  async wait(): Promise<void> {
    if (this.fetched && this.sleepSec > 0) await this.deps.sleep(withJitter(this.sleepSec * 1000, this.deps.rand))
  }

  mark(): void {
    this.fetched = true
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
