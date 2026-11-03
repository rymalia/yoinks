import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {
  availableLanguages,
  candidatesFromInnertube,
  candidatesFromYtdlp,
  canonicalLang,
  parseVssId,
  selectTrack,
  selectTracks,
  type CaptionCandidate,
  type InnertubeCaptionTrack,
  type YtdlpCaptionInfo,
} from './tracks.js'

// Real yt-dlp 2026.10.26 `-J` captures, trimmed (see each file's `_note`).
const fixture = (name: string): YtdlpCaptionInfo & {language?: string} =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const dubbed = fixture('ytdlp-1W-4jx8g7N0.json') // ~20 ASR originals, bare `en` holds translations
const dubbedRegional = fixture('ytdlp-G9o8eoHzpxc.json') // `-orig` keys with regional tags
const manual = fixture('ytdlp-dQw4w9WgXcQ.json') // manual en, de-DE, ja, pt-BR, es-419 + ASR en

const lang = (url: string) => new URL(url).searchParams.get('lang')
const tlang = (url: string) => new URL(url).searchParams.get('tlang')

test('canonicalLang lower-cases and uses dashes', () => {
  assert.equal(canonicalLang('en_GB'), 'en-gb')
  assert.equal(canonicalLang(' pt-BR '), 'pt-br')
})

test('parseVssId distinguishes ASR, manual and manual variants', () => {
  assert.deepEqual(parseVssId('a.en'), {kind: 'asr', lang: 'en', variant: null})
  assert.deepEqual(parseVssId('.en'), {kind: 'manual', lang: 'en', variant: null})
  assert.deepEqual(parseVssId('.en.nP7-2PuUl7o'), {kind: 'manual', lang: 'en', variant: 'nP7-2PuUl7o'})
  assert.equal(parseVssId('en'), null)
})

test('bare `en` entries on the dubbed video normalise as translations from their real source', () => {
  const bare = dubbed.automatic_captions!['en']!
  assert.ok(bare.length > 10)
  const last = bare[bare.length - 1]!
  assert.equal(lang(last.url!), 'uk') // fixture guard: yt-dlp would pick this one
  const candidates = candidatesFromYtdlp(dubbed)
  const fromLast = candidates.find((c) => c.url === last.url)!
  assert.equal(fromLast.translated, true)
  assert.equal(fromLast.sourceLang, 'uk')
})

test('dubbed video: selects the original English ASR track, never a translation', () => {
  const candidates = candidatesFromYtdlp(dubbed)
  const pick = selectTrack(candidates, 'en', dubbed.language ?? null)
  assert.ok(pick)
  assert.equal(pick.kind, 'asr')
  assert.equal(pick.sourceLang, 'en')
  assert.equal(pick.translated, false)
  assert.equal(tlang(pick.url), null)
  assert.equal(pick.ytdlpKey, 'en-orig', 'prefers the -orig key for the fallback download')
})

test('a Ukrainian ASR track is never labelled English', () => {
  const candidates = candidatesFromYtdlp(dubbed)
  for (const c of candidates) {
    if (lang(c.url) === 'uk') assert.equal(c.sourceLang, 'uk')
  }
  const uk = selectTrack(candidates, 'uk')
  assert.ok(uk)
  assert.equal(uk.sourceLang, 'uk')
  assert.equal(uk.translated, false)
})

test('translations are normalised but never selected', () => {
  // On dQw4w9WgXcQ the only ASR original is English; `fr` exists solely as
  // the translation lang=en&tlang=fr, and there is no manual French track.
  const candidates = candidatesFromYtdlp(manual)
  const fr = candidates.filter((c) => c.ytdlpKey === 'fr')
  assert.ok(fr.length > 0)
  assert.ok(fr.every((c) => c.translated && c.sourceLang === 'en'))
  assert.equal(selectTrack(candidates, 'fr'), null)
})

test('regional -orig keys still resolve for the base language', () => {
  const candidates = candidatesFromYtdlp(dubbedRegional)
  const pt = selectTrack(candidates, 'pt')
  assert.ok(pt, 'pt-BR-orig satisfies pt')
  assert.equal(pt.sourceLang, 'pt-br') // from the URL's lang=pt-BR
  assert.equal(pt.kind, 'asr')
  assert.equal(pt.ytdlpKey, 'pt-BR-orig')
})

test('manual captions beat ASR for the same language', () => {
  const candidates = candidatesFromYtdlp(manual)
  const pick = selectTrack(candidates, 'en', 'en')
  assert.ok(pick)
  assert.equal(pick.kind, 'manual')
  assert.equal(pick.sourceLang, 'en')
})

test('regional manual track satisfies a base-language request before ASR', () => {
  const candidates = candidatesFromYtdlp(manual)
  const pick = selectTrack(candidates, 'de')
  assert.ok(pick)
  assert.equal(pick.kind, 'manual')
  assert.equal(pick.sourceLang, 'de-de')
})

test('exact request for a regional tag does not match a different region', () => {
  const candidates = candidatesFromYtdlp(manual)
  // only a pt-BR manual track exists on this video
  assert.equal(selectTrack(candidates, 'pt-pt'), null)
  assert.equal(selectTrack(candidates, 'pt-br')!.sourceLang, 'pt-br')
  assert.equal(selectTrack(candidates, 'pt')!.sourceLang, 'pt-br')
})

test('no match returns null and selectTracks reports it missing', () => {
  const candidates = candidatesFromYtdlp(manual)
  const {selected, missing} = selectTracks(candidates, ['xx'])
  assert.equal(selected.length, 0)
  assert.deepEqual(missing, ['xx'])
})

test('selectTracks de-duplicates a track chosen for several languages', () => {
  const candidates: CaptionCandidate[] = [
    {sourceLang: 'en-gb', kind: 'manual', translated: false, vssId: '.en-GB', name: null, provider: 'innertube', url: 'https://x/gb', ytdlpKey: null},
  ]
  const {selected, missing} = selectTracks(candidates, ['en', 'en-GB'])
  assert.equal(selected.length, 1)
  assert.deepEqual(selected[0]!.requestedLangs, ['en', 'en-gb'])
  assert.deepEqual(missing, [])
})

test('non-YouTube extractors take the language from the key (no lang in URL)', () => {
  const info: YtdlpCaptionInfo = {
    extractor_key: 'Vimeo',
    subtitles: {'en': [{ext: 'json3', url: 'https://vimeo.example/tt/123?token=abc'}], 'fr-orig': [{ext: 'json3', url: 'https://vimeo.example/tt/456'}]},
  }
  const candidates = candidatesFromYtdlp(info)
  assert.deepEqual(candidates.map((c) => [c.sourceLang, c.kind, c.translated]), [
    ['en', 'manual', false],
    ['fr', 'manual', false],
  ])
})

test('entries in other formats are ignored', () => {
  const info: YtdlpCaptionInfo = {extractor_key: 'Youtube', subtitles: {en: [{ext: 'vtt', url: 'https://y/t?lang=en'}]}}
  assert.equal(candidatesFromYtdlp(info).length, 0)
  assert.equal(candidatesFromYtdlp(info, 'vtt').length, 1)
})

test('no captions at all yields no candidates and no languages', () => {
  const candidates = candidatesFromYtdlp({extractor_key: 'Youtube', subtitles: {}, automatic_captions: null})
  assert.deepEqual(candidates, [])
  assert.deepEqual(availableLanguages(candidates), [])
})

test('availableLanguages lists originals only, sorted and distinct', () => {
  const base = {kind: 'asr' as const, vssId: null, name: null, provider: 'ytdlp' as const, ytdlpKey: null}
  const candidates: CaptionCandidate[] = [
    {...base, sourceLang: 'uk', translated: false, url: 'https://y/1'},
    {...base, sourceLang: 'en', translated: false, url: 'https://y/2'},
    {...base, sourceLang: 'en', translated: false, url: 'https://y/3'},
    {...base, sourceLang: 'zz', translated: true, url: 'https://y/4'},
  ]
  assert.deepEqual(availableLanguages(candidates), ['en', 'uk'])
})

test('YouTube entries with a malformed URL or no lang are dropped, not keyed', () => {
  const info: YtdlpCaptionInfo = {
    extractor_key: 'Youtube',
    automatic_captions: {
      en: [
        {ext: 'json3', url: 'not-a-url'},
        {ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=x&lang=&fmt=json3'},
        {ext: 'json3', url: 'https://www.youtube.com/api/timedtext?v=x&fmt=json3'},
        {ext: 'json3', url: 'file:///etc/passwd?lang=en'},
      ],
    },
  }
  assert.deepEqual(candidatesFromYtdlp(info), [])
  assert.equal(selectTrack(candidatesFromYtdlp(info), ''), null)
})

test('ASR markers in lang values are stripped (a-en, a.en)', () => {
  const info: YtdlpCaptionInfo = {
    extractor_key: 'Youtube',
    automatic_captions: {
      'en-orig': [{ext: 'json3', url: 'https://y/t?v=x&lang=a-en'}],
      'de-orig': [{ext: 'json3', url: 'https://y/t?v=x&lang=a.de'}],
    },
  }
  assert.deepEqual(candidatesFromYtdlp(info).map((c) => c.sourceLang), ['en', 'de'])
})

test('a lang query that differs from the key wins (key is not trusted on YouTube)', () => {
  const info: YtdlpCaptionInfo = {
    extractor_key: 'Youtube',
    automatic_captions: {'en-orig': [{ext: 'json3', url: 'https://y/t?v=x&lang=uk'}]},
  }
  const [c] = candidatesFromYtdlp(info)
  assert.equal(c!.sourceLang, 'uk')
  assert.equal(selectTrack(candidatesFromYtdlp(info), 'en'), null)
})

test('ASR: regional track beats exact only when it matches the audio language', () => {
  const base = {kind: 'asr' as const, translated: false, vssId: null, name: null, provider: 'ytdlp' as const, ytdlpKey: null}
  const candidates: CaptionCandidate[] = [
    {...base, sourceLang: 'en', url: 'https://y/en'},
    {...base, sourceLang: 'en-gb', url: 'https://y/gb'},
  ]
  assert.equal(selectTrack(candidates, 'en', 'en-GB')!.url, 'https://y/gb')
  assert.equal(selectTrack(candidates, 'en')!.url, 'https://y/en', 'lexicographic: en < en-gb')
  assert.equal(selectTrack(candidates, 'en', 'en')!.url, 'https://y/en')
})

test('InnerTube tracks with a non-http baseUrl are dropped', () => {
  assert.deepEqual(candidatesFromInnertube([{baseUrl: 'javascript:alert(1)', vssId: '.en', languageCode: 'en'}]), [])
})

// InnerTube shapes. These lists are hand-built from the documented
// `captionTracks` fields (baseUrl, vssId, languageCode, kind, name); they are
// not live captures.
const it = (t: InnertubeCaptionTrack) => t

test('InnerTube: vssId decides kind and language', () => {
  const candidates = candidatesFromInnertube([
    it({baseUrl: 'https://y/t?v=1&lang=en&kind=asr', vssId: 'a.en', languageCode: 'en', kind: 'asr', name: {runs: [{text: 'English (auto-generated)'}]}}),
    it({baseUrl: 'https://y/t?v=1&lang=en', vssId: '.en', languageCode: 'en', name: {simpleText: 'English'}}),
  ])
  assert.deepEqual(candidates.map((c) => [c.kind, c.sourceLang, c.name]), [
    ['asr', 'en', 'English (auto-generated)'],
    ['manual', 'en', 'English'],
  ])
  assert.equal(selectTrack(candidates, 'en')!.kind, 'manual')
})

test('InnerTube: vssId wins over a disagreeing languageCode and reports it', () => {
  const messages: string[] = []
  const candidates = candidatesFromInnertube(
    [it({baseUrl: 'https://y/t?v=1&lang=en', vssId: '.en', languageCode: 'de', kind: 'asr'})],
    {debug: (m) => messages.push(m)},
  )
  assert.equal(candidates[0]!.sourceLang, 'en')
  assert.equal(candidates[0]!.kind, 'manual')
  assert.equal(messages.length, 1)
})

test('InnerTube: without a vssId, kind and languageCode are used', () => {
  const candidates = candidatesFromInnertube([it({baseUrl: 'https://y/t?v=1', languageCode: 'en_GB', kind: 'asr'})])
  assert.deepEqual(candidates.map((c) => [c.kind, c.sourceLang, c.vssId]), [['asr', 'en-gb', null]])
})

test('InnerTube: a variant-free manual track beats a variant, and audio language breaks ties', () => {
  const candidates = candidatesFromInnertube([
    it({baseUrl: 'https://y/a', vssId: '.en.abc', languageCode: 'en'}),
    it({baseUrl: 'https://y/b', vssId: '.en', languageCode: 'en'}),
  ])
  assert.equal(selectTrack(candidates, 'en')!.url, 'https://y/b')

  const regional = candidatesFromInnertube([
    it({baseUrl: 'https://y/us', vssId: '.en-US', languageCode: 'en-US'}),
    it({baseUrl: 'https://y/gb', vssId: '.en-GB', languageCode: 'en-GB'}),
  ])
  assert.equal(selectTrack(regional, 'en', 'en-GB')!.url, 'https://y/gb')
  assert.equal(selectTrack(regional, 'en')!.url, 'https://y/gb', 'lexicographic tie-break without audio language')
})

test('InnerTube before yt-dlp when everything else ties', () => {
  const base = {sourceLang: 'en', kind: 'asr' as const, translated: false, name: null}
  const candidates: CaptionCandidate[] = [
    {...base, vssId: null, provider: 'ytdlp', url: 'https://y/1', ytdlpKey: 'en-orig'},
    {...base, vssId: null, provider: 'innertube', url: 'https://y/2', ytdlpKey: null},
  ]
  assert.equal(selectTrack(candidates, 'en')!.provider, 'innertube')
})

test('InnerTube: tracks with tlang, missing baseUrl or no language are handled', () => {
  const candidates = candidatesFromInnertube([
    it({baseUrl: 'https://y/t?lang=uk&tlang=en', vssId: 'a.uk', languageCode: 'uk', kind: 'asr'}),
    it({vssId: '.en', languageCode: 'en'}),
    it({baseUrl: 'https://y/none'}),
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.translated, true)
  assert.equal(selectTrack(candidates, 'en'), null)
})
