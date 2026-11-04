import assert from 'node:assert/strict'
import test from 'node:test'
import {extFromContentType, fetchImage, fetchYoutubeThumbnail, jpegDimensions, ytimgUrls, type FetchDeps} from './thumbnail.js'

/** A minimal JPEG: SOI, APP0 (empty), SOF0 with the given size, EOI. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x02,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ])
}

type Reply = {status: number; body?: Uint8Array | string; type?: string; headers?: Record<string, string>} | Error

function deps(replies: Reply[]): FetchDeps & {calls: string[]; sleeps: number[]} {
  const calls: string[] = []
  const sleeps: number[] = []
  return {
    calls,
    sleeps,
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input))
      const reply = replies.shift()
      if (!reply) throw new Error('no reply queued')
      if (reply instanceof Error) throw reply
      const body = reply.body === undefined ? null : reply.body
      return new Response(body as BodyInit | null, {status: reply.status, headers: {'content-type': reply.type ?? 'image/jpeg', ...(reply.headers ?? {})}})
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    rand: () => 0.5,
    now: () => 0,
  }
}

test('jpegDimensions reads the SOF header and rejects other bytes', () => {
  assert.deepEqual(jpegDimensions(jpeg(1280, 720)), {width: 1280, height: 720})
  assert.equal(jpegDimensions(new Uint8Array([0x52, 0x49, 0x46, 0x46])), null) // RIFF (webp)
  assert.equal(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), null) // no SOF
  assert.equal(jpegDimensions(new Uint8Array(0)), null)
})

test('extFromContentType', () => {
  assert.equal(extFromContentType('image/jpeg'), 'jpg')
  assert.equal(extFromContentType('image/webp; charset=binary'), 'webp')
  assert.equal(extFromContentType('image/x-unknown'), 'img')
})

test('fetchImage accepts 200 + image/* + non-empty body and reads JPEG dimensions', async () => {
  const result = await fetchImage('https://i.example/x.jpg', deps([{status: 200, body: jpeg(640, 480)}]))
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.ext, 'jpg')
    assert.equal(result.value.width, 640)
    assert.equal(result.value.height, 480)
    assert.equal(result.value.bytes.length, jpeg(1, 1).length)
  }
})

test('fetchImage rejects non-images, empty bodies, 404 and other statuses', async () => {
  const html = await fetchImage('u', deps([{status: 200, body: '<html>', type: 'text/html'}]))
  assert.equal(html.ok, false)
  if (!html.ok) assert.equal(html.error.kind, 'provider')
  const empty = await fetchImage('u', deps([{status: 200, body: new Uint8Array(0)}]))
  assert.equal(empty.ok, false)
  const missing = await fetchImage('u', deps([{status: 404}]))
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.error.kind, 'not_found')
  const server = await fetchImage('u', deps([{status: 500}]))
  assert.equal(server.ok, false)
  if (!server.ok) assert.equal(server.error.kind, 'provider')
})

test('fetchImage follows the 429 policy: Retry-After, then backoff, at most three attempts', async () => {
  const d = deps([{status: 429, headers: {'retry-after': '2'}}, {status: 429}, {status: 429}])
  const result = await fetchImage('u', d)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.kind, 'rate_limited')
  assert.equal(d.calls.length, 3)
  assert.deepEqual(d.sleeps[0], 2_000)
  assert.equal(d.sleeps.length, 2)
})

test('fetchImage classifies thrown fetch errors', async () => {
  const network = await fetchImage('u', deps([new TypeError('fetch failed')]))
  assert.equal(network.ok, false)
  if (!network.ok) assert.equal(network.error.kind, 'network')
  const timeout = await fetchImage('u', deps([new DOMException('timeout', 'TimeoutError')]))
  assert.equal(timeout.ok, false)
  if (!timeout.ok) assert.equal(timeout.error.kind, 'timeout')
})

test('fetchYoutubeThumbnail falls from maxres to hq on 404 only', async () => {
  assert.deepEqual(ytimgUrls('abc'), ['https://i.ytimg.com/vi/abc/maxresdefault.jpg', 'https://i.ytimg.com/vi/abc/hqdefault.jpg'])

  const d = deps([{status: 404}, {status: 200, body: jpeg(480, 360)}])
  const result = await fetchYoutubeThumbnail('abc', d)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.url, 'https://i.ytimg.com/vi/abc/hqdefault.jpg')

  const d2 = deps([{status: 503}])
  const failed = await fetchYoutubeThumbnail('abc', d2)
  assert.equal(failed.ok, false)
  assert.equal(d2.calls.length, 1, 'a non-404 failure does not probe the next size')
})
