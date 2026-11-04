import {spawn, type ChildProcess} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'
import {isPortrait} from './naming.js'

const YOINKS_DIR = path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

/** Like commandWorks, but returns trimmed stdout on success (undefined on any failure). */
function commandOutput(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000})
    } catch {
      resolve(undefined)
      return
    }
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', () => resolve(undefined))
    child.on('close', code => resolve(code === 0 ? out.trim() : undefined))
  })
}

/**
 * Resolve a usable yt-dlp binary: system install first, then a previously
 * downloaded copy, then download the standalone binary from GitHub releases.
 *
 * The downloaded copy is ours to keep current (a system install is the user's
 * package manager's job). Old builds miss extractor fixes and, before
 * 2026.10.21, carried a certifi bundle open to MITM — so at most once per
 * UPDATE_CHECK_INTERVAL_MS we compare it against the latest release and swap
 * in the new binary. Any failure there keeps the working copy we already have.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  if (await commandWorks('yt-dlp', ['--version'])) return 'yt-dlp'

  const local = path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  const localVersion = await commandOutput(local, ['--version'])
  if (localVersion !== undefined) {
    await maybeUpdateYtDlp(local, localVersion, onStatus, signal)
    return local
  }

  onStatus('first run: fetching yt-dlp…')
  await downloadYtDlp(local, signal)
  return local
}

const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const UPDATE_CHECK_TIMEOUT_MS = 5_000
const LATEST_RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest'

/** Whether the cached binary was last downloaded or verified long enough ago to check again. */
export function isUpdateCheckDue(lastVerifiedMs: number, nowMs: number): boolean {
  // a clock that moved backwards (or a future mtime) shouldn't suppress checks forever
  return nowMs - lastVerifiedMs >= UPDATE_CHECK_INTERVAL_MS || lastVerifiedMs > nowMs
}

/** ".../releases/latest" redirects to ".../releases/tag/<version>"; pull the version out. */
export function releaseTagFromUrl(url: string): string | undefined {
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(url)?.[1]
  return tag ? decodeURIComponent(tag) : undefined
}

/** Exported for tests; ensureYtDlp is the real entry point. */
export async function maybeUpdateYtDlp(
  local: string,
  localVersion: string,
  onStatus: (message: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  // the binary's mtime doubles as "last verified": set by the download, and
  // touched after a check that found nothing newer
  let lastVerifiedMs: number
  try {
    lastVerifiedMs = (await fs.stat(local)).mtimeMs
  } catch {
    return
  }
  const now = Date.now()
  if (!isUpdateCheckDue(lastVerifiedMs, now)) return

  onStatus('checking for yt-dlp updates…')
  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      method: 'HEAD',
      redirect: 'follow',
      signal: withTimeout(signal, UPDATE_CHECK_TIMEOUT_MS),
    })
    const latest = response.ok ? releaseTagFromUrl(response.url) : undefined
    if (!latest) return // GitHub answered oddly; try again next run
    if (latest !== localVersion) {
      onStatus(`updating yt-dlp ${localVersion} → ${latest}…`)
      await downloadYtDlp(local, signal)
    } else {
      const nowDate = new Date(now)
      await fs.utimes(local, nowDate, nowDate)
    }
  } catch (error) {
    // the user cancelled: let that propagate like any other cancel
    if (signal?.aborted) throw error
    // offline, slow, or GitHub down — the cached copy still works, and since
    // its mtime is unchanged we'll try again next run
  }
}

/** Download the standalone binary to a temp file and rename it over `local`. */
async function downloadYtDlp(local: string, signal?: AbortSignal): Promise<void> {
  await fs.mkdir(path.dirname(local), {recursive: true})

  const url = `${RELEASE_BASE}/${ytDlpAssetName()}`
  const response = await fetch(url, {signal})
  if (!response.ok || !response.body) {
    throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
  }

  const tmp = `${local}.download`
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
    await fs.chmod(tmp, 0o755)
    await fs.rename(tmp, local)
  } catch (error) {
    await fs.rm(tmp, {force: true})
    throw error
  }
}

/** An AbortSignal that fires on the caller's abort or after `ms`, whichever comes first. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted || timeout.aborted) abort()
  signal.addEventListener('abort', abort, {once: true})
  timeout.addEventListener('abort', abort, {once: true})
  return controller.signal
}

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. Returns undefined if neither exists — yt-dlp
 * still works for single-file formats without it.
 */
export async function findFfmpeg(): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'])) return undefined // on PATH, yt-dlp finds it itself
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return ffmpegPath
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return undefined
}

/** Whether yt-dlp will find an ffmpeg at all: on PATH, or the bundled ffmpeg-static. */
export async function hasFfmpeg(): Promise<boolean> {
  if (await commandWorks('ffmpeg', ['-version'])) return true
  return (await findFfmpeg()) !== undefined
}

export type VideoInfo = {
  title: string
  id?: string
  uploader?: string
  duration?: number
  webpage_url?: string
  extractor?: string
  extractor_key?: string
  width?: number
  height?: number
  formats?: RawFormat[]
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number
  width?: number
  abr?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
}

export type ProbeResult = {
  info: VideoInfo
  /** Raw -J output saved to disk so downloads can skip re-extraction via --load-info-json. */
  infoJsonPath: string
}

export async function probe(ytdlp: string, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(ytdlp, ['-J', '--no-playlist', '--no-warnings', url], {signal})
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      } else {
        resolve(out)
      }
    })
  })

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  const infoJsonPath = path.join(os.tmpdir(), `yoinks-info-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)
  return {info, infoJsonPath}
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

export function buildChoices(info: VideoInfo): DownloadChoice[] {
  const formats = info.formats ?? []
  const choices: DownloadChoice[] = []
  const dim = isPortrait(info) ? 'width' : 'height'

  const audioOnly = formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0]
  const audioSize = bestAudio?.filesize ?? bestAudio?.filesize_approx

  const videos = formats.filter(f => f.vcodec && f.vcodec !== 'none' && typeof f[dim] === 'number' && f[dim]! > 0)
  const dimensions = [...new Set(videos.map(f => f[dim] as number))].sort((a, b) => b - a)

  for (const short of dimensions.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f[dim] === short)
    const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const muxed = best.acodec && best.acodec !== 'none'
    const size = (best.filesize ?? best.filesize_approx ?? 0) + (muxed ? 0 : audioSize ?? 0)
    const sizeLabel = size > 0 ? ` · ~${formatBytes(size)}` : ''
    choices.push({
      kind: 'video',
      label: `${short}p · mp4${sizeLabel}`,
      args: [
        '-f',
        `bv*[${dim}=${short}]+ba/b[${dim}=${short}]/bv*[${dim}<=${short}]+ba/b`,
        '--merge-output-format',
        'mp4',
      ],
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  const audioSizeLabel = audioSize ? ` · ~${formatBytes(audioSize)}` : ''
  choices.push({
    kind: 'audio',
    label: `audio only · mp3${audioSizeLabel}`,
    args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  })

  return choices
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

const PROGRESS_PREFIX = 'YOINK|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild?.kill('SIGTERM'))

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
    infoJsonPath?: string
    choice: DownloadChoice
    outDir: string
    outputTemplate: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    path.join(opts.outDir, opts.outputTemplate),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    const child = spawn(opts.ytdlp, args, {signal})
    activeChild = child

    let stderr = ''
    let filepath = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''
    // every file yt-dlp writes this run, so a cancel can clean up after itself
    const destinations: string[] = []

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          })
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) destinations.push(target)
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          destinations.push(line.slice('[download] Destination: '.length))
        } else if (path.isAbsolute(line)) {
          filepath = line
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      activeChild = undefined
      if (signal?.aborted) {
        // cancelled on purpose — don't leave half-written files behind
        void removePartials(destinations)
        reject(new Error('Download cancelled.'))
        return
      }
      if (code === 0 && filepath) {
        resolve(filepath)
      } else {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
      }
    })
  })
}

function removePartials(destinations: string[]): Promise<unknown> {
  return Promise.allSettled(
    destinations
      .flatMap(dest => [dest, `${dest}.part`, `${dest}.ytdl`])
      .map(file => fs.rm(file, {force: true})),
  )
}

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
