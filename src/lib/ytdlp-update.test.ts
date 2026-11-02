import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, {afterEach, beforeEach} from 'node:test'
import {isUpdateCheckDue, maybeUpdateYtDlp, releaseTagFromUrl} from './ytdlp.js'

const DAY = 24 * 60 * 60 * 1000

test('releaseTagFromUrl reads the version from the redirected release page', () => {
  assert.equal(releaseTagFromUrl('https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26'), '2026.10.26')
  assert.equal(releaseTagFromUrl('https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26?x=1#y'), '2026.10.26')
  // no redirect happened (or GitHub sent us to a login/error page)
  assert.equal(releaseTagFromUrl('https://github.com/yt-dlp/yt-dlp/releases/latest'), undefined)
  assert.equal(releaseTagFromUrl('https://github.com/login'), undefined)
})

test('isUpdateCheckDue waits a week between checks', () => {
  const now = 100 * DAY
  assert.equal(isUpdateCheckDue(now - 6 * DAY, now), false)
  assert.equal(isUpdateCheckDue(now - 7 * DAY, now), true)
  assert.equal(isUpdateCheckDue(now - 90 * DAY, now), true)
  // mtime in the future (clock skew, copied file) must not suppress checks forever
  assert.equal(isUpdateCheckDue(now + DAY, now), true)
})

let dir: string
let binary: string
const realFetch = globalThis.fetch
const requests: string[] = []
const inits: (RequestInit | undefined)[] = []
const noStatus = () => {}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-update-'))
  binary = path.join(dir, 'bin', 'yt-dlp')
  await fs.mkdir(path.dirname(binary))
  await fs.writeFile(binary, 'old binary')
  requests.length = 0
  inits.length = 0
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await fs.rm(dir, {recursive: true, force: true})
})

async function ageBinary(days: number): Promise<number> {
  const when = new Date(Date.now() - days * DAY)
  await fs.utimes(binary, when, when)
  return (await fs.stat(binary)).mtimeMs
}

/** Fake GitHub: /releases/latest "redirects" to `latestTag`, the asset download returns `asset`. */
function fakeGitHub(latestTag: string, asset = 'new binary') {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    inits.push(init)
    if (url.endsWith('/releases/latest')) {
      const response = new Response(null, {status: 200})
      Object.defineProperty(response, 'url', {value: `https://github.com/yt-dlp/yt-dlp/releases/tag/${latestTag}`})
      return response
    }
    if (url.includes('/releases/latest/download/')) return new Response(asset, {status: 200})
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}

test('a stale cached binary is replaced when a newer release exists', async () => {
  await ageBinary(30)
  fakeGitHub('2026.10.26')
  await maybeUpdateYtDlp(binary, '2026.08.19', noStatus)
  assert.equal(await fs.readFile(binary, 'utf8'), 'new binary')
  assert.equal(requests.length, 2)
  await assert.rejects(fs.stat(`${binary}.download`), {code: 'ENOENT'})
})

test('an up-to-date binary is left alone but marked as verified', async () => {
  const before = await ageBinary(30)
  fakeGitHub('2026.10.26')
  await maybeUpdateYtDlp(binary, '2026.10.26', noStatus)
  assert.equal(await fs.readFile(binary, 'utf8'), 'old binary')
  assert.equal(requests.length, 1, 'only the version check, no download')
  assert.equal(inits[0]?.method, 'HEAD')
  assert.equal(inits[0]?.redirect, 'follow', 'the tag is read from the redirected url')
  assert.ok(inits[0]?.signal instanceof AbortSignal, 'the check has a timeout signal')
  assert.ok((await fs.stat(binary)).mtimeMs > before + 29 * DAY, 'mtime bumped so the next check waits a week')
})

test('a recently verified binary skips the network entirely', async () => {
  await ageBinary(2)
  fakeGitHub('2099.01.01')
  await maybeUpdateYtDlp(binary, '2026.08.19', noStatus)
  assert.equal(requests.length, 0)
  assert.equal(await fs.readFile(binary, 'utf8'), 'old binary')
})

test('being offline keeps the cached binary and retries next run', async () => {
  const before = await ageBinary(30)
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  await maybeUpdateYtDlp(binary, '2026.08.19', noStatus)
  assert.equal(await fs.readFile(binary, 'utf8'), 'old binary')
  assert.equal((await fs.stat(binary)).mtimeMs, before, 'mtime untouched, so the check is still due')
})

test('a failed asset download keeps the cached binary and retries next run', async () => {
  const before = await ageBinary(30)
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/releases/latest')) {
      const response = new Response(null, {status: 200})
      Object.defineProperty(response, 'url', {value: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26'})
      return response
    }
    return new Response('rate limited', {status: 403})
  }) as typeof fetch
  await maybeUpdateYtDlp(binary, '2026.08.19', noStatus)
  assert.equal(await fs.readFile(binary, 'utf8'), 'old binary')
  assert.equal((await fs.stat(binary)).mtimeMs, before, 'mtime untouched, so the check is still due')
})

test('a user cancel during the check reaches fetch and propagates', async () => {
  await ageBinary(30)
  const controller = new AbortController()
  // behaves like real fetch: hangs until the signal it was given aborts.
  // If the caller's signal isn't wired into fetch, this only ends when the
  // 5s check timeout fires, which the elapsed-time assert below catches.
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once: true})
    })) as typeof fetch
  setTimeout(() => controller.abort(), 20)
  const started = Date.now()
  await assert.rejects(maybeUpdateYtDlp(binary, '2026.08.19', noStatus, controller.signal), {name: 'AbortError'})
  // well under the 5s check timeout: the cancel itself ended the request
  assert.ok(Date.now() - started < 2_000, 'cancel reached fetch instead of waiting out the timeout')
})
