import assert from 'node:assert/strict'
import test from 'node:test'
import {transcriptText} from './transcript.js'

test('json3: segment text is joined, newlines and blanks dropped', () => {
  const json3 = JSON.stringify({
    events: [
      {tStartMs: 0, segs: [{utf8: 'Send this'}, {utf8: ' to that'}, {utf8: '\n'}]},
      {tStartMs: 500},
      {tStartMs: 900, segs: [{utf8: ' friend'}]},
    ],
  })
  assert.equal(transcriptText('json3', json3), 'Send this to that friend')
})

test('json3: malformed input yields an empty string, not a throw', () => {
  assert.equal(transcriptText('json3', '{not json'), '')
  assert.equal(transcriptText('json3', '{}'), '')
})

test('vtt: headers, timings, cue ids, tags and rolling duplicates are removed', () => {
  const vtt = [
    'WEBVTT',
    'Kind: captions',
    'Language: en',
    '',
    '00:00:00.000 --> 00:00:02.000 align:start position:0%',
    'Send<00:00:00.500><c> this</c>',
    '',
    '1',
    '00:00:02.000 --> 00:00:04.000',
    'Send this',
    'to that friend',
    '',
    '00:00:04.000 --> 00:00:06.000',
    'to that friend',
    'that is guilty',
    '',
  ].join('\n')
  assert.equal(transcriptText('vtt', vtt), 'Send this to that friend that is guilty')
})
