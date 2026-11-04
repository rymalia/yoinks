import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {metaError, type Result} from './errors.js'
import {runMeta, type RunDeps, type RunFs, type RunOptions} from './run.js'
import type {ProbeInfo, YtdlpRunner} from './ytdlp-meta.js'

const OUT = '/out'
const sentinel = 'AbC+/= 9&x'
const encoded = encodeURIComponent(sentinel)

/** Minimal JPEG with a 1280×720 SOF header. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])

/** In-memory file system: files map path → content; dirs is a set. */
function memFs() {
  const files = new Map<string, Uint8Array | string>()
  const dirs = new Set<string>()
  const fs: RunFs = {
    async mkdir(dir) {
      dirs.add(dir)
    },
    async writeFile(file, data) {
      files.set(file, data)
    },
    async readFile(file) {
      const data = files.get(file)
      if (data === undefined) throw new Error(`ENOENT ${file}`)
      return typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
    },
    async rename(from, to) {
      const data = files.get(from)
      if (data === undefined) throw new Error(`ENOENT ${from}`)
      files.delete(from)
      files.set(to, data) // rename replaces an existing target, like the real thing
    },
    async rm(target) {
      dirs.delete(target)
      files.delete(target)
      for (const key of [...files.keys()]) if (key.startsWith(`${target}/`)) files.delete(key)
    },
  }
  return {fs, files, dirs}
}

function probeInfo(over: Partial<ProbeInfo> & {metadataOver?: Partial<ProbeInfo['metadata']>} = {}): ProbeInfo {
  const {metadataOver, ...rest} = over
  return {
    id: 'abc12345678',
    extractorKey: 'Youtube',
    webpageUrl: 'https://www.youtube.com/watch?v=abc12345678',
    metadata: {
      title: 'yt-dlp title',
      description: null,
      channel: null,
      channelId: null,
      publishedAt: null,
      durationSec: 10,
      audioLanguage: 'en',
      liveStatus: 'none',
      chapters: [],
      ...metadataOver,
    },
    thumbnail: {url: 'https://i/ytdlp.jpg', width: 640, height: 360},
    captions: {
      extractor_key: 'Youtube',
      subtitles: {},
      automatic_captions: {
        'en-orig': [{ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&kind=asr&fmt=json3'}],
        en: [{ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=abc&lang=uk&tlang=en&fmt=json3'}],
      },
    },
    ...rest,
  }
}

type Harness = ReturnType<typeof harness>

function harness(config: {
  apiKey?: string | null
  apiReplies?: (() => Response | Promise<Response>)[]
  imageReplies?: Record<string, () => Response>
  probe?: (url: string) => Result<ProbeInfo>
  captions?: (n: number) => Result<'write'> | Result<string>
  thumbnail?: () => Result<'write'> | Result<string>
}) {
  const mem = memFs()
  const log: string[] = []
  const sleeps: number[] = []
  const apiCalls: string[] = []
  const imageCalls: string[] = []
  const ytdlpCalls: {kind: string; args: unknown}[] = []
  let captionRuns = 0
  const apiReplies = [...(config.apiReplies ?? [])]
  const ytdlp: YtdlpRunner = {
    async probe(url) {
      ytdlpCalls.push({kind: 'probe', args: url})
      return config.probe ? config.probe(url) : {ok: true, value: probeInfo(), warnings: []}
    },
    async captions(args) {
      ytdlpCalls.push({kind: 'captions', args})
      const result = config.captions ? config.captions(captionRuns++) : ({ok: true, value: 'write', warnings: []} as Result<'write'>)
      if (result.ok && result.value === 'write') {
        const file = path.join(args.stagingDir, `captions.${args.ytdlpKey}.${args.format}`)
        mem.files.set(file, JSON.stringify({events: [{segs: [{utf8: `hello ${args.ytdlpKey}`}]}]}))
        return {ok: true, value: file, warnings: []}
      }
      return result as Result<string>
    },
    async thumbnail(args) {
      ytdlpCalls.push({kind: 'thumbnail', args})
      const result = config.thumbnail ? config.thumbnail() : ({ok: true, value: 'write', warnings: []} as Result<'write'>)
      if (result.ok && result.value === 'write') {
        const file = path.join(args.stagingDir, 'thumb.webp')
        mem.files.set(file, 'RIFF')
        return {ok: true, value: file, warnings: []}
      }
      return result as Result<string>
    },
  }
  const deps: RunDeps = {
    apiKey: config.apiKey === undefined ? null : config.apiKey,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://www.googleapis.com/')) {
        apiCalls.push(url)
        const reply = apiReplies.shift()
        if (!reply) throw new Error('no API reply queued')
        return reply()
      }
      imageCalls.push(url)
      const reply = config.imageReplies?.[url]
      if (!reply) return new Response(null, {status: 404})
      return reply()
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    rand: () => 0.5,
    now: () => new Date('2026-11-03T21:00:00.123Z'),
    ytdlp,
    fs: mem.fs,
    log: (line) => log.push(line),
    version: '0.4.0-test',
    pid: 42,
  }
  return {deps, mem, log, sleeps, apiCalls, imageCalls, ytdlpCalls}
}

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  inputs: ['https://youtu.be/abc12345678'],
  subs: false,
  subLangs: ['en'],
  subFormat: 'json3',
  thumbnail: false,
  outputDir: OUT,
  sleepSec: 3,
  ...over,
})

const apiOk = (ids: string[]) => () =>
  new Response(
    JSON.stringify({
      items: ids.map((id) => ({
        id,
        snippet: {title: `API ${id}`, defaultAudioLanguage: 'en', liveBroadcastContent: 'none', thumbnails: {maxres: {url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, width: 1280, height: 720}}},
        contentDetails: {duration: 'PT10S'},
      })),
    }),
    {status: 200, headers: {'content-type': 'application/json'}},
  )

const jpegReply = () => new Response(JPEG, {status: 200, headers: {'content-type': 'image/jpeg'}})

test('metadata only, no key: yt-dlp provides metadata; nothing is written; exit 0', async () => {
  const h = harness({})
  const {document, exitCode} = await runMeta(options(), h.deps)
  assert.equal(exitCode, 0)
  assert.equal(document.schema, 1)
  assert.equal(document.generatedAt, '2026-11-03T21:00:00Z')
  assert.equal(document.yoinksVersion, '0.4.0-test')
  const item = document.items[0]!
  assert.equal(item.videoId, 'abc12345678')
  assert.equal(item.extractor, 'youtube')
  assert.equal(item.webpageUrl, 'https://www.youtube.com/watch?v=abc12345678')
  assert.equal(item.metadata?.title, 'yt-dlp title')
  assert.deepEqual(item.providers, {metadata: 'ytdlp', captions: null, thumbnail: null})
  assert.equal(item.captions, null)
  assert.equal(item.thumbnail, null)
  assert.deepEqual(item.errors, [])
  assert.equal(h.mem.dirs.size, 0, 'output dir is created only for artifacts')
  assert.equal(h.apiCalls.length, 0)
})

test('with a key: the Data API answers in one batch for several ids, yt-dlp is not run for metadata', async () => {
  const h = harness({apiKey: 'test-api-key-0123456789', apiReplies: [apiOk(['abc12345678', 'def12345678'])]})
  const {document} = await runMeta(options({inputs: ['https://youtu.be/abc12345678', 'https://www.youtube.com/watch?v=def12345678']}), h.deps)
  assert.equal(h.apiCalls.length, 1)
  assert.match(h.apiCalls[0]!, /id=abc12345678%2Cdef12345678/)
  assert.deepEqual(
    document.items.map((i) => [i.metadata?.title, i.providers.metadata]),
    [['API abc12345678', 'youtube-api'], ['API def12345678', 'youtube-api']],
  )
  assert.equal(h.ytdlpCalls.length, 0)
})

test('an id the API does not return is not_found; captions and thumbnail are not attempted; exit 1', async () => {
  const h = harness({apiKey: 'test-api-key-0123456789', apiReplies: [apiOk([])]})
  const {document, exitCode} = await runMeta(options({subs: true, thumbnail: true}), h.deps)
  assert.equal(exitCode, 1)
  const item = document.items[0]!
  assert.equal(item.metadata, null)
  assert.deepEqual(item.errors.map((e) => [e.artifact, e.kind]), [['metadata', 'not_found'], ['captions', 'not_found'], ['thumbnail', 'not_found']])
  assert.equal(h.ytdlpCalls.length, 0)
})

test('quota failure: warning per item, yt-dlp for the rest of the run, exit 0', async () => {
  const quota = () => new Response(JSON.stringify({error: {code: 403, message: 'quota', errors: [{reason: 'quotaExceeded'}]}}), {status: 403})
  const h = harness({apiKey: 'test-api-key-0123456789', apiReplies: [quota]})
  const {document, exitCode} = await runMeta(options({inputs: ['https://youtu.be/abc12345678', 'https://youtu.be/def12345678']}), h.deps)
  assert.equal(exitCode, 0)
  for (const item of document.items) {
    assert.equal(item.providers.metadata, 'ytdlp')
    assert.equal(item.warnings.length, 1)
    assert.equal(item.warnings[0]!.kind, 'quota')
    assert.match(item.warnings[0]!.message, /used yt-dlp/)
    assert.deepEqual(item.errors, [])
  }
  assert.equal(h.apiCalls.length, 1)
  assert.ok(h.log.some((l) => /using yt-dlp for the rest of the run/.test(l)))
})

test('the API key never appears in the document, even when fetch throws with the URL', async () => {
  const h = harness({
    apiKey: sentinel,
    apiReplies: Array.from({length: 3}, () => () => {
      throw new TypeError('fetch failed', {cause: new Error(`GET https://www.googleapis.com/youtube/v3/videos?key=${encoded}&id=abc`)})
    }),
    probe: () => ({ok: false, error: metaError('metadata', 'provider', `yt-dlp also saw ${sentinel}`), warnings: []}),
  })
  const {document, exitCode} = await runMeta(options(), h.deps)
  assert.equal(exitCode, 1)
  const text = JSON.stringify(document)
  assert.doesNotMatch(text, /AbC|%2B|%3D|9%26x/)
  assert.match(text, /key=REDACTED/)
  assert.equal(document.items[0]!.warnings[0]!.kind, 'network')
})

test('captions: original track chosen, file renamed into place, text extracted', async () => {
  const h = harness({})
  const {document, exitCode} = await runMeta(options({subs: true, subLangs: ['en', 'EN']}), h.deps)
  assert.equal(exitCode, 0)
  const item = document.items[0]!
  assert.equal(item.providers.captions, 'ytdlp')
  assert.equal(item.captions?.length, 1)
  const cap = item.captions![0]!
  assert.equal(cap.sourceLang, 'en')
  assert.equal(cap.kind, 'asr')
  assert.deepEqual(cap.requestedLangs, ['en'])
  assert.equal(cap.path, `${OUT}/abc12345678.en.asr.json3`)
  assert.equal(cap.text, 'hello en-orig')
  assert.equal(h.ytdlpCalls.filter((c) => c.kind === 'captions').length, 1)
  const call = h.ytdlpCalls.find((c) => c.kind === 'captions')!.args as {ytdlpKey: string; stagingDir: string}
  assert.equal(call.ytdlpKey, 'en-orig')
  assert.equal(call.stagingDir, `${OUT}/.yoinks-staging-42-0`)
  assert.deepEqual([...h.mem.files.keys()], [`${OUT}/abc12345678.en.asr.json3`], 'staging is gone, output is in place')
  assert.ok(h.mem.dirs.has(OUT))
  assert.equal(h.mem.dirs.has(call.stagingDir), false)
  assert.equal(h.sleeps.length, 0, 'no pause before the first caption fetch')
})

test('captions: one track satisfying two requested languages is fetched and written once', async () => {
  const regional = probeInfo({
    captions: {extractor_key: 'Youtube', subtitles: {'en-GB': [{ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en-GB&fmt=json3'}]}, automatic_captions: {}},
  })
  const h = harness({probe: () => ({ok: true, value: regional, warnings: []})})
  const {document} = await runMeta(options({subs: true, subLangs: ['en', 'en-GB']}), h.deps)
  const caps = document.items[0]!.captions!
  assert.equal(caps.length, 1)
  assert.deepEqual(caps[0]!.requestedLangs, ['en', 'en-gb'])
  assert.equal(caps[0]!.path, `${OUT}/abc12345678.en-gb.manual.json3`)
  assert.equal(h.ytdlpCalls.filter((c) => c.kind === 'captions').length, 1)
  assert.deepEqual(document.items[0]!.errors, [])
})

test('captions: a pre-existing output file is replaced by the staged one (no silent skip)', async () => {
  const h = harness({})
  h.mem.files.set(`${OUT}/abc12345678.en.asr.json3`, 'STALE')
  const {document} = await runMeta(options({subs: true}), h.deps)
  assert.equal(document.items[0]!.captions![0]!.text, 'hello en-orig')
  assert.equal(h.mem.files.get(`${OUT}/abc12345678.en.asr.json3`), JSON.stringify({events: [{segs: [{utf8: 'hello en-orig'}]}]}))
})

test('captions: no matching language → captions [] + unavailable listing what exists; exit 0', async () => {
  const h = harness({})
  const {document, exitCode} = await runMeta(options({subs: true, subLangs: ['fr']}), h.deps)
  assert.equal(exitCode, 0)
  const item = document.items[0]!
  assert.deepEqual(item.captions, [])
  assert.equal(item.providers.captions, null)
  assert.equal(item.errors.length, 1)
  assert.equal(item.errors[0]!.kind, 'unavailable')
  assert.match(item.errors[0]!.message, /no caption tracks in: fr \(available: en\)/)
  assert.equal(h.ytdlpCalls.filter((c) => c.kind === 'captions').length, 0)
})

test('captions: live or upcoming videos are unavailable without a fetch', async () => {
  const h = harness({probe: () => ({ok: true, value: probeInfo({metadataOver: {liveStatus: 'live'}}), warnings: []})})
  const {document, exitCode} = await runMeta(options({subs: true}), h.deps)
  assert.equal(exitCode, 0)
  assert.deepEqual(document.items[0]!.captions, [])
  assert.match(document.items[0]!.errors[0]!.message, /while the video is live/)
})

test('captions: a probe failure becomes a captions error of the same kind', async () => {
  const h = harness({probe: () => ({ok: false, error: metaError('metadata', 'login_required', 'sign in'), warnings: []})})
  const {document, exitCode} = await runMeta(options({subs: true}), h.deps)
  assert.equal(exitCode, 1)
  assert.deepEqual(document.items[0]!.errors.map((e) => [e.artifact, e.kind]), [['metadata', 'login_required'], ['captions', 'login_required']])
  assert.equal(document.items[0]!.captions, null)
})

test('captions: rate-limited probes do not count toward the caption breaker', async () => {
  const h = harness({probe: () => ({ok: false, error: metaError('metadata', 'rate_limited', '429'), warnings: []})})
  const inputs = ['https://youtu.be/abc12345678', 'https://youtu.be/def12345678', 'https://youtu.be/ghi12345678']
  const {document} = await runMeta(options({inputs, subs: true}), h.deps)
  assert.deepEqual(document.items.map((i) => i.errors.map((e) => e.kind)), [['rate_limited', 'rate_limited'], ['rate_limited', 'rate_limited'], ['rate_limited', 'rate_limited']])
  assert.equal(h.ytdlpCalls.filter((c) => c.kind === 'probe').length, 3, 'the third item is still probed; no circuit_open')
})

test('captions: post_live from yt-dlp wins over the Data API saying none', async () => {
  const h = harness({apiKey: 'test-api-key-0123456789', apiReplies: [apiOk(['abc12345678'])], probe: () => ({ok: true, value: probeInfo({metadataOver: {liveStatus: 'post_live'}}), warnings: []})})
  const {document} = await runMeta(options({subs: true}), h.deps)
  assert.deepEqual(document.items[0]!.captions, [])
  assert.match(document.items[0]!.errors[0]!.message, /post_live/)
})

test('a thrown filesystem error inside caption staging is an item error, not a crash; staging is removed', async () => {
  const h = harness({})
  const realRename = h.mem.fs.rename
  h.mem.fs.rename = async (from, to) => {
    if (from.includes('.yoinks-staging-')) throw new Error('EXDEV cross-device')
    return realRename(from, to)
  }
  const {document, exitCode} = await runMeta(options({subs: true}), h.deps)
  assert.equal(exitCode, 1)
  assert.equal(document.items[0]!.errors[0]!.kind, 'provider')
  assert.match(document.items[0]!.errors[0]!.message, /EXDEV/)
  assert.equal(h.mem.dirs.size, 1, 'only the output dir remains')
  assert.deepEqual([...h.mem.files.keys()], [])
})

test('a failed final rename removes the hidden interim file and reports an item error', async () => {
  const h = harness({})
  const realRename = h.mem.fs.rename
  h.mem.fs.rename = async (from, to) => {
    if (to.endsWith('.en.asr.json3')) throw new Error('EACCES target')
    return realRename(from, to)
  }
  const {document, exitCode} = await runMeta(options({subs: true}), h.deps)
  assert.equal(exitCode, 1)
  assert.match(document.items[0]!.errors[0]!.message, /could not place caption file: EACCES/)
  assert.deepEqual([...h.mem.files.keys()], [], 'no orphan .yoinks-staging-* file')
})

test('a leftover staging directory from an earlier run is cleared before use', async () => {
  const h = harness({})
  const stale = `${OUT}/.yoinks-staging-42-0`
  h.mem.dirs.add(stale)
  h.mem.files.set(`${stale}/captions.en-orig.json3`, 'STALE')
  const {document} = await runMeta(options({subs: true}), h.deps)
  assert.equal(document.items[0]!.captions![0]!.text, 'hello en-orig')
})

test('captions: 429 retries three runs with backoff, then rate_limited; two such items open the breaker', async () => {
  const limited = () => ({ok: false as const, error: metaError('captions', 'rate_limited', 'HTTP Error 429'), warnings: []})
  const h = harness({captions: () => limited()})
  const inputs = ['https://youtu.be/abc12345678', 'https://youtu.be/def12345678', 'https://youtu.be/ghi12345678']
  const {document, exitCode} = await runMeta(options({inputs, subs: true, thumbnail: true}), h.deps)
  assert.equal(exitCode, 1)
  const [a, b, c] = document.items
  assert.equal(a!.errors[0]!.kind, 'rate_limited')
  assert.equal(a!.errors[0]!.retryable, true)
  assert.equal(a!.captions, null)
  assert.equal(b!.errors[0]!.kind, 'rate_limited')
  assert.equal(c!.errors[0]!.kind, 'circuit_open')
  assert.equal(c!.captions, null)
  assert.equal(h.ytdlpCalls.filter((x) => x.kind === 'captions').length, 6, '3 runs × 2 items, none for the third')
  assert.ok(c!.thumbnail, 'thumbnails continue after the breaker opens')
  assert.ok(h.log.some((l) => /two consecutive rate limits/.test(l)))
  // backoff sleeps: 2 per item (after runs 1 and 2) + the pause before item 2
  assert.ok(h.sleeps.filter((ms) => ms >= 30_000).length === 4)
  assert.equal(h.mem.dirs.size, 1, 'every staging dir is removed')
})

test('captions: a successful item resets the breaker count', async () => {
  let n = 0
  const h = harness({
    captions: () => (n++ < 3 ? {ok: false, error: metaError('captions', 'rate_limited', '429'), warnings: []} : {ok: true, value: 'write', warnings: []}),
  })
  const inputs = ['https://youtu.be/abc12345678', 'https://youtu.be/def12345678', 'https://youtu.be/ghi12345678']
  const {document} = await runMeta(options({inputs, subs: true}), h.deps)
  assert.deepEqual(
    document.items.map((i) => (i.errors[0]?.kind ?? 'ok')),
    ['rate_limited', 'ok', 'ok'],
  )
})

test('captions on a non-YouTube site use the <extractor>-<id> stem and the key as source language', async () => {
  const vimeo = probeInfo({
    id: '76979871',
    extractorKey: 'Vimeo',
    webpageUrl: 'https://vimeo.com/76979871',
    captions: {extractor_key: 'Vimeo', subtitles: {en: [{ext: 'json3', url: '/texttrack/1.json3'}]}, automatic_captions: {}},
  })
  const h = harness({probe: () => ({ok: true, value: vimeo, warnings: []})})
  const {document} = await runMeta(options({inputs: ['https://vimeo.com/76979871'], subs: true}), h.deps)
  const item = document.items[0]!
  assert.equal(item.videoId, null)
  assert.equal(item.extractor, 'vimeo')
  assert.equal(item.webpageUrl, 'https://vimeo.com/76979871')
  assert.equal(item.captions![0]!.path, `${OUT}/vimeo-76979871.en.manual.json3`)
})

test('thumbnail with a key: the API URL is fetched natively, dimensions from the JPEG', async () => {
  const url = 'https://i.ytimg.com/vi/abc12345678/maxresdefault.jpg'
  const h = harness({apiKey: 'test-api-key-0123456789', apiReplies: [apiOk(['abc12345678'])], imageReplies: {[url]: jpegReply}})
  const {document} = await runMeta(options({thumbnail: true}), h.deps)
  const item = document.items[0]!
  assert.deepEqual(item.thumbnail, {url, width: 1280, height: 720, path: `${OUT}/abc12345678.thumb.jpg`})
  assert.equal(item.providers.thumbnail, 'youtube-api')
  assert.equal(h.mem.files.has(`${OUT}/abc12345678.thumb.jpg`), true)
  assert.equal([...h.mem.files.keys()].some((k) => k.includes('.tmp-')), false)
  assert.equal(h.ytdlpCalls.length, 0)
})

test('thumbnail without a key: ytimg maxres → hq, then yt-dlp as a last resort with a warning', async () => {
  const hq = 'https://i.ytimg.com/vi/abc12345678/hqdefault.jpg'
  const h = harness({imageReplies: {[hq]: jpegReply}})
  const {document} = await runMeta(options({thumbnail: true}), h.deps)
  assert.equal(document.items[0]!.thumbnail?.url, hq)
  assert.equal(document.items[0]!.providers.thumbnail, 'ytimg')
  assert.deepEqual(h.imageCalls, ['https://i.ytimg.com/vi/abc12345678/maxresdefault.jpg', hq])
  assert.equal(h.sleeps.length, 0, 'the first fetch of the run is not paced')

  const h2 = harness({})
  const {document: d2, exitCode} = await runMeta(options({thumbnail: true}), h2.deps)
  assert.equal(exitCode, 0)
  const item = d2.items[0]!
  assert.equal(item.providers.thumbnail, 'ytdlp')
  assert.equal(item.thumbnail?.path, `${OUT}/abc12345678.thumb.webp`, 'real extension from the produced file')
  assert.equal(item.thumbnail?.url, 'https://i/ytdlp.jpg')
  assert.equal(item.warnings[0]!.artifact, 'thumbnail')
  assert.match(item.warnings[0]!.message, /trying yt-dlp/)
  assert.deepEqual(item.errors, [])
})

test('ytimg fetches are paced with --sleep like captions; yt-dlp fallbacks are not', async () => {
  const hq = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  const h = harness({imageReplies: {[hq('abc12345678')]: jpegReply, [hq('def12345678')]: jpegReply}})
  const inputs = ['https://youtu.be/abc12345678', 'https://youtu.be/def12345678']
  await runMeta(options({inputs, thumbnail: true, subs: true, sleepSec: 2}), h.deps)
  // item 1: captions (no wait), thumbnail (wait); item 2: captions (wait), thumbnail (wait)
  assert.deepEqual(h.sleeps, [2000, 2000, 2000])
  const h2 = harness({})
  await runMeta(options({inputs: ['https://example.com/a', 'https://example.com/b'], thumbnail: true}), h2.deps)
  assert.equal(h2.ytdlpCalls.filter((c) => c.kind === 'thumbnail').length, 2)
  assert.deepEqual(h2.sleeps, [], 'yt-dlp thumbnail fallbacks are not paced')
})

test('thumbnail: yt-dlp failure after the native miss is an error; metadata still succeeds', async () => {
  const h = harness({thumbnail: () => ({ok: false, error: metaError('thumbnail', 'unavailable', 'none'), warnings: []})})
  const {document, exitCode} = await runMeta(options({thumbnail: true}), h.deps)
  assert.equal(exitCode, 0)
  assert.equal(document.items[0]!.thumbnail, null)
  assert.equal(document.items[0]!.metadata?.title, 'yt-dlp title')
  assert.deepEqual(document.items[0]!.errors.map((e) => e.kind), ['unavailable'])
})

test('items keep input order and a failed item does not stop the run', async () => {
  const h = harness({probe: (url) => (url.includes('def') ? {ok: false, error: metaError('metadata', 'not_found', 'gone'), warnings: []} : {ok: true, value: probeInfo(), warnings: []})})
  const inputs = ['https://youtu.be/abc12345678', 'https://youtu.be/def12345678', 'https://example.com/v']
  const {document, exitCode} = await runMeta(options({inputs}), h.deps)
  assert.equal(exitCode, 1)
  assert.deepEqual(document.items.map((i) => i.inputUrl), inputs)
  assert.deepEqual(document.items.map((i) => i.errors.length), [0, 1, 0])
  assert.equal(document.items[2]!.videoId, null)
})
