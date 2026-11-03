# Plan: `yoinks meta` — metadata, captions and thumbnails without downloading

Status: design rev 3.2, 2026-11-03 — **captions via yt-dlp only in v1** (InnerTube
provider dropped; see Providers). Earlier: Revs 1, 2 and 3 were each reviewed by Codex
gpt-5.6-luna xhigh → REVISE; all findings accepted (rev 3.1 = rev-3 fixes). Branch `feat/meta-command`.

## Why

The tweets hub and dewey-pipeline need three things per YouTube URL found in
~37K X bookmarks (518 unique video IDs today): **title + description**,
**transcript/captions** (manual or auto-generated), and **a thumbnail**. yoinks
already owns a managed yt-dlp binary, so it is the natural home for a
non-interactive, scriptable `meta` command. The download TUI is unchanged.

It also lays groundwork for two roadmap items from
`session-summary-2026-10-22-naming-best-toggle.md`: **Item 3, subtitles
toggle** (shares the caption-track selector) and **Item 5, batch URLs with a
pause** (shares the URL-list input and pacing).

## Evidence (live tests, 2026-11-03, one residential IP)

| Probe | Result |
|---|---|
| Data API `videos.list` with `YOUTUBE_API_KEY`, 3 IDs in one call | ✅ title, description, channel, publishedAt, duration, `defaultAudioLanguage`, thumbnails up to `maxres`; 1 quota unit |
| `https://i.ytimg.com/vi/<id>/maxresdefault.jpg` | ✅ 200, 1280×720 JPEG, no key |
| yt-dlp `--write-auto-subs --sub-langs en` (default and `player_client=android`) | ❌ HTTP 429, 4/4 attempts |
| same, **with media download** (`-f worstaudio`) | ❌ 429 — subs are fetched *before* media, so the media download aborted too |
| yt-dlp `--write-auto-subs --sub-langs en-orig` | ✅ 172 KB json3, immediately after the 429s |
| youtube-pp-cli `videos-transcript` (InnerTube ANDROID `/youtubei/v1/player` → `captionTracks[].baseUrl` → `fmt=json3`) | ✅ 4/4 fresh fetches (it also caches locally; a 5th run said "(from cache)") |

**Root cause of the 429s:** the test video has ASR tracks in several
languages (`ar-orig`, `bn-orig`, `nl-orig`, `en-orig`, `fr-orig`, … — likely
auto-dubbed audio). yt-dlp 2026.10.26 adds the original track twice, as
`<lang>-orig` and as a bare `<lang>` key without `tlang`
(`yt_dlp/extractor/youtube/_video.py:4309-4334`), and it also appends every
*translation* into the same bare key — `--list-subs` showed `en` with the
format list repeated ~25 times. `--sub-format json3` took a `json3` entry
(yt-dlp picks the *last* match, `YoutubeDL.py:3203`) — a
`lang=uk&tlang=en` machine translation — which was throttled. `en-orig` is the
only key guaranteed to be the original. **Track choice, not download mode,
decides success** — and a track's origin must be read from its URL's
`lang`/`tlang` query parameters, never inferred from the key name. Note also
that `--sub-langs` is a regex (`YoutubeDL.py:3174-3177`), so the fallback
passes anchored patterns (`^en-orig$`).

Other facts that shape the design:
- The Data API cannot download third-party captions (`captions.download`
  needs OAuth + owner rights). Captions always come from unofficial endpoints.
- `contentDetails.caption` is documented only as "captions available"; treat
  it as a hint, never as a manual-vs-ASR decision.
- yt-dlp's YouTube extractor ignores `--netrc`/password login
  (`yt_dlp/extractor/youtube/_base.py:706-712`, "Login with password is not
  supported for YouTube"); only cookies authenticate.
- yt-dlp skips an existing output name silently (exit 0, prints the old path) —
  see the 2026-10-22 summary.
- npm 12 blocks `ffmpeg-static`'s install script, so ffmpeg may be absent;
  anything needing conversion must check `findFfmpeg()`.

## Command

```text
yoinks meta <url...> [--file <path|->] [--json] [--subs] [--sub-langs en]
                     [--sub-format json3|vtt] [--thumbnail]
                     [--output-dir DIR] [--sleep SECONDS]
yoinks meta --help
```

- **Dispatch:** `src/cli.tsx` checks `process.argv[2] === 'meta'` **before**
  calling `parseArgs` (today's line 38) and hands the rest to a new
  `parseMetaArgs` (`src/lib/meta/args.ts`). `parseArgs`, its result shape and
  its tests are untouched, so `yoinks <url>` and every existing flag behave
  exactly as now and their usage errors still exit 1. A URL that happens to be
  the literal word `meta` is not a concern (not a URL).
- **Validation (all usage errors → stderr, exit 2):** `--help` anywhere after
  `meta` wins over everything else (prints meta help, exit 0, no input read);
  empty input (no URLs and no/empty `--file`); `--file` or `--output-dir`
  without a value; unknown flag; `--sub-langs` / `--sub-format` without
  `--subs`; `--sub-format` not `json3`/`vtt`; `--sub-langs` empty or with an
  empty/invalid entry (allowed: letters, digits, `-`, `_`, comma-separated);
  `--sleep` not a finite number ≥ 0; unreadable `--file`.
- Inputs: positional URLs and `--file` may be combined; `--file -` reads stdin;
  blank lines and `#` comments ignored; duplicates (after normalising to
  `videoId` for YouTube, exact string otherwise) are collapsed, keeping first
  position. Order of `items` = input order.
- `--json`: exactly one JSON document on stdout; progress/diagnostics on stderr
  only. Without `--json`: one human-readable line per item on stdout.
- Usage errors (`meta` only): message on stderr, no JSON, exit 2.
- **Exit codes:** 0 = no item has an `errors[]` entry other than
  `unavailable` (degraded-but-successful paths go to `warnings[]` and do not
  affect the code); 1 = at least one such error; 2 = usage.
- **Artifacts** are written only when `--subs` / `--thumbnail` ask for them, to
  `--output-dir` (default `~/Downloads/yoinks-meta/`). File stem: the YouTube
  `videoId`; for other sites `<extractor>-<id>` from yt-dlp (`extractor_key`
  lower-cased + `id`, cleaned with the same id rules as `naming.ts` slugs),
  falling back to `url-<sha1(normalised inputUrl)[:12]>`. Names:
  `<stem>.thumb.<ext>` (`jpg` unless the fallback had no ffmpeg to convert, in
  which case the real extension, e.g. `webp`) and
  `<stem>.<sourceLang>.<kind>.<fmt>` (e.g. `1W-4jx8g7N0.en.asr.json3`).
  Selected tracks are de-duplicated by URL before writing: if several
  requested languages pick the same track it is written once and its single
  caption entry lists them all in `requestedLangs`. The thumbnail's real
  extension is always taken from the file actually produced.
- **Writes are atomic:** native providers write `<name>.tmp-<pid>` then rename;
  the yt-dlp fallback writes into a fresh staging dir
  (`<output-dir>/.yoinks-staging-<pid>-<n>/`) with `--force-overwrites`, and
  yoinks renames the produced files into place, so yt-dlp's silent
  "already downloaded" skip can never report a stale file. All `path` values
  are absolute.

### Output schema (`schema: 1`)

```json
{
  "schema": 1,
  "generatedAt": "2026-11-03T21:00:00Z",
  "yoinksVersion": "0.4.0-rymalia",
  "items": [{
    "inputUrl": "https://youtu.be/1W-4jx8g7N0",
    "videoId": "1W-4jx8g7N0",
    "extractor": "youtube",
    "webpageUrl": "https://www.youtube.com/watch?v=1W-4jx8g7N0",
    "metadata": {
      "title": "…", "description": "…", "channel": "…", "channelId": "…",
      "publishedAt": "2026-11-01T11:51:03Z", "durationSec": 671,
      "audioLanguage": "en-GB", "liveStatus": "none",
      "chapters": null
    },
    "thumbnail": {"url": "https://i.ytimg.com/vi/…/maxresdefault.jpg",
                  "width": 1280, "height": 720, "path": "/abs/…/1W-4jx8g7N0.thumb.jpg"},
    "captions": [{
      "sourceLang": "en", "requestedLangs": ["en"], "kind": "asr",
      "translated": false, "vssId": "a.en", "name": "English (auto-generated)",
      "format": "json3", "path": "/abs/…", "text": "…"
    }],
    "providers": {"metadata": "youtube-api", "captions": "ytdlp", "thumbnail": "youtube-api"},
    "warnings": [
      {"artifact": "metadata", "kind": "quota", "message": "Data API quota exceeded; used yt-dlp"}
    ],
    "errors": [
      {"artifact": "captions", "kind": "unavailable", "retryable": false,
       "message": "no caption tracks in: ar, fr"}
    ]
  }]
}
```

- `videoId` is `null` for non-YouTube URLs; every `metadata` field is nullable;
  `chapters` is `null` unless the yt-dlp provider ran (the Data API has none).
- Artifact field states: **not requested** → `null`, no error; **requested,
  none exist** → `captions: []` + an `unavailable` error; **requested, failed**
  → `null` + an error. `metadata` is always requested; on failure it is `null`.
- `providers` records only the provider that *produced* each artifact
  (`null` if none did); attempts that failed over appear in `warnings[]`.
- `errors[]` / `warnings[]` entries: `{artifact, kind, message, retryable?}`;
  `artifact` ∈ `metadata | captions | thumbnail`; `kind` ∈ `unavailable |
  rate_limited | circuit_open | auth | quota | not_found | login_required |
  network | timeout | parse | provider`. Messages are sanitized (see Secrets).
- `text` is plain transcript text (segments joined by spaces); the file keeps
  timings.

## Providers

| Need | Primary | Fallback |
|---|---|---|
| Metadata | **Data API `videos.list`** when `YOUTUBE_API_KEY` is set — batches of ≤50 IDs, `part=snippet,contentDetails` | yt-dlp `-J --skip-download --no-playlist` in a **new in-memory runner** (`probe()` is not reused: it persists the ~11 MB JSON to `$TMPDIR` and never deletes it). Only selected fields are kept. |
| Captions | **yt-dlp only (v1):** read the caption entries from the same in-memory `-J` result used for metadata → normalise + select with `tracks.ts` (origin from each URL's `lang`/`tlang`) → download exactly that track with `--skip-download --write-subs --write-auto-subs --sub-langs '^<ytdlpKey>$' --sub-format <fmt> --sleep-subtitles <n> --sleep-requests 0.75` into the staging dir | none (an InnerTube provider was designed and dropped, below) |
| Thumbnail | The API's best returned URL (`maxres` → `standard` → `high`) when the key is set; otherwise probe `i.ytimg.com/vi/<id>/maxresdefault.jpg` → `hqdefault.jpg` | yt-dlp `--write-thumbnail`, adding `--convert-thumbnails jpg` when a new `hasFfmpeg()` (ffmpeg on PATH **or** bundled) is true, plus `--ffmpeg-location` only when `findFfmpeg()` returns a path (it returns `undefined` for PATH ffmpeg, `ytdlp.ts:175`) |

- **The API key is optional everywhere**, for `meta` and for any future yoinks
  feature. No key → yt-dlp metadata.
- API failure handling: `quotaExceeded` / `dailyLimitExceeded` → yt-dlp
  fallback for the rest of the run, a `quota` **warning** per affected item;
  invalid key (400 `keyInvalid`) or other 403 → `auth` warning, fall back to
  yt-dlp for the rest of the run; 5xx / network / timeout → retry ×2 with
  backoff, then fall back with a warning. Only if the fallback also fails does
  the item get an `errors[]` entry. IDs missing
  from the response → `not_found` for metadata (video private/removed), no
  yt-dlp retry.
- Thumbnail checks: HTTP 200 **and** `content-type: image/*` **and** non-empty
  body; dimensions from the API or by reading the JPEG SOF header; if
  undecodable, `width`/`height` are `null` (not an error).
- Non-YouTube URLs: yt-dlp provider only.
- **Why no InnerTube provider in v1:** yoinks would have to impersonate the
  YouTube Android app with a hardcoded app key — code of our own that a
  Claude Code safety check refused to run during design (2026-11-03). It is
  also unnecessary: once the exact original track is requested, yt-dlp
  downloaded captions straight after four 429s from the same IP. yt-dlp
  remains the only component talking to YouTube's unofficial endpoints, and
  it is maintained upstream. `tracks.ts` keeps its pure InnerTube parser
  (tested, no I/O) so the option stays open; revisit only with the user's
  explicit approval and evidence from a batch run.
- yt-dlp reports YouTube refusing subtitles for want of a PO token
  (`_video.py:4261-4287`) → `login_required`, never `unavailable`.

### Caption-track selection (`src/lib/meta/tracks.ts`, pure)

Both providers are normalised into one candidate shape before selecting:

```ts
type CaptionCandidate = {
  sourceLang: string        // canonical BCP-47 of the track itself ("en", "en-gb", "uk")
  kind: 'manual' | 'asr'
  translated: boolean       // URL carries tlang — kept only so it can be excluded
  vssId: string | null      // InnerTube ".en", "a.en", ".en.abc123"; null from yt-dlp
  name: string | null
  provider: 'innertube' | 'ytdlp'
  url: string               // absolute http(s); entries without one are dropped
  ytdlpKey: string | null   // key for --sub-langs '^<key>$'; null for InnerTube
}
```

- **Canonicalisation:** language tags lower-cased with `_` → `-`
  (`en_GB` → `en-gb`); comparisons are on canonical tags only. Output keeps
  the canonical form.
- **InnerTube:** if `vssId` is present it wins: `a.<lang>` ⇒ ASR,
  `.<lang>[.<variant>]` ⇒ manual, `sourceLang = <lang>`; otherwise
  `kind === "asr"` ⇒ ASR and `sourceLang = languageCode`. A disagreement
  between `vssId` and `languageCode` is logged on stderr (debug) and `vssId`
  is used. The ANDROID client does not return `translationLanguages`, so
  InnerTube never yields translated candidates.
- **yt-dlp, YouTube:** for every entry under `subtitles` (manual) and
  `automatic_captions` (ASR), read the entry's `url` query: `tlang` present ⇒
  `translated: true` (dropped); else `sourceLang = lang` query value (minus an
  `a-`/`a.` prefix). An entry whose URL is not absolute http(s) or whose `lang`
  is missing/empty is **dropped** — the key is never used as a fallback.
- **yt-dlp, other extractors:** caption URLs carry no language guarantee
  (e.g. Vimeo keys by language and its URL has no `lang`,
  `extractor/vimeo.py:293-297`), so `sourceLang` = the map key (minus a
  trailing `-orig`), `translated: false`, `kind` from `subtitles` vs
  `automatic_captions`. The key name is used only as `ytdlpKey` for the fallback
  download, preferring the `<lang>-orig` key for ASR originals and
  de-duplicating identical URLs.
- **Selection for requested language L** (first rule with a hit wins, per
  requested language; translated candidates are never eligible in v1):
  1. manual, `sourceLang == L`;
  2. manual, `sourceLang` starts with `L-`; ties → the one equal to
     `audioLanguage`, then the one whose vssId has no variant suffix (a
     `null` vssId sorts after any vssId), then lowest `sourceLang`
     lexicographically (so for ASR `en` beats `en-gb` unless `audioLanguage`
     is `en-GB`), then provider order (InnerTube before yt-dlp), then input
     order;
  3. ASR with `sourceLang == L` or starting with `L-`; ties as in 2.
- If nothing matches, the item gets `captions: []` + an `unavailable` error
  listing the source languages that *do* exist. A Ukrainian ASR track is never
  labelled English.
- Live / upcoming premieres: `liveStatus` ≠ `none`/`was_live` → captions
  `unavailable` (live ASR is incomplete). Age-restricted / login-required →
  `login_required`, no cookie fallback in v1.

## Pacing and resilience

- Items run **sequentially**. Captions and thumbnails (`ytimg`) are paced with
  an injected `sleep(ms)` so tests run instantly. Default `--sleep 3` between
  caption fetches, plus ±30% jitter.
- Request timeout 20 s per HTTP call (AbortSignal), 120 s per yt-dlp process.
- **429 policy (native HTTP — Data API, `ytimg`):** classified per endpoint; honour `Retry-After` (seconds or
  HTTP-date, capped at 300 s), otherwise backoff 30 s → 90 s with ±30%
  jitter; at most 3 attempts per request.
- **429 policy (yt-dlp fallback):** yoinks cannot see response headers from a
  child process, so stderr containing `HTTP Error 429` is classified
  `rate_limited`; retried with the fixed 30 s → 90 s backoff, at most 3 runs.
- A caption 429 is retried per the yt-dlp policy above and then recorded as
  `rate_limited, retryable: true`; there is no other caption provider to
  fall back to.
- **Circuit breaker (captions only):** an item counts as rate-limited when its
  *final* caption attempt for any requested language ended in 429. Two
  consecutive such items open the breaker for the rest of the run: later items
  get `captions: null` + `{artifact: "captions", kind: "circuit_open",
  retryable: true}` (exit code 1), metadata and thumbnails continue, and one
  line is printed on stderr. Items whose captions succeed or are
  `unavailable` reset the count. The breaker never closes within a run.
- Caching is the caller's job in v1: dewey-pipeline keys results by
  `videoId` and skips IDs it already has.

## Secrets

- `YOUTUBE_API_KEY` is read from the environment only and passed as a query
  parameter internally. Request URLs are **never** logged or put in errors.
- **Enforced boundary:** providers never throw raw errors upward. Each
  returns `Result<T, MetaError>`; `MetaError` can only be constructed through
  `metaError(kind, rawMessage)`, which runs `sanitize()` (redacts the literal
  key value, its URL-encoded form, and any `key=…` query parameter). The
  `meta` branch in `cli.tsx` wraps the whole run in a top-level catch that
  also sanitizes before printing, so the existing raw `console.error` path
  (`cli.tsx:77`) is never reached by `meta`.
- Tests: a sentinel key (including characters that change under URL
  encoding) against stubbed 400 / 403 / 5xx / thrown `TypeError: fetch failed`
  with the request URL in its message; assert the sentinel and its encoded
  form are absent from stdout, stderr and the JSON document.

## Code layout

```text
src/lib/meta/
  args.ts         parseMetaArgs (separate from src/lib/args.ts)
  errors.ts       MetaError, metaError(), Result helpers
  ids.ts          URL → {extractor, videoId} (watch, youtu.be, shorts, embed, live, m., music.)
  tracks.ts       CaptionCandidate normalisation + selection (pure)
  youtube-api.ts  videos.list batching, error classification
  ytdlp-meta.ts   in-memory -J runner, field extraction, caption/thumbnail fallback (reuses ensureYtDlp/findFfmpeg)
  thumbnail.ts    URL choice, fetch, content-type + SOF dimension read
  pacing.ts       sleep injection, jitter, Retry-After parsing, 429 circuit breaker
  sanitize.ts
  run.ts          orchestrates one batch → schema-1 document
src/cli.tsx       `argv[2] === 'meta'` branch before parseArgs (line 38); main help mentions `meta`
```

## Tests (`node --test` via tsx; baseline 36/36)

- `args`: existing `src/lib/args.test.ts` untouched; new
  `meta/args.test.ts` covers combined inputs, `--file -`, duplicates,
  `--help` precedence, and every usage error listed under Command.
- `ids`: every URL shape above, plus non-YouTube URLs → `videoId: null`.
- `tracks` (fixtures from real `captionTracks` and yt-dlp `automatic_captions`
  lists): exact manual en; several manual en variants; `en-GB` only; ASR-only
  with `-orig`; the multi-ASR video above (bare `en` key holding a
  `lang=uk&tlang=en` translation first — must select the `en` original, never
  the translation); bare original key with no `-orig` sibling; `vssId` vs
  `languageCode` disagreement; `en_GB` casing; original language ≠
  requested; no ASR at all; Shorts; live/upcoming.
- `youtube-api`: mapping, missing IDs, quota / keyInvalid / 403 / 5xx paths.
- `pacing`: Retry-After seconds + HTTP-date, cap, jitter bounds, yt-dlp
  stderr 429 classification, breaker open/reset rules.
- `run`: warnings-vs-errors exit codes, artifact field states, non-YouTube
  stems, staging-dir rename (with a pre-existing output file).
- `sanitize` + the sentinel-key end-to-end test.
- One opt-in live smoke test (`YOINKS_LIVE=1`), skipped by default.

## Decisions on rev-1 open questions

1. **Cache:** none in yoinks for v1; callers key by `videoId`.
2. **Default `--sub-format`:** `json3` (timings, easy to parse); `vtt` on request.
3. **Thumbnail source:** API-returned URL when the key is set (no extra probe);
   direct `ytimg` probe otherwise.

## Out of scope (v1)

Comments, statistics snapshots, search, playlist/channel enumeration,
**translated subtitles** (`--translated-subs` dropped in rev 3: the ANDROID
client has no `translationLanguages`, and translations are what gets
throttled), PO tokens, **netrc** (ignored by yt-dlp's
YouTube extractor) and **cookies** (possible future opt-in flag, off by
default — logged-in bulk caption fetching risks the Google account), the TUI
subtitles toggle itself (Item 3; it will reuse `tracks.ts`), the download log
(Item 4).
