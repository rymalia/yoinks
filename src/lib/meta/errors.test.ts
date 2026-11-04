import assert from 'node:assert/strict'
import test from 'node:test'
import {fail, metaError, ok, registerSecret, sanitize, type MetaErrorKind} from './errors.js'

const sentinel = 'AbC+/= 9&x'

test('sanitize redacts literal, URI-component, and form-encoded secrets', () => {
  const uriEncoded = encodeURIComponent(sentinel)
  const formEncoded = new URLSearchParams([['secret', sentinel]]).toString().slice('secret='.length)
  const input = `literal=${sentinel}; uri=${uriEncoded}; form=${formEncoded};`
  const output = sanitize(input, [sentinel])

  assert.doesNotMatch(output, /AbC|%2B|%3D|%20|\+9%26x/)
  assert.equal(output, 'literal=REDACTED; uri=REDACTED; form=REDACTED;')
})

test('sanitize redacts key query values inside URLs and ignores empty secrets', () => {
  assert.equal(
    sanitize('See https://api.example.test/v?KEY=private-value&part=ok and key=second-value.', ['']),
    'See https://api.example.test/v?key=REDACTED&part=ok and key=REDACTED',
  )
})

test('sanitize uses a non-empty YOUTUBE_API_KEY by default', () => {
  const previous = process.env.YOUTUBE_API_KEY
  process.env.YOUTUBE_API_KEY = sentinel
  try {
    assert.equal(sanitize(`failed with ${sentinel}`), 'failed with REDACTED')
  } finally {
    if (previous === undefined) delete process.env.YOUTUBE_API_KEY
    else process.env.YOUTUBE_API_KEY = previous
  }
})

test('registerSecret feeds the default list; short values are ignored', () => {
  registerSecret('k')
  registerSecret('registered-secret-value')
  assert.equal(sanitize('ok k ok registered-secret-value'), 'ok k ok REDACTED')
})

test('metaError sanitizes Error causes and applies retry defaults by kind', () => {
  const encodedKey = new URLSearchParams([['key', sentinel]]).toString().slice('key='.length)
  const raw = new Error('request failed', {cause: new Error(`https://api.example.test/?key=${encodedKey}`)})
  const retryable: MetaErrorKind[] = ['rate_limited', 'circuit_open', 'network', 'timeout']

  for (const kind of retryable) {
    const error = metaError('metadata', kind, raw)
    assert.equal(error.retryable, true)
    assert.doesNotMatch(error.message, /AbC|%2B|%3D|%20|\+9%26x|private-value/)
    assert.match(error.message, /Caused by: Error: https:\/\/api\.example\.test\/\?key=REDACTED/)
  }
  assert.equal(metaError('captions', 'provider', 'failed').retryable, false)
  assert.equal(metaError('thumbnail', 'unavailable', 'none', {retryable: true}).retryable, true)
  assert.equal(metaError('metadata', 'network', 'down', {retryable: false}).retryable, false)
})

test('Result helpers preserve values, errors, and warnings', () => {
  const warning = metaError('metadata', 'quota', 'quota reached')
  const error = metaError('captions', 'unavailable', 'no tracks')
  assert.deepEqual(ok(42, [warning]), {ok: true, value: 42, warnings: [warning]})
  assert.deepEqual(fail(error, [warning]), {ok: false, error, warnings: [warning]})
  assert.deepEqual(ok('ready'), {ok: true, value: 'ready', warnings: []})
})

test('sanitize redacts key= outside a query string but not inside other words', () => {
  assert.equal(sanitize('key=abc123 rejected', []), 'key=REDACTED rejected')
  assert.equal(sanitize('bad request (key=abc123)', []), 'bad request (key=REDACTED)')
  assert.equal(sanitize('"key=abc"', []), '"key=REDACTED"')
  assert.equal(sanitize('monkey=banana apikey=x', []), 'monkey=banana apikey=x')
})
