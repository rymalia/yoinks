/**
 * Entry point for `yoinks meta`: real dependencies, output, exit code. The
 * TUI's `cli.tsx` hands over here before it touches its own flags or the
 * terminal.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {findFfmpeg, ensureYtDlp, hasFfmpeg} from '../ytdlp.js'
import {META_HELP, parseMetaArgs, resolveInputs} from './args.js'
import {registerSecret, sanitize} from './errors.js'
import {realSleep} from './pacing.js'
import {runMeta, type RunDeps} from './run.js'
import type {MetaItem} from './types.js'
import {createYtdlpRunner} from './ytdlp-meta.js'

export type MetaIo = {
  stdout: (text: string) => Promise<void>
  stderr: (text: string) => void
  readStdin: () => string
  env: NodeJS.ProcessEnv
  version: string
}

export const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Downloads', 'yoinks-meta')

/** Returns the process exit code: 0 ok, 1 an item failed, 2 usage. */
export async function metaMain(argv: string[], io: MetaIo): Promise<0 | 1 | 2> {
  const parsed = parseMetaArgs(argv)
  if (!parsed.ok) {
    io.stderr(`yoinks meta: ${parsed.error}\nTry “yoinks meta --help” for usage.\n`)
    return 2
  }
  if (parsed.args.help) {
    await io.stdout(META_HELP)
    return 0
  }
  const inputs = resolveInputs(parsed.args, {readFile: (p) => fs.readFileSync(p, 'utf8'), readStdin: io.readStdin})
  if (!inputs.ok) {
    io.stderr(`yoinks meta: ${inputs.error}\n`)
    return 2
  }
  const args = parsed.args

  try {
    const ytdlp = await ensureYtDlp((message) => io.stderr(`${message}\n`))
    const [ffmpegLocation, ffmpeg] = await Promise.all([findFfmpeg(), hasFfmpeg()])
    const apiKey = io.env.YOUTUBE_API_KEY?.trim() || null
    registerSecret(apiKey)
    const deps: RunDeps = {
      apiKey,
      fetch: globalThis.fetch,
      sleep: realSleep,
      rand: Math.random,
      now: () => new Date(),
      ytdlp: createYtdlpRunner({ytdlp, ffmpegLocation, convertThumbnails: ffmpeg, sleepSubtitlesSec: args.sleepSec}),
      fs: {
        mkdir: (dir) => fsp.mkdir(dir, {recursive: true}).then(() => undefined),
        writeFile: (file, data) => fsp.writeFile(file, data),
        readFile: (file) => fsp.readFile(file, 'utf8'),
        rename: (from, to) => fsp.rename(from, to),
        rm: (target) => fsp.rm(target, {recursive: true, force: true}),
      },
      log: (line) => io.stderr(`${line}\n`),
      version: io.version,
      pid: process.pid,
    }
    const outputDir = path.resolve(args.outputDir ?? DEFAULT_OUTPUT_DIR)
    const {document, exitCode} = await runMeta(
      {
        inputs: inputs.inputs,
        subs: args.subs,
        subLangs: args.subLangs,
        subFormat: args.subFormat,
        thumbnail: args.thumbnail,
        outputDir,
        sleepSec: args.sleepSec,
      },
      deps,
    )
    await io.stdout(args.json ? `${JSON.stringify(document, null, 2)}\n` : document.items.map(formatItem).join(''))
    return exitCode
  } catch (error) {
    // the only place a raw error can surface; keep the key out of it
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    io.stderr(`yoinks meta: ${sanitize(text)}\n`)
    return 1
  }
}

/** One line per item for a terminal; the JSON document is the scriptable form. */
export function formatItem(item: MetaItem): string {
  const failed = item.errors.some((e) => e.kind !== 'unavailable')
  const label = oneLine(item.videoId ?? item.inputUrl)
  const parts = [`${failed ? '✗' : '✓'} ${label}  ${oneLine(item.metadata?.title ?? '(no title)')}`]
  if (item.captions && item.captions.length > 0) parts.push(`captions: ${item.captions.map((c) => `${c.sourceLang}.${c.kind}`).join(', ')}`)
  if (item.thumbnail) parts.push(`thumbnail: ${path.basename(item.thumbnail.path)}`)
  for (const w of item.warnings) parts.push(`~ ${w.artifact} ${w.kind}: ${oneLine(w.message)}`)
  for (const e of item.errors) parts.push(`! ${e.artifact} ${e.kind}: ${oneLine(e.message)}`)
  return `${parts.join('  ·  ')}\n`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
