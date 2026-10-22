import assert from 'node:assert/strict'
import test from 'node:test'
import {buildChoices} from './ytdlp.js'

test('landscape video choices use height for labels and selectors', () => {
  const choices = buildChoices({
    title: 'Landscape',
    formats: [
      {format_id: '1080', width: 1920, height: 1080, vcodec: 'avc1', acodec: 'none'},
      {format_id: '720', width: 1280, height: 720, vcodec: 'avc1', acodec: 'none'},
      {format_id: 'audio', vcodec: 'none', acodec: 'mp4a', abr: 128},
    ],
  })

  assert.deepEqual(choices, [
    {
      kind: 'video',
      label: '1080p · mp4',
      args: ['-f', 'bv*[height=1080]+ba/b[height=1080]/bv*[height<=1080]+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'video',
      label: '720p · mp4',
      args: ['-f', 'bv*[height=720]+ba/b[height=720]/bv*[height<=720]+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'audio',
      label: 'audio only · mp3',
      args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
    },
  ])
})

test('portrait video choices use width for labels and selectors', () => {
  const choices = buildChoices({
    title: 'Portrait',
    width: 1080,
    height: 1920,
    formats: [
      {format_id: '1080', width: 1080, height: 1920, vcodec: 'avc1', acodec: 'none'},
      {format_id: '720', width: 720, height: 1280, vcodec: 'avc1', acodec: 'none'},
      {format_id: 'audio', vcodec: 'none', acodec: 'mp4a', abr: 128},
    ],
  })

  assert.deepEqual(choices, [
    {
      kind: 'video',
      label: '1080p · mp4',
      args: ['-f', 'bv*[width=1080]+ba/b[width=1080]/bv*[width<=1080]+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'video',
      label: '720p · mp4',
      args: ['-f', 'bv*[width=720]+ba/b[width=720]/bv*[width<=720]+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'audio',
      label: 'audio only · mp3',
      args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
    },
  ])
})

test('audio-only formats do not become video choices', () => {
  const choices = buildChoices({
    title: 'Audio only',
    formats: [{format_id: 'audio', width: 1080, height: 1920, vcodec: 'none', acodec: 'mp4a', abr: 128}],
  })

  assert.deepEqual(choices, [
    {
      kind: 'video',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'audio',
      label: 'audio only · mp3',
      args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
    },
  ])
})

test('video formats without dimensions use the best available fallback', () => {
  const choices = buildChoices({
    title: 'Unknown dimensions',
    formats: [
      {format_id: 'video', vcodec: 'avc1', acodec: 'none'},
      {format_id: 'audio', vcodec: 'none', acodec: 'mp4a', abr: 128},
    ],
  })

  assert.deepEqual(choices, [
    {
      kind: 'video',
      label: 'best available · mp4',
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    },
    {
      kind: 'audio',
      label: 'audio only · mp3',
      args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
    },
  ])
})
