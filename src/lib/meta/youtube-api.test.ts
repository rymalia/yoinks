import assert from 'node:assert/strict'
import test from 'node:test'
import {fetchVideos, mapItem, parseIsoDuration, type ApiDeps} from './youtube-api.js'

const sentinel = 'AbC+/= 9&x'
const encoded = encodeURIComponent(sentinel)
const formEncoded = new URLSearchParams([['k', sentinel]]).toString().slice(2)

type Reply = {status: number; body?: unknown; headers?: Record<string, string>} | Error

function deps(replies: Reply[]): ApiDeps & {calls: string[]; sleeps: number[]} {
  const calls: string[] = []
  const sleeps: number[] = []
  return {
    key: sentinel,
    calls,
    sleeps,
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input))
      const reply = replies.shift()
      if (!reply) throw new Error('no reply queued')
      if (reply instanceof Error) throw reply
      return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status,
        headers: {'content-type': 'application/json', ...(reply.headers ?? {})},
      })
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    rand: () => 0.5,
    now: () => 1_700_000_000_000,
  }
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  snippet: {
    title: `T ${id}`,
    description: 'D',
    channelTitle: 'C',
    channelId: 'UC1',
    publishedAt: '2026-11-01T11:51:03Z',
    defaultAudioLanguage: 'en-GB',
    liveBroadcastContent: 'none',
    thumbnails: {default: {url: 'u-default', width: 120, height: 90}, high: {url: 'u-high', width: 480, height: 360}},
  },
  contentDetails: {duration: 'PT11M11S', caption: 'true'},
  ...extra,
})

test('maps a successful batch; the key is in the request but never in the result', async () => {
  const d = deps([{status: 200, body: {items: [item('a'), item('b')]}}])
  const result = await fetchVideos(['a', 'b', 'missing'], d)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual([...result.value.keys()], ['a', 'b'])
  const a = result.value.get('a')!
  assert.equal(a.metadata.title, 'T a')
  assert.equal(a.metadata.durationSec, 671)
  assert.equal(a.metadata.audioLanguage, 'en-GB')
  assert.equal(a.metadata.liveStatus, 'none')
  assert.equal(a.metadata.chapters, null)
  assert.deepEqual(a.thumbnail, {url: 'u-high', width: 480, height: 360})
  assert.equal(a.captionHint, true)
  assert.equal(d.calls.length, 1)
  assert.match(d.calls[0]!, /part=snippet%2CcontentDetails/)
  assert.match(d.calls[0]!, /id=a%2Cb%2Cmissing/)
  assert.ok(d.calls[0]!.includes(`key=${formEncoded}`), 'the key is sent as a query parameter')
  assert.doesNotMatch(JSON.stringify([...result.value]), /AbC|%2B/)
})

test('quota and key errors are classified without leaking the key', async () => {
  const quota = await fetchVideos(['a'], deps([{status: 403, body: {error: {code: 403, message: `quota for ${sentinel}`, errors: [{reason: 'quotaExceeded'}]}}}]))
  assert.equal(quota.ok, false)
  if (!quota.ok) {
    assert.equal(quota.error.kind, 'quota')
    assert.match(quota.error.message, /quotaExceeded/)
    assert.doesNotMatch(quota.error.message, /AbC|%2B/)
  }
  const bad = await fetchVideos(['a'], deps([{status: 400, body: {error: {code: 400, message: 'API key not valid', errors: [{reason: 'keyInvalid'}]}}}]))
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.error.kind, 'auth')
  const forbidden = await fetchVideos(['a'], deps([{status: 403, body: {error: {code: 403, message: 'blocked', errors: [{reason: 'accessNotConfigured'}]}}}]))
  assert.equal(forbidden.ok, false)
  if (!forbidden.ok) assert.equal(forbidden.error.kind, 'auth')
})

test('5xx and network errors retry twice with backoff, then fail', async () => {
  const d = deps([{status: 503}, {status: 502}, {status: 200, body: {items: [item('a')]}}])
  const ok = await fetchVideos(['a'], d)
  assert.equal(ok.ok, true)
  assert.equal(d.sleeps.length, 2)
  assert.ok(d.sleeps[0]! < d.sleeps[1]!)

  const thrown = new TypeError('fetch failed', {cause: new Error(`https://www.googleapis.com/youtube/v3/videos?key=${encoded}`)})
  const d2 = deps([thrown, thrown, thrown])
  const result = await fetchVideos(['a'], d2)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.kind, 'network')
    assert.doesNotMatch(result.error.message, /AbC|%2B|9%26x/)
    assert.match(result.error.message, /key=REDACTED/)
  }
  assert.equal(d2.calls.length, 3)
})

test('429 honours Retry-After, then gives up as rate_limited', async () => {
  const d = deps([{status: 429, headers: {'retry-after': '7'}}, {status: 429}, {status: 429}])
  const result = await fetchVideos(['a'], d)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.kind, 'rate_limited')
  assert.equal(d.sleeps[0], 7_000)
  assert.equal(d.sleeps.length, 2)
})

test('timeouts are classified after the retries', async () => {
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const result = await fetchVideos(['a'], deps([timeout, timeout, timeout]))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.kind, 'timeout')
})

test('a timeout while reading the body counts as a timeout and is retried', async () => {
  const stalled = () =>
    new Response(new ReadableStream({pull: () => new Promise(() => {})}), {status: 200, headers: {'content-type': 'application/json'}})
  let n = 0
  const d = deps([])
  d.fetch = (async (_input: unknown, init?: RequestInit) => {
    n++
    const response = stalled()
    // emulate the AbortSignal firing while the body is being read
    const signal = init?.signal as AbortSignal | undefined
    return new Proxy(response, {
      get(target, prop) {
        if (prop === 'text') return () => Promise.reject(signal?.reason ?? new DOMException('timed out', 'TimeoutError'))
        const v = Reflect.get(target, prop)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  }) as typeof fetch
  const result = await fetchVideos(['a'], {...d, timeoutMs: 5})
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.kind, 'timeout')
  assert.equal(n, 3)
})

test('more than 50 ids is a programming error', async () => {
  await assert.rejects(fetchVideos(Array.from({length: 51}, (_, i) => `id${i}`), deps([])), /at most 50/)
})

test('mapItem tolerates missing fields and picks the best thumbnail', () => {
  const v = mapItem({id: 'x', snippet: {thumbnails: {maxres: {url: 'm', width: 1280, height: 720}, default: {url: 'd'}}, liveBroadcastContent: 'upcoming'}})
  assert.equal(v.metadata.title, null)
  assert.equal(v.metadata.durationSec, null)
  assert.equal(v.metadata.liveStatus, 'upcoming')
  assert.deepEqual(v.thumbnail, {url: 'm', width: 1280, height: 720})
  assert.equal(v.captionHint, null)
  assert.equal(mapItem({id: 'y'}).thumbnail, null)
})

test('parseIsoDuration', () => {
  assert.equal(parseIsoDuration('PT11M11S'), 671)
  assert.equal(parseIsoDuration('PT1H'), 3600)
  assert.equal(parseIsoDuration('P1DT2H3M4S'), 93_784)
  assert.equal(parseIsoDuration('PT0S'), 0)
  assert.equal(parseIsoDuration('P0D'), 0)
  assert.equal(parseIsoDuration('11:11'), null)
  assert.equal(parseIsoDuration('PT'), null)
})
