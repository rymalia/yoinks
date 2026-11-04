import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {formatItem} from './cli.js'
import {emptyItem} from './run.js'
import {metaError} from './errors.js'

const CLI = new URL('../../cli.tsx', import.meta.url).pathname

function yoinks(args: string[], input = '') {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {encoding: 'utf8', input, timeout: 60_000})
  return {code: result.status, stdout: result.stdout, stderr: result.stderr}
}

test('yoinks meta --help prints the meta help and exits 0 without reading input', () => {
  const r = yoinks(['meta', '--help', '--file', '-'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /yoinks meta — title, description, captions and thumbnail/)
  assert.equal(r.stderr, '')
})

test('yoinks meta usage errors exit 2 with a message on stderr and nothing on stdout', () => {
  const none = yoinks(['meta'])
  assert.equal(none.code, 2)
  assert.equal(none.stdout, '')
  assert.match(none.stderr, /no urls given/)

  const empty = yoinks(['meta', '--file', '-', '--json'], '# nothing here\n\n')
  assert.equal(empty.code, 2)
  assert.equal(empty.stdout, '')
  assert.match(empty.stderr, /input was empty/)

  const unknown = yoinks(['meta', '--wat', 'u'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /unknown option/)
})

test('the TUI entry point is unchanged: its own help, its own exit code for usage errors', () => {
  const help = yoinks(['--help'])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /yoinks — yoink any video/)
  assert.match(help.stdout, /yoinks meta <url\.\.\.>/)
  const bad = yoinks(['--wat'])
  assert.equal(bad.code, 1)
})

test('formatItem renders exactly one line per item with captions, thumbnail, warnings and errors', () => {
  const item = emptyItem('https://youtu.be/dQw4w9WgXcQ')
  item.metadata = {title: 'T', description: null, channel: null, channelId: null, publishedAt: null, durationSec: null, audioLanguage: null, liveStatus: 'none', chapters: null}
  item.captions = [{sourceLang: 'en', requestedLangs: ['en'], kind: 'asr', translated: false, vssId: null, name: null, format: 'json3', path: '/o/x.en.asr.json3', text: ''}]
  item.thumbnail = {url: 'u', width: 1, height: 1, path: '/o/x.thumb.jpg'}
  item.warnings.push(metaError('metadata', 'quota', 'quota; used yt-dlp'))
  item.errors.push(metaError('captions', 'unavailable', 'no caption tracks in: fr'))
  assert.equal(
    formatItem(item),
    '✓ dQw4w9WgXcQ  T  ·  captions: en.asr  ·  thumbnail: x.thumb.jpg  ·  ~ metadata quota: quota; used yt-dlp  ·  ! captions unavailable: no caption tracks in: fr\n',
  )
  item.errors.push(metaError('thumbnail', 'network', 'line one\nline two'))
  item.metadata.title = 'multi\nline\ttitle'
  item.videoId = null
  item.inputUrl = 'https://example.com/a\nb'
  const line = formatItem(item)
  assert.match(line, /https:\/\/example\.com\/a b  multi line title/)
  assert.match(line, /^✗ /)
  assert.equal(line.split('\n').length, 2, 'one line, one trailing newline')
})

// Opt-in live smoke test: YOINKS_LIVE=1 npm test. Needs network, yt-dlp and
// (optionally) YOUTUBE_API_KEY; writes into a temp directory.
test('live: yoinks meta fetches metadata, a caption file and a thumbnail', {skip: !process.env.YOINKS_LIVE}, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yoinks-meta-live-'))
  try {
    const r = yoinks(['meta', 'https://youtu.be/dQw4w9WgXcQ', '--json', '--subs', '--thumbnail', '--output-dir', dir])
    assert.equal(r.code, 0, r.stderr)
    const doc = JSON.parse(r.stdout) as {items: {metadata: {title: string} | null; captions: {path: string; text: string}[] | null; thumbnail: {path: string} | null}[]}
    const item = doc.items[0]!
    assert.match(item.metadata?.title ?? '', /Never Gonna Give You Up/)
    assert.equal(item.captions?.length, 1)
    assert.ok(existsSync(item.captions![0]!.path))
    assert.match(item.captions![0]!.text, /strangers to love/)
    assert.ok(item.thumbnail && existsSync(item.thumbnail.path))
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})
