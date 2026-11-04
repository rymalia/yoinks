import assert from 'node:assert/strict'
import test from 'node:test'
import {parseMetaArgs, resolveInputs, type MetaArgs} from './args.js'

const parse = (argv: string[]) => parseMetaArgs(argv)
const expectError = (argv: string[], pattern: RegExp) => {
  const result = parse(argv)
  assert.equal(result.ok, false, `expected a usage error for ${JSON.stringify(argv)}`)
  if (!result.ok) assert.match(result.error, pattern)
}
const expectOk = (argv: string[]): MetaArgs => {
  const result = parse(argv)
  assert.equal(result.ok, true, `expected success for ${JSON.stringify(argv)}: ${!result.ok ? result.error : ''}`)
  return result.ok ? result.args : (undefined as never)
}

test('defaults: one url, no artifacts, en captions, json3, sleep 3', () => {
  const args = expectOk(['https://youtu.be/dQw4w9WgXcQ'])
  assert.deepEqual(args, {
    help: false,
    urls: ['https://youtu.be/dQw4w9WgXcQ'],
    file: null,
    json: false,
    subs: false,
    subLangs: ['en'],
    subFormat: 'json3',
    thumbnail: false,
    outputDir: null,
    sleepSec: 3,
  })
})

test('--help wins anywhere, even next to a usage error', () => {
  assert.equal(expectOk(['--help']).help, true)
  assert.equal(expectOk(['--bogus', '-h']).help, true)
  assert.equal(expectOk(['--sub-langs', 'en', '--help']).help, true)
})

test('all flags, in both `--flag value` and `--flag=value` forms', () => {
  const args = expectOk([
    'u1', '--file', 'list.txt', '--json', '--subs', '--sub-langs', 'en,de-DE', '--sub-format=vtt', '--thumbnail', '--output-dir=/tmp/out', '--sleep', '0.5', 'u2',
  ])
  assert.deepEqual(args.urls, ['u1', 'u2'])
  assert.equal(args.file, 'list.txt')
  assert.equal(args.json, true)
  assert.equal(args.subs, true)
  assert.deepEqual(args.subLangs, ['en', 'de-DE'])
  assert.equal(args.subFormat, 'vtt')
  assert.equal(args.thumbnail, true)
  assert.equal(args.outputDir, '/tmp/out')
  assert.equal(args.sleepSec, 0.5)
})

test('--file - means stdin and may be combined with urls', () => {
  const args = expectOk(['--file', '-', 'u1'])
  assert.equal(args.file, '-')
  assert.deepEqual(args.urls, ['u1'])
})

test('usage errors', () => {
  expectError([], /no urls given/)
  expectError(['--json'], /no urls given/)
  expectError(['--file'], /--file needs a value/)
  expectError(['--file='], /--file needs a value/)
  expectError(['--output-dir'], /--output-dir needs a value/)
  expectError(['--output-dir', '--thumbnail', 'u'], /--output-dir needs a value/)
  expectError(['--file', '--json', 'u'], /--file needs a value/)
  expectError(['--wat', 'u'], /unknown option “--wat”/)
  expectError(['-x', 'u'], /unknown option “-x”/)
  expectError(['--sub-langs', 'en', 'u'], /--sub-langs needs --subs/)
  expectError(['--sub-format', 'vtt', 'u'], /--sub-format needs --subs/)
  expectError(['--subs', '--sub-format', 'srt', 'u'], /--sub-format must be json3 or vtt/)
  expectError(['--subs', '--sub-langs', '', 'u'], /--sub-langs needs a value/)
  expectError(['--subs', '--sub-langs', 'en,', 'u'], /comma-separated language tags/)
  expectError(['--subs', '--sub-langs', 'en;rm', 'u'], /comma-separated language tags/)
  expectError(['--sleep', 'soon', 'u'], /--sleep must be a number/)
  expectError(['--sleep', '-1', 'u'], /--sleep must be a number/)
  expectError(['--sleep', 'Infinity', 'u'], /--sleep must be a number/)
  expectError(['--sleep', ' ', 'u'], /--sleep must be a number/)
  assert.equal(expectOk(['--sleep', '.5', 'u']).sleepSec, 0.5)
  assert.equal(expectOk(['--sleep', '1e2', 'u']).sleepSec, 100)
  assert.equal(expectOk(['--sleep', '0', 'u']).sleepSec, 0)
  expectError(['--json=yes', 'u'], /--json takes no value/)
})

test('--sub-langs de-duplicates and keeps order', () => {
  assert.deepEqual(expectOk(['--subs', '--sub-langs', 'en,de,en', 'u']).subLangs, ['en', 'de'])
})

test('resolveInputs merges urls and file lines, drops comments, blanks and duplicates', () => {
  const args = expectOk(['https://youtu.be/dQw4w9WgXcQ', '--file', 'list.txt'])
  const result = resolveInputs(args, {
    readFile: (p) => {
      assert.equal(p, 'list.txt')
      return '# header\n\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\nhttps://example.com/v/1\n  https://example.com/v/1  \n'
    },
    readStdin: () => assert.fail('stdin must not be read'),
  })
  assert.deepEqual(result, {ok: true, inputs: ['https://youtu.be/dQw4w9WgXcQ', 'https://example.com/v/1']})
})

test('resolveInputs reads stdin for --file - and reports unreadable or empty input', () => {
  const stdin = resolveInputs(expectOk(['--file', '-']), {readFile: () => assert.fail('no file'), readStdin: () => 'https://a/1\n'})
  assert.deepEqual(stdin, {ok: true, inputs: ['https://a/1']})

  const empty = resolveInputs(expectOk(['--file', 'x']), {readFile: () => '\n# only a comment\n', readStdin: () => ''})
  assert.deepEqual(empty, {ok: false, error: 'no urls given (input was empty)'})

  const unreadable = resolveInputs(expectOk(['--file', 'missing.txt']), {
    readFile: () => {
      throw new Error('ENOENT: no such file')
    },
    readStdin: () => '',
  })
  assert.equal(unreadable.ok, false)
  if (!unreadable.ok) assert.match(unreadable.error, /cannot read missing.txt: ENOENT/)
})
