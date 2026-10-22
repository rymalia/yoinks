import assert from 'node:assert/strict'
import test from 'node:test'
import {isNamingStyle, outputTemplate} from './naming.js'

test('recognizes naming styles', () => {
  assert.equal(isNamingStyle('title'), true)
  assert.equal(isNamingStyle('slug'), true)
  assert.equal(isNamingStyle('other'), false)
})

test('title style includes the video id or a stable fallback hash', () => {
  assert.equal(outputTemplate('title', {id: 'abc123'}, 'audio'), '%(title).60B [%(id)s].%(ext)s')
  assert.equal(outputTemplate('title', {title: 'Example'}, 'audio'), '%(title).60B [0f01ed56].%(ext)s')
  assert.equal(outputTemplate('title', {id: 'a%/b'}, 'audio'), '%(title).60B [%(id)s].%(ext)s')
})

test('slug style normalizes ascii, apostrophes, punctuation, and diacritics', () => {
  assert.equal(outputTemplate('slug', {title: "Bob's! Video?", id: 'abc'}, 'audio'), 'bobs-video-abc.%(ext)s')
  assert.equal(outputTemplate('slug', {title: 'Café Déjà Vu', id: 'abc'}, 'audio'), 'cafe-deja-vu-abc.%(ext)s')
  assert.equal(outputTemplate('slug', {title: 'Robert Redford’s One Shot ｜ Warner', id: 'abc'}, 'audio'), 'robert-redfords-one-shot-warner-abc.%(ext)s')
})

test('slug style handles the documented title and id example', () => {
  const result = outputTemplate('slug', {
    title: "All the President's Men ｜ Dahlberg's Check ｜ Robert Redford's One Shot ｜ Warner Classics",
    id: 'UmLNzZsEgA4',
  }, 'audio')
  assert.ok(result.startsWith('all-the-presidents-men-dahlbergs-check-robert-redfords-one'))
  assert.ok(result.endsWith('-UmLNzZsEgA4.%(ext)s'))
})

test('slug style drops emoji and handles titles without slug characters', () => {
  assert.equal(outputTemplate('slug', {title: '🔥 Hello 🌍', id: 'abc'}, 'audio'), 'hello-abc.%(ext)s')
  assert.equal(outputTemplate('slug', {title: '東京', id: 'abc', extractor: 'youtube'}, 'audio'), 'video-youtube-abc.%(ext)s')
  assert.equal(outputTemplate('slug', {title: '', id: 'abc'}, 'audio'), 'video-abc.%(ext)s')
  assert.equal(outputTemplate('slug', {title: '!!!', id: 'abc'}, 'audio'), 'video-abc.%(ext)s')
  assert.equal(outputTemplate('slug', {title: '', id: 'abc', extractor: 'twitter'}, 'audio'), 'video-twitter-abc.%(ext)s')
  assert.equal(outputTemplate('slug', {title: '', id: 'abc', extractor: 'youtube:tab'}, 'audio'), 'video-youtube-tab-abc.%(ext)s')
  assert.equal(outputTemplate('slug', {title: 'Hello', id: '-yBI43j93TU'}, 'audio'), 'hello--yBI43j93TU.%(ext)s')
  assert.equal(outputTemplate('slug', {title: '', id: '-yBI43j93TU', extractor: 'youtube'}, 'audio'), 'video-youtube--yBI43j93TU.%(ext)s')
})

test('slug title is cut to 60 characters without a trailing dash', () => {
  const result = outputTemplate('slug', {title: `${'a'.repeat(59)} b`, id: 'abc'}, 'audio')
  assert.equal(result, `${'a'.repeat(59)}-abc.%(ext)s`)
})

test('slug id is cleaned and hashed when characters are removed', () => {
  const cleaned = outputTemplate('slug', {title: 'video', id: 'a/b\\c'}, 'audio')
  const alreadyClean = outputTemplate('slug', {title: 'video', id: 'abc'}, 'audio')
  assert.equal(cleaned, 'video-abc-ec727bf7.%(ext)s')
  assert.notEqual(cleaned, alreadyClean)
})

test('missing and long ids use deterministic hashes', () => {
  // hashes are sha1 prefixes of the url and of the raw 41-char id
  assert.equal(outputTemplate('slug', {title: 'video', webpage_url: 'https://example.com/v'}, 'audio'), 'video-3f866fd0.%(ext)s')

  const longId = 'a'.repeat(41)
  assert.equal(outputTemplate('slug', {title: 'video', id: longId}, 'audio'), `video-${'a'.repeat(40)}-52cedd6b.%(ext)s`)
})

test('video suffix uses the downloaded resolution short side in both naming styles', () => {
  const landscape = {title: 'A video', id: 'abc', width: 640, height: 360}
  assert.equal(outputTemplate('slug', landscape, 'video'), 'a-video-abc%(height&-{}p|)s.%(ext)s')
  assert.equal(outputTemplate('title', landscape, 'video'), '%(title).60B [%(id)s]%(height& {}p|)s.%(ext)s')

  const portrait = {title: 'A video', id: 'abc', width: 1080, height: 1920}
  assert.equal(outputTemplate('slug', portrait, 'video'), 'a-video-abc%(width&-{}p|)s.%(ext)s')
  assert.equal(outputTemplate('title', portrait, 'video'), '%(title).60B [%(id)s]%(width& {}p|)s.%(ext)s')
})

test('portrait orientation can be inferred from the largest video format', () => {
  const info = {
    title: 'Portrait',
    id: 'abc',
    formats: [
      {width: 1920, height: 1080, vcodec: 'avc1'},
      {width: 1080, height: 2400, vcodec: 'avc1'},
    ],
  }
  assert.equal(outputTemplate('slug', info, 'video'), 'portrait-abc%(width&-{}p|)s.%(ext)s')
})

test('unknown and square dimensions use height, and audio has no suffix', () => {
  assert.equal(outputTemplate('slug', {title: 'Unknown', id: 'abc'}, 'video'), 'unknown-abc%(height&-{}p|)s.%(ext)s')
  assert.equal(outputTemplate('title', {id: 'abc', width: 1080, height: 1080}, 'video'), '%(title).60B [%(id)s]%(height& {}p|)s.%(ext)s')
  assert.equal(outputTemplate('slug', {title: 'Audio', id: 'abc', width: 1080, height: 1920}, 'audio'), 'audio-abc.%(ext)s')
  assert.equal(outputTemplate('title', {id: 'abc', width: 1080, height: 1920}, 'audio'), '%(title).60B [%(id)s].%(ext)s')
})

test('video suffix follows hashed ids and top-level dimensions win over formats', () => {
  const formats = [{width: 1080, height: 1920, vcodec: 'avc1'}]
  assert.equal(
    outputTemplate('slug', {title: 'video', id: 'a/b\\c', width: 1920, height: 1080, formats}, 'video'),
    'video-abc-ec727bf7%(height&-{}p|)s.%(ext)s',
  )
  assert.equal(
    outputTemplate('title', {title: 'Example', formats}, 'video'),
    '%(title).60B [0f01ed56]%(width& {}p|)s.%(ext)s',
  )
})

test('formats with no video codec are ignored for orientation', () => {
  const info = {
    title: 'Audio format only',
    id: 'abc',
    formats: [{width: 1080, height: 1920, vcodec: 'none'}],
  }
  assert.equal(outputTemplate('slug', info, 'video'), 'audio-format-only-abc%(height&-{}p|)s.%(ext)s')
})

test('every template has the expected placeholders and slug has no unsafe basename chars', () => {
  const slugResults = [
    outputTemplate('slug', {title: 'A video', id: 'abc'}, 'video'),
    outputTemplate('slug', {title: '東京', id: 'abc'}, 'video'),
    outputTemplate('slug', {title: '', id: 'abc'}, 'video'),
    outputTemplate('slug', {title: 'Hello', id: '-yBI43j93TU'}, 'video'),
    outputTemplate('slug', {title: '', id: '-yBI43j93TU', extractor: 'youtube'}, 'video'),
  ]
  for (const result of [
    ...slugResults,
    outputTemplate('title', {id: 'abc'}, 'video'),
    outputTemplate('title', {title: 'Example'}, 'audio'),
  ]) {
    assert.ok(result.endsWith('.%(ext)s'))
    const placeholders = result.match(/%\([^)]+\)/g) ?? []
    assert.equal((result.match(/%/g) ?? []).length, placeholders.length)
    assert.equal(placeholders.filter(placeholder => placeholder === '%(ext)').length, 1)
    assert.equal(result.match(/\.\%\(ext\)s/g)?.length, 1)
  }
  assert.ok(slugResults.every(result => !result.startsWith('-') && !/[/%\\]/.test(result.replace(/%\([^)]*\)s/g, ''))))
})
