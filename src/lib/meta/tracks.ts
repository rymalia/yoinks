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
  /**
   * Fetch URL for the track (any `fmt` query is left as the provider gave it).
   * Absolute http(s) for YouTube and InnerTube; other extractors may give a
   * relative form that only yt-dlp resolves.
   */
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

/**
 * A canonical tag that is safe as a file-name component. Language values
 * come from yt-dlp keys and caption URLs; anything outside letters, digits
 * and `-` (so `..`, `/`, `\`, spaces) is rejected rather than cleaned.
 */
export function isSafeLang(tag: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)
}

/** Query parameters of an absolute http(s) URL, or null when it is not one. */
function queryOf(url: string): URLSearchParams | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.searchParams : null
  } catch {
    return null
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
  // De-duplicate only true repeats (same track, kind and language); two keys
  // that share a URL but name different languages both survive, so a
  // request for either still finds its candidate.
  const byTrack = new Map<string, CaptionCandidate>()

  const add = (map: YtdlpSubtitleMap | null | undefined, kind: CaptionKind) => {
    for (const [key, entries] of Object.entries(map ?? {})) {
      for (const entry of entries ?? []) {
        // The key is what `--sub-langs '^<key>$'` must match; an empty one
        // would become `^$` and never fetch anything.
        if (!key || !entry?.url || (entry.ext && entry.ext !== ext)) continue
        let sourceLang: string
        let translated: boolean
        if (isYouTube) {
          // Origin comes from the URL only; never fall back to the key.
          const q = queryOf(entry.url)
          if (!q) continue // not a fetchable URL
          const lang = canonicalLang(stripAsrPrefix(q.get('lang') ?? ''))
          if (!isSafeLang(lang)) continue
          translated = q.has('tlang')
          sourceLang = lang
        } else {
          // Other extractors may hand yt-dlp relative or protocol-relative
          // URLs; yt-dlp resolves those itself, so only the key matters here.
          translated = false
          sourceLang = canonicalLang(key.replace(/-orig$/, ''))
          if (!isSafeLang(sourceLang)) continue
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
        const trackKey = `${kind}\u0000${sourceLang}\u0000${translated}\u0000${entry.url}`
        const existing = byTrack.get(trackKey)
        if (!existing || (key.endsWith('-orig') && !existing.ytdlpKey?.endsWith('-orig'))) {
          byTrack.set(trackKey, candidate)
        }
      }
    }
  }

  add(info.subtitles, 'manual')
  add(info.automatic_captions, 'asr')
  return [...byTrack.values()]
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
    if (!track?.baseUrl) continue
    const q = queryOf(track.baseUrl)
    if (!q) continue // not a fetchable URL
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
    if (!sourceLang || !isSafeLang(sourceLang)) continue
    // de-duplicate true repeats only, after normalisation (same rule as yt-dlp)
    const trackKey = `${kind}\u0000${sourceLang}\u0000${q.has('tlang')}\u0000${track.baseUrl}`
    if (seen.has(trackKey)) continue
    seen.add(trackKey)
    out.push({
      sourceLang,
      kind,
      translated: q.has('tlang'),
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
