import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from './args.js'
import {isThemeMode, nextThemeMode, themeFor} from '../theme.js'

test('parses a url and a spaced theme option without confusing the value for the url', () => {
  assert.deepEqual(parseArgs(['--theme', 'light', 'https://example.com/video']), {
    help: false,
    version: false,
    themeMode: 'light',
    initialUrl: 'https://example.com/video',
  })
})

test('parses an equals-style theme option after the url', () => {
  assert.deepEqual(parseArgs(['https://example.com/video', '--theme=dark']), {
    help: false,
    version: false,
    themeMode: 'dark',
    initialUrl: 'https://example.com/video',
  })
})

test('rejects missing, invalid, and unknown options', () => {
  assert.match(parseArgs(['--theme']).error ?? '', /needs a value/)
  assert.match(parseArgs(['--theme', 'sepia']).error ?? '', /unknown theme/)
  assert.match(parseArgs(['--wat']).error ?? '', /unknown option/)
  assert.match(parseArgs(['one', 'two']).error ?? '', /single url/)
})

test('parses naming style before and after the url', () => {
  assert.deepEqual(parseArgs(['--names', 'slug', 'https://example.com/video']), {
    help: false,
    version: false,
    namingStyle: 'slug',
    initialUrl: 'https://example.com/video',
  })
  assert.deepEqual(parseArgs(['https://example.com/video', '--names=title']), {
    help: false,
    version: false,
    namingStyle: 'title',
    initialUrl: 'https://example.com/video',
  })
})

test('reports naming style errors and leaves the default unset', () => {
  assert.equal(parseArgs(['--names']).error, '--names needs a value: title or slug')
  assert.equal(
    parseArgs(['--names', 'plain']).error,
    'unknown naming style “plain” — use title or slug',
  )
  assert.equal(parseArgs([]).namingStyle, undefined)
})

test('parses --best before and after the url, and leaves the default unset', () => {
  assert.deepEqual(parseArgs(['--best', 'https://example.com/video']), {
    help: false,
    version: false,
    quality: 'best',
    initialUrl: 'https://example.com/video',
  })
  assert.deepEqual(parseArgs(['https://example.com/video', '--best']), {
    help: false,
    version: false,
    quality: 'best',
    initialUrl: 'https://example.com/video',
  })
  assert.equal(parseArgs([]).quality, undefined)
})

test('rejects a value form of --best as an unknown option', () => {
  assert.equal(parseArgs(['--best=x']).error, 'unknown option “--best=x”')
})

test('recognizes only supported modes and cycles through all of them', () => {
  assert.equal(isThemeMode('auto'), true)
  assert.equal(isThemeMode('light'), true)
  assert.equal(isThemeMode('dark'), true)
  assert.equal(isThemeMode('sepia'), false)
  assert.equal(nextThemeMode('auto'), 'light')
  assert.equal(nextThemeMode('light'), 'dark')
  assert.equal(nextThemeMode('dark'), 'auto')
})

test('auto delegates to terminal colors while forced modes own the full surface', () => {
  assert.deepEqual(themeFor('auto'), {
    mode: 'auto',
    primary: undefined,
    gray: undefined,
    dark: undefined,
    background: undefined,
    dimSecondary: true,
    inverseButton: true,
  })

  assert.equal(themeFor('light').background, '#ffffff')
  assert.equal(themeFor('light').primary, '#18181b')
  assert.equal(themeFor('dark').background, '#18181b')
  assert.equal(themeFor('dark').primary, '#ffffff')
})
