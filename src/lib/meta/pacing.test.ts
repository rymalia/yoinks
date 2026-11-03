import assert from 'node:assert/strict'
import test from 'node:test'
import {backoffMs, CaptionBreaker, isYtdlpRateLimited, parseRetryAfter, withJitter} from './pacing.js'

test('parseRetryAfter accepts seconds and caps them at five minutes', () => {
  assert.equal(parseRetryAfter('2', 1_000), 2_000)
  assert.equal(parseRetryAfter('0', 1_000), 0)
  assert.equal(parseRetryAfter('600', 1_000), 300_000)
})

test('parseRetryAfter parses HTTP dates, including past dates, and applies the cap', () => {
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:27:00 GMT', now), 0)
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:29:30 GMT', now), 90_000)
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 08:28:00 GMT', now), 300_000)
})

test('parseRetryAfter rejects missing, invalid, and negative values', () => {
  assert.equal(parseRetryAfter(null, 0), null)
  assert.equal(parseRetryAfter(undefined, 0), null)
  assert.equal(parseRetryAfter('   ', 0), null)
  assert.equal(parseRetryAfter('nonsense', 0), null)
  assert.equal(parseRetryAfter('-1', 0), null)
})

test('withJitter reaches both 30 percent bounds', () => {
  assert.equal(withJitter(10_000, () => 0), 7_000)
  assert.ok(Math.abs(withJitter(10_000, () => 0.999999) - 12_999.994) < 0.00001)
  assert.equal(withJitter(10_000, () => 0, 0), 10_000)
})

test('backoffMs uses 30 seconds then 90 seconds with jitter', () => {
  assert.equal(backoffMs(1, () => 0.5), 30_000)
  assert.equal(backoffMs(2, () => 0.5), 90_000)
  assert.ok(Math.abs(backoffMs(3, () => 0) - 63_000) < 0.00001)
})

test('isYtdlpRateLimited detects the HTTP 429 diagnostic', () => {
  assert.equal(isYtdlpRateLimited('ERROR: [youtube] HTTP Error 429: Too Many Requests'), true)
  assert.equal(isYtdlpRateLimited('ERROR: [youtube] HTTP Error 403: Forbidden'), false)
  assert.equal(isYtdlpRateLimited('rate limit exceeded'), false)
})

test('CaptionBreaker opens after two consecutive final rate limits and stays open', () => {
  const breaker = new CaptionBreaker()
  assert.equal(breaker.open, false)
  breaker.record('rate_limited')
  assert.equal(breaker.open, false)
  breaker.record('rate_limited')
  assert.equal(breaker.open, true)
  breaker.record('ok')
  assert.equal(breaker.open, true)
})

test('CaptionBreaker resets on success or unavailable and ignores other outcomes', () => {
  const afterSuccess = new CaptionBreaker()
  afterSuccess.record('rate_limited')
  afterSuccess.record('other')
  afterSuccess.record('ok')
  afterSuccess.record('rate_limited')
  assert.equal(afterSuccess.open, false)

  const afterUnavailable = new CaptionBreaker()
  afterUnavailable.record('rate_limited')
  afterUnavailable.record('unavailable')
  afterUnavailable.record('rate_limited')
  assert.equal(afterUnavailable.open, false)

  const otherPreservesCount = new CaptionBreaker()
  otherPreservesCount.record('rate_limited')
  otherPreservesCount.record('other')
  otherPreservesCount.record('rate_limited')
  assert.equal(otherPreservesCount.open, true)
})
