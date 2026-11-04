/**
 * Argument parsing for `yoinks meta` — separate from `src/lib/args.ts` so the
 * download TUI's flags and usage errors are untouched.
 *
 * Usage errors here exit 2 (the TUI's exit 1), so a caller can tell a bad
 * invocation from a run that had failing items.
 */
import {collectInputs} from './ids.js'

export type SubFormat = 'json3' | 'vtt'

export type MetaArgs = {
  help: boolean
  urls: string[]
  /** Path of a URL list, or `-` for stdin. */
  file: string | null
  json: boolean
  subs: boolean
  subLangs: string[]
  subFormat: SubFormat
  thumbnail: boolean
  outputDir: string | null
  /** Seconds to wait between caption fetches (jitter is added later). */
  sleepSec: number
}

export type MetaArgsResult = {ok: true; args: MetaArgs} | {ok: false; error: string}

export const DEFAULT_SUB_LANGS = ['en']
export const DEFAULT_SLEEP_SEC = 3

const LANG_TAG = /^[A-Za-z0-9_-]+$/
const VALUE_FLAGS = new Set(['--file', '--sub-langs', '--sub-format', '--output-dir', '--sleep'])
const BOOL_FLAGS = new Set(['--json', '--subs', '--thumbnail'])

export const META_HELP = `
  yoinks meta — title, description, captions and thumbnail per URL, no download.

  Usage
    $ yoinks meta <url...> [options]
    $ yoinks meta --file urls.txt --json --subs --thumbnail

  Options
    --file <path|->        read URLs from a file (or stdin with -); blank lines
                           and # comments are ignored; may be combined with urls
    --json                 print one JSON document (schema 1) on stdout
    --subs                 fetch captions: manual first, then auto-generated
    --sub-langs <list>     comma-separated languages for --subs (default: en)
    --sub-format <fmt>     json3 (default) or vtt
    --thumbnail            save the best thumbnail
    --output-dir <dir>     where files go (default: ~/Downloads/yoinks-meta)
    --sleep <seconds>      pause between caption fetches (default: 3)
    -h, --help             show this help

  Exit codes: 0 ok (missing captions are reported, not fatal), 1 an item
  failed, 2 usage error. Set YOUTUBE_API_KEY to read YouTube metadata from the
  Data API; without it yt-dlp is used for everything.
`

export function parseMetaArgs(argv: string[]): MetaArgsResult {
  const args: MetaArgs = {
    help: false,
    urls: [],
    file: null,
    json: false,
    subs: false,
    subLangs: DEFAULT_SUB_LANGS,
    subFormat: 'json3',
    thumbnail: false,
    outputDir: null,
    sleepSec: DEFAULT_SLEEP_SEC,
  }
  // --help anywhere wins, even over usage errors
  if (argv.includes('--help') || argv.includes('-h')) return {ok: true, args: {...args, help: true}}

  let subLangsGiven: string | null = null
  let subFormatGiven: string | null = null
  let sleepGiven: string | null = null

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    let flag = arg
    let value: string | undefined
    const eq = arg.indexOf('=')
    if (arg.startsWith('--') && eq > 0) {
      flag = arg.slice(0, eq)
      value = arg.slice(eq + 1)
    }

    if (BOOL_FLAGS.has(flag)) {
      if (value !== undefined) return usage(`${flag} takes no value`)
      if (flag === '--json') args.json = true
      else if (flag === '--subs') args.subs = true
      else args.thumbnail = true
      continue
    }

    if (VALUE_FLAGS.has(flag)) {
      if (value === undefined) value = argv[++index]
      // a following long flag means the value was left out (`-` is stdin for --file; `-1` reaches --sleep's own check)
      if (value === undefined || value === '' || value.startsWith('--') || value === '-h') return usage(`${flag} needs a value`)
      if (flag === '--file') args.file = value
      else if (flag === '--output-dir') args.outputDir = value
      else if (flag === '--sub-langs') subLangsGiven = value
      else if (flag === '--sub-format') subFormatGiven = value
      else sleepGiven = value
      continue
    }

    if (arg.startsWith('-') && arg !== '-') return usage(`unknown option “${arg}”`)
    args.urls.push(arg)
  }

  if (subLangsGiven !== null) {
    if (!args.subs) return usage('--sub-langs needs --subs')
    const langs = subLangsGiven.split(',').map((l) => l.trim())
    if (langs.some((l) => !LANG_TAG.test(l))) {
      return usage('--sub-langs expects comma-separated language tags such as en,de or en-GB')
    }
    args.subLangs = [...new Set(langs)]
  }
  if (subFormatGiven !== null) {
    if (!args.subs) return usage('--sub-format needs --subs')
    if (subFormatGiven !== 'json3' && subFormatGiven !== 'vtt') return usage('--sub-format must be json3 or vtt')
    args.subFormat = subFormatGiven
  }
  if (sleepGiven !== null) {
    const text = sleepGiven.trim()
    const seconds = Number(text)
    if (!text || !Number.isFinite(seconds) || seconds < 0) return usage('--sleep must be a number of seconds, 0 or more')
    args.sleepSec = seconds
  }
  if (args.urls.length === 0 && args.file === null) return usage('no urls given (pass urls, or --file <path|->)')

  return {ok: true, args}
}

function usage(error: string): MetaArgsResult {
  return {ok: false, error}
}

export type InputReaders = {
  readFile: (path: string) => string
  readStdin: () => string
}

export type InputsResult = {ok: true; inputs: string[]} | {ok: false; error: string}

/**
 * Positional URLs first, then the file's lines, de-duplicated by video id
 * (first occurrence wins). Empty input is a usage error.
 */
export function resolveInputs(args: MetaArgs, io: InputReaders): InputsResult {
  const lines = [...args.urls]
  if (args.file !== null) {
    let text: string
    try {
      text = args.file === '-' ? io.readStdin() : io.readFile(args.file)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {ok: false, error: `cannot read ${args.file === '-' ? 'stdin' : args.file}: ${reason}`}
    }
    lines.push(...text.split(/\r?\n/))
  }
  const inputs = collectInputs(lines)
  if (inputs.length === 0) return {ok: false, error: 'no urls given (input was empty)'}
  return {ok: true, inputs}
}
