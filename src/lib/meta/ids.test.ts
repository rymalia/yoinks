import assert from 'node:assert/strict'
import test from 'node:test'
import {artifactStem, collectInputs, dedupeKey, youtubeVideoId, youtubeWatchUrl} from './ids.js'

const ID = '1W-4jx8g7N0'

test('recognises every single-video YouTube URL shape', () => {
  const shapes = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&pp=abc`,
    `http://m.youtube.com/watch?feature=share&v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RD${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=xyz&t=10`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}?start=5`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=shared`,
    `https://www.youtube.com/v/${ID}`,
    `  https://www.youtube.com/watch?v=${ID}  `,
  ]
  for (const url of shapes) assert.equal(youtubeVideoId(url), ID, url)
})

test('rejects non-video and non-YouTube URLs', () => {
  const rejects = [
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/results?search_query=x',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=1W-4jx8g7N0x',
    'https://youtu.be/',
    'https://notyoutube.com/watch?v=1W-4jx8g7N0',
    'https://www.youtube.com.evil.example/watch?v=1W-4jx8g7N0',
    'https://x.com/user/status/2111099342325166198',
    'javascript:alert(1)',
    '1W-4jx8g7N0',
    'not a url',
  ]
  for (const url of rejects) assert.equal(youtubeVideoId(url), null, url)
})

test('watch URL is canonical', () => {
  assert.equal(youtubeWatchUrl(ID), `https://www.youtube.com/watch?v=${ID}`)
})

test('dedupeKey collapses URL forms of one YouTube video', () => {
  assert.equal(dedupeKey(`https://youtu.be/${ID}`), `youtube:${ID}`)
  assert.equal(dedupeKey(`https://www.youtube.com/watch?v=${ID}&pp=x`), `youtube:${ID}`)
  assert.equal(dedupeKey(' https://vimeo.com/123 '), 'https://vimeo.com/123')
})

test('collectInputs drops blanks, comments and duplicates, keeping first-seen order', () => {
  const lines = [
    '# bookmarks export',
    '',
    `https://youtu.be/${ID}`,
    '   ',
    'https://vimeo.com/123',
    `https://www.youtube.com/watch?v=${ID}&t=1`,
    'https://vimeo.com/123',
    '  # indented comment',
    'https://youtu.be/dQw4w9WgXcQ',
  ]
  assert.deepEqual(collectInputs(lines), [`https://youtu.be/${ID}`, 'https://vimeo.com/123', 'https://youtu.be/dQw4w9WgXcQ'])
})

test('artifactStem uses the YouTube id, then extractor-id, then a URL hash', () => {
  assert.equal(artifactStem({videoId: ID, inputUrl: 'x'}), ID)
  assert.equal(artifactStem({videoId: null, extractorKey: 'Vimeo', id: '123', inputUrl: 'https://vimeo.com/123'}), 'vimeo-123')
  const odd = artifactStem({extractorKey: 'Generic', id: 'a/b%c', inputUrl: 'https://e.example/a'})
  assert.match(odd, /^generic-abc-[0-9a-f]{8}$/)
  assert.doesNotMatch(odd, /[/%\\]/)
  const hashed = artifactStem({inputUrl: 'https://e.example/page'})
  assert.match(hashed, /^url-[0-9a-f]{12}$/)
  assert.equal(hashed, artifactStem({inputUrl: ' https://e.example/page '}), 'stable across whitespace')
  assert.notEqual(hashed, artifactStem({inputUrl: 'https://e.example/other'}))
})

test('artifactStem ignores a malformed videoId', () => {
  assert.match(artifactStem({videoId: '../etc', inputUrl: 'https://e.example/x'}), /^url-/)
})
