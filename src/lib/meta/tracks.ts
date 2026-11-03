/**
 * Caption-track normalisation and selection for `yoinks meta` (pure, no I/O).
 *
 * Both caption sources — yt-dlp's `-J` `subtitles` / `automatic_captions`
 * maps and an InnerTube `captionTracks` list — are turned into one
 * {@link CaptionCandidate} shape before anything is chosen, so a track is
 * always judged by where it came from, never by its key name.
 *
 * Why: yt-dlp adds a YouTube video's original ASR track twice (`<lang>-orig`
 * and a bare `<lang>`) and appends every machine translation into the bare
 * key as well. On auto-dubbed videos the bare `en` key holds ~20 entries,
 * the last of which (the one yt-dlp picks) can be a `lang=uk&tlang=en`
 * translation — and translations are what YouTube rate-limits. See
 * docs/plan-meta-command.md, "Caption-track selection".
 */

export type CaptionKind = 'manual' | 'asr'
export type CaptionProvider = 'innertube' | 'ytdlp'

export type CaptionCandidate = {
  /** Canonical language of the track itself, e.g. "en", "en-gb", "uk". */
  sourceLang: string
  kind: CaptionKind
  /** The URL carries `tlang`: a machine translation. Never selected in v1. */
  translated: boolean
  /** InnerTube ".en", "a.en", ".en.abc123"; null from yt-dlp. */
  vssId: string | null
  name: string | null
  provider: CaptionProvider
  /** Fetch URL for the track (any `fmt` query is left as the provider gave it). */
  url: string
  /** yt-dlp subtitle key to pass as `--sub-langs '^<key>$'`; null for InnerTube. */
  ytdlpKey: string | null
}

export type SelectedTrack = CaptionCandidate & {
  /** Every requested language this track satisfied (de-duplicated by URL). */
  requestedLangs: string[]
}

/** Lower-case and use `-` separators: `en_GB` → `en-gb`. */
export function canonicalLang(tag: string): string {
  return tag.trim().replace(/_/g, '-').toLowerCase()
}

function queryOf(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams
  } catch {
    return new URLSearchParams()
  }
}

/** Strip an ASR marker prefix (`a-en`, `a.en`) from a language value. */
function stripAsrPrefix(lang: string): string {
  return lang.replace(/^a[-.]/, '')
}

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

export type YtdlpSubtitleEntry = {ext?: string; url?: string; name?: string}
export type YtdlpSubtitleMap = Record<string, YtdlpSubtitleEntry[] | undefined>

export type YtdlpCaptionInfo = {
  extractor_key?: string
  subtitles?: YtdlpSubtitleMap | null
  automatic_captions?: YtdlpSubtitleMap | null
}

/**
 * Normalise yt-dlp's caption maps. For YouTube the track's origin is read
 * from its URL (`lang`, `tlang`); other extractors make no such guarantee
 * (Vimeo keys by language and its URLs carry none), so the key is used.
 * Entries are de-duplicated by URL, keeping the `-orig` key when the same
 * original track also appears under its bare key.
 */
export function candidatesFromYtdlp(info: YtdlpCaptionInfo, ext = 'json3'): CaptionCandidate[] {
  const isYouTube = (info.extractor_key ?? '').toLowerCase() === 'youtube'
  const byUrl = new Map<string, CaptionCandidate>()

  const add = (map: YtdlpSubtitleMap | null | undefined, kind: CaptionKind) => {
    for (const [key, entries] of Object.entries(map ?? {})) {
      for (const entry of entries ?? []) {
        if (!entry?.url || (entry.ext && entry.ext !== ext)) continue
        let sourceLang: string
        let translated: boolean
        if (isYouTube) {
          const q = queryOf(entry.url)
          translated = q.has('tlang')
          const lang = q.get('lang')
          sourceLang = canonicalLang(stripAsrPrefix(lang ?? key.replace(/-orig$/, '')))
        } else {
          translated = false
          sourceLang = canonicalLang(key.replace(/-orig$/, ''))
        }
        const candidate: CaptionCandidate = {
          sourceLang,
          kind,
          translated,
          vssId: null,
          name: entry.name ?? null,
          provider: 'ytdlp',
          url: entry.url,
          ytdlpKey: key,
        }
        const existing = byUrl.get(entry.url)
        if (!existing || (key.endsWith('-orig') && !existing.ytdlpKey?.endsWith('-orig'))) {
          byUrl.set(entry.url, candidate)
        }
      }
    }
  }

  add(info.subtitles, 'manual')
  add(info.automatic_captions, 'asr')
  return [...byUrl.values()]
}

// ---------------------------------------------------------------------------
// InnerTube
// ---------------------------------------------------------------------------

export type InnertubeCaptionTrack = {
  baseUrl?: string
  vssId?: string
  languageCode?: string
  kind?: string
  name?: {simpleText?: string; runs?: {text?: string}[]}
}

export type Diagnostics = {debug?: (message: string) => void}

function trackName(name: InnertubeCaptionTrack['name']): string | null {
  if (!name) return null
  if (name.simpleText) return name.simpleText
  const text = (name.runs ?? []).map((r) => r.text ?? '').join('')
  return text || null
}

/**
 * Parse a `vssId`: `a.<lang>` is ASR, `.<lang>` or `.<lang>.<variant>` is
 * manual. Returns null for anything else.
 */
export function parseVssId(vssId: string): {kind: CaptionKind; lang: string; variant: string | null} | null {
  const asr = /^a\.([^.]+)$/.exec(vssId)
  if (asr) return {kind: 'asr', lang: asr[1]!, variant: null}
  const manual = /^\.([^.]+)(?:\.(.+))?$/.exec(vssId)
  if (manual) return {kind: 'manual', lang: manual[1]!, variant: manual[2] ?? null}
  return null
}

/**
 * Normalise an InnerTube `captionTracks` list. A parseable `vssId` wins over
 * `kind` / `languageCode`; a disagreement is reported through `diag.debug`.
 */
export function candidatesFromInnertube(
  tracks: InnertubeCaptionTrack[] | null | undefined,
  diag: Diagnostics = {},
): CaptionCandidate[] {
  const out: CaptionCandidate[] = []
  const seen = new Set<string>()
  for (const track of tracks ?? []) {
    if (!track?.baseUrl || seen.has(track.baseUrl)) continue
    seen.add(track.baseUrl)
    const parsed = track.vssId ? parseVssId(track.vssId) : null
    const fallbackKind: CaptionKind = track.kind === 'asr' ? 'asr' : 'manual'
    const fallbackLang = track.languageCode ? canonicalLang(track.languageCode) : null
    let kind = fallbackKind
    let sourceLang = fallbackLang
    if (parsed) {
      kind = parsed.kind
      sourceLang = canonicalLang(parsed.lang)
      if ((fallbackLang && fallbackLang !== sourceLang) || (track.kind !== undefined && fallbackKind !== kind)) {
        diag.debug?.(
          `caption track ${track.vssId}: vssId disagrees with languageCode=${track.languageCode} kind=${track.kind}; using vssId`,
        )
      }
    }
    if (!sourceLang) continue
    out.push({
      sourceLang,
      kind,
      translated: queryOf(track.baseUrl).has('tlang'),
      vssId: track.vssId ?? null,
      name: trackName(track.name),
      provider: 'innertube',
      url: track.baseUrl,
      ytdlpKey: null,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function hasVariant(c: CaptionCandidate): boolean {
  if (!c.vssId) return false
  return parseVssId(c.vssId)?.variant != null
}

function tieBreak(audioLanguage: string | null) {
  const audio = audioLanguage ? canonicalLang(audioLanguage) : null
  const providerRank = (p: CaptionProvider) => (p === 'innertube' ? 0 : 1)
  return (a: CaptionCandidate & {index: number}, b: CaptionCandidate & {index: number}) => {
    const audioA = audio !== null && a.sourceLang === audio ? 0 : 1
    const audioB = audio !== null && b.sourceLang === audio ? 0 : 1
    if (audioA !== audioB) return audioA - audioB
    // no variant suffix first; a null vssId sorts after any vssId
    const vA = a.vssId === null ? 2 : hasVariant(a) ? 1 : 0
    const vB = b.vssId === null ? 2 : hasVariant(b) ? 1 : 0
    if (vA !== vB) return vA - vB
    if (a.sourceLang !== b.sourceLang) return a.sourceLang < b.sourceLang ? -1 : 1
    const pr = providerRank(a.provider) - providerRank(b.provider)
    if (pr !== 0) return pr
    return a.index - b.index
  }
}

/**
 * Pick one track for requested language `lang`, or null. Rules, first hit
 * wins: (1) manual, exact language; (2) manual, regional variant (`en-gb`
 * for `en`); (3) ASR, exact or regional. Translations are never eligible.
 */
export function selectTrack(
  candidates: CaptionCandidate[],
  lang: string,
  audioLanguage: string | null = null,
): CaptionCandidate | null {
  const want = canonicalLang(lang)
  const eligible = candidates.map((c, index) => ({...c, index})).filter((c) => !c.translated)
  const exactOrRegional = (c: CaptionCandidate) => c.sourceLang === want || c.sourceLang.startsWith(`${want}-`)
  const rules: ((c: CaptionCandidate) => boolean)[] = [
    (c) => c.kind === 'manual' && c.sourceLang === want,
    (c) => c.kind === 'manual' && c.sourceLang.startsWith(`${want}-`),
    (c) => c.kind === 'asr' && exactOrRegional(c),
  ]
  for (const rule of rules) {
    const hits = eligible.filter(rule)
    if (hits.length === 0) continue
    hits.sort(tieBreak(audioLanguage))
    const {index: _index, ...best} = hits[0]!
    return best
  }
  return null
}

/**
 * Select a track for each requested language and de-duplicate by URL, so a
 * track chosen for several languages is fetched and written once.
 */
export function selectTracks(
  candidates: CaptionCandidate[],
  langs: string[],
  audioLanguage: string | null = null,
): {selected: SelectedTrack[]; missing: string[]} {
  const selected = new Map<string, SelectedTrack>()
  const missing: string[] = []
  for (const lang of langs) {
    const want = canonicalLang(lang)
    const pick = selectTrack(candidates, want, audioLanguage)
    if (!pick) {
      missing.push(want)
      continue
    }
    const existing = selected.get(pick.url)
    if (existing) {
      if (!existing.requestedLangs.includes(want)) existing.requestedLangs.push(want)
    } else {
      selected.set(pick.url, {...pick, requestedLangs: [want]})
    }
  }
  return {selected: [...selected.values()], missing}
}

/** Distinct, sorted source languages of the non-translated candidates (for "unavailable" messages). */
export function availableLanguages(candidates: CaptionCandidate[]): string[] {
  return [...new Set(candidates.filter((c) => !c.translated).map((c) => c.sourceLang))].sort()
}
