import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {classifyStderr, createYtdlpRunner, extractInfo, type ExecResult} from './ytdlp-meta.js'

type Call = {bin: string; args: string[]; timeoutMs: number}

function runner(reply: (call: Call) => ExecResult | Promise<ExecResult>, overrides: Partial<Parameters<typeof createYtdlpRunner>[0]> = {}) {
  const calls: Call[] = []
  const run = createYtdlpRunner({
    ytdlp: '/bin/yt-dlp',
    convertThumbnails: false,
    sleepSubtitlesSec: 3,
    exec: async (bin, args, {timeoutMs}) => {
      const call = {bin, args, timeoutMs}
      calls.push(call)
      return reply(call)
    },
    ...overrides,
  })
  return {run, calls}
}

const okExec = (stdout = ''): ExecResult => ({code: 0, stdout, stderr: '', timedOut: false})

test('probe runs -J in memory with the right flags and extracts fields', async () => {
  const info = {
    id: 'abc',
    extractor_key: 'Youtube',
    webpage_url: 'https://www.youtube.com/watch?v=abc',
    title: 'T',
    description: 'D',
    channel: 'C',
    channel_id: 'UC',
    timestamp: 1_761_998_463,
    duration: 671.4,
    language: 'en-US',
    live_status: 'not_live',
    chapters: [{title: 'Intro', start_time: 0, end_time: 12}, {start_time: 12}],
    thumbnail: 'https://i/max.jpg',
    thumbnails: [{url: 'https://i/hq.jpg', width: 480, height: 360}, {url: 'https://i/max.jpg', width: 1280, height: 720}],
    subtitles: {en: [{ext: 'json3', url: 'https://y/t?lang=en'}]},
    automatic_captions: {},
    formats: [{format_id: '1'}],
  }
  const {run, calls} = runner(() => okExec(JSON.stringify(info)))
  const result = await run.probe('https://youtu.be/abc')
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(calls[0]!.args, ['-J', '--no-warnings', '--no-playlist', '--skip-download', 'https://youtu.be/abc'])
  assert.equal(calls[0]!.timeoutMs, 120_000)
  const v = result.value
  assert.equal(v.id, 'abc')
  assert.equal(v.extractorKey, 'Youtube')
  assert.equal(v.metadata.publishedAt, '2025-11-01T12:01:03Z')
  assert.equal(v.metadata.durationSec, 671)
  assert.equal(v.metadata.audioLanguage, 'en-US')
  assert.equal(v.metadata.liveStatus, 'none')
  assert.deepEqual(v.metadata.chapters, [{title: 'Intro', startSec: 0, endSec: 12}, {title: null, startSec: 12, endSec: null}])
  assert.deepEqual(v.thumbnail, {url: 'https://i/max.jpg', width: 1280, height: 720})
  assert.deepEqual(v.captions.subtitles, info.subtitles)
  assert.equal('formats' in (v as object), false, 'only selected fields are kept')
})

test('extractInfo fallbacks: uploader, upload_date, best thumbnail by preference then width, live statuses', () => {
  const v = extractInfo({
    uploader: 'U',
    uploader_id: '@u',
    upload_date: '20261101',
    live_status: 'is_live',
    thumbnails: [{url: 'a', width: 100, preference: -1}, {url: 'b', width: 50, preference: 1}, {url: 'c', width: 200}],
  })
  assert.equal(v.metadata.channel, 'U')
  assert.equal(v.metadata.channelId, '@u')
  assert.equal(v.metadata.publishedAt, '2026-11-01T00:00:00Z')
  assert.equal(v.metadata.liveStatus, 'live')
  assert.equal(v.thumbnail?.url, 'b')
  assert.equal(v.metadata.chapters, null)
  assert.equal(extractInfo({live_status: 'is_upcoming'}).metadata.liveStatus, 'upcoming')
  assert.equal(extractInfo({live_status: 'was_live'}).metadata.liveStatus, 'was_live')
  assert.equal(extractInfo({live_status: 'post_live'}).metadata.liveStatus, 'post_live')
  assert.equal(extractInfo({}).metadata.liveStatus, 'none')
  assert.equal(extractInfo({}).thumbnail, null)
})

test('probe failures are classified from stderr; unparseable JSON is a parse error', async () => {
  const {run} = runner(() => ({code: 1, stdout: '', stderr: 'ERROR: [youtube] abc: Video unavailable', timedOut: false}))
  const result = await run.probe('u')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.kind, 'not_found')
    assert.equal(result.error.message, 'abc: Video unavailable')
  }
  const {run: bad} = runner(() => okExec('{nope'))
  const parse = await bad.probe('u')
  assert.equal(parse.ok, false)
  if (!parse.ok) assert.equal(parse.error.kind, 'parse')
  const {run: slow} = runner(() => ({code: null, stdout: '', stderr: '', timedOut: true}))
  const timeout = await slow.probe('u')
  assert.equal(timeout.ok, false)
  if (!timeout.ok) assert.equal(timeout.error.kind, 'timeout')
})

test('classifyStderr', () => {
  assert.equal(classifyStderr('ERROR: Unable to download: HTTP Error 429: Too Many Requests', false), 'rate_limited')
  assert.equal(classifyStderr('ERROR: [youtube] x: Sign in to confirm your age', false), 'login_required')
  assert.equal(classifyStderr('WARNING: [youtube] x: There are missing subtitles languages because a PO token was not provided', false), 'login_required')
  assert.equal(classifyStderr('ERROR: [youtube] x: Private video. Sign in if you have been granted access', false), 'login_required')
  assert.equal(classifyStderr('ERROR: [youtube] x: Video unavailable. This video has been removed', false), 'not_found')
  assert.equal(classifyStderr('ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided> (caused by URLError)', false), 'network')
  assert.equal(classifyStderr('ERROR: Unsupported URL: https://example.com', false), 'provider')
  assert.equal(classifyStderr('', true), 'timeout')
})

test('captions: anchored --sub-langs, staging output template, produced file found', async () => {
  const staging = mkdtempSync(path.join(os.tmpdir(), 'yoinks-meta-test-'))
  try {
    const {run, calls} = runner(({args}) => {
      // yt-dlp names the file <template base>.<key>.<ext>
      const template = args[args.indexOf('-o') + 1]!
      writeFileSync(template.replace('%(ext)s', 'en-orig.json3'), '{"events":[]}')
      return okExec()
    })
    const result = await run.captions({url: 'https://youtu.be/abc', ytdlpKey: 'en-orig', format: 'json3', stagingDir: staging})
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value, path.join(staging, 'captions.en-orig.json3'))
    const args = calls[0]!.args
    assert.deepEqual(args.slice(args.indexOf('--sub-langs'), args.indexOf('--sub-langs') + 2), ['--sub-langs', '^en-orig$'])
    assert.ok(args.includes('--write-subs') && args.includes('--write-auto-subs') && args.includes('--skip-download'))
    assert.ok(args.includes('--force-overwrites'))
    assert.deepEqual(args.slice(args.indexOf('--sleep-subtitles'), args.indexOf('--sleep-subtitles') + 2), ['--sleep-subtitles', '3'])
    assert.equal(args.includes('--no-warnings'), false, 'the PO-token refusal is only a warning')
    assert.equal(args.at(-1), 'https://youtu.be/abc')
  } finally {
    rmSync(staging, {recursive: true, force: true})
  }
})

test('captions: regex specials in the key are escaped', async () => {
  const {run, calls} = runner(() => ({code: 1, stdout: '', stderr: 'ERROR: x', timedOut: false}))
  await run.captions({url: 'u', ytdlpKey: 'pt-BR.v2', format: 'vtt', stagingDir: '/nowhere'})
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf('--sub-langs') + 1], '^pt-BR\\.v2$')
})

test('captions: exit 0 with no file is login_required on a PO-token warning, else a provider error; 429 is rate_limited', async () => {
  const staging = mkdtempSync(path.join(os.tmpdir(), 'yoinks-meta-test-'))
  try {
    const {run: po} = runner(() => ({code: 0, stdout: '', stderr: 'WARNING: [youtube] abc: There are missing subtitles languages because a PO token was not provided.', timedOut: false}))
    const r1 = await po.captions({url: 'u', ytdlpKey: 'en', format: 'json3', stagingDir: staging})
    assert.equal(r1.ok, false)
    if (!r1.ok) assert.equal(r1.error.kind, 'login_required')

    const {run: nothing} = runner(() => okExec())
    const r2 = await nothing.captions({url: 'u', ytdlpKey: 'en', format: 'json3', stagingDir: staging})
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.error.kind, 'provider')

    const {run: limited} = runner(() => ({code: 1, stdout: '', stderr: 'ERROR: Unable to download subtitles: HTTP Error 429: Too Many Requests', timedOut: false}))
    const r3 = await limited.captions({url: 'u', ytdlpKey: 'en', format: 'json3', stagingDir: staging})
    assert.equal(r3.ok, false)
    if (!r3.ok) {
      assert.equal(r3.error.kind, 'rate_limited')
      assert.equal(r3.error.retryable, true)
    }
  } finally {
    rmSync(staging, {recursive: true, force: true})
  }
})

test('thumbnail: convert flag and ffmpeg location only when available; real extension is returned', async () => {
  const staging = mkdtempSync(path.join(os.tmpdir(), 'yoinks-meta-test-'))
  try {
    const {run, calls} = runner(
      ({args}) => {
        writeFileSync(args[args.indexOf('-o') + 1]!.replace('%(ext)s', 'webp'), 'RIFF')
        return okExec()
      },
      {convertThumbnails: true, ffmpegLocation: '/opt/ffmpeg'},
    )
    const result = await run.thumbnail({url: 'u', stagingDir: staging})
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value, path.join(staging, 'thumb.webp'))
    const args = calls[0]!.args
    assert.ok(args.includes('--write-thumbnail'))
    assert.deepEqual(args.slice(args.indexOf('--convert-thumbnails'), args.indexOf('--convert-thumbnails') + 2), ['--convert-thumbnails', 'jpg'])
    assert.deepEqual(args.slice(args.indexOf('--ffmpeg-location'), args.indexOf('--ffmpeg-location') + 2), ['--ffmpeg-location', '/opt/ffmpeg'])

    const {run: plain, calls: plainCalls} = runner(() => okExec())
    const none = await plain.thumbnail({url: 'u', stagingDir: staging})
    assert.equal(plainCalls[0]!.args.includes('--convert-thumbnails'), false)
    assert.equal(plainCalls[0]!.args.includes('--ffmpeg-location'), false)
    // the earlier thumb.webp is still there from the first runner; a fresh dir has nothing
    assert.equal(none.ok, true)
    rmSync(path.join(staging, 'thumb.webp'))
    const empty = await plain.thumbnail({url: 'u', stagingDir: staging})
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.error.kind, 'unavailable')
  } finally {
    rmSync(staging, {recursive: true, force: true})
  }
})
