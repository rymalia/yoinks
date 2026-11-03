# Plan: `yoinks meta` — metadata, captions and thumbnails without downloading

Status: design rev 2, 2026-11-03 (rev 1 reviewed by Codex gpt-5.6-luna xhigh →
REVISE; all findings accepted). Branch `feat/meta-command`.

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

**Root cause of the 429s:** yt-dlp's `en` entry in `automatic_captions` was a
*machine translation* (`timedtext?…&lang=uk&tlang=en&key=yt8`) of another ASR
track; the original-language ASR track is listed as `<lang>-orig`. Translated
tracks are throttled far harder. Downloading media concurrently does not help.
**Track choice, not download mode, decides success.**

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
                     [--sub-format json3|vtt] [--translated-subs]
                     [--thumbnail] [--output-dir DIR] [--sleep SECONDS]
yoinks meta --help
```

- Dispatched in `src/cli.tsx` **before** line 71 (alternate screen / Ink
  `render()`); no TTY needed, no TUI side effects.
- `parseArgs` returns a discriminated union: `{mode: 'tui', initialUrl,
  …}` (exactly today's shape — existing parser tests unchanged) or
  `{mode: 'meta', urls, …}`. `yoinks <url>` and every existing flag behave as
  now; usage errors outside `meta` still exit 1.
- Inputs: positional URLs and `--file` may be combined; `--file -` reads stdin;
  blank lines and `#` comments ignored; duplicates (after normalising to
  `videoId` for YouTube, exact string otherwise) are collapsed, keeping first
  position. Order of `items` = input order.
- `--json`: exactly one JSON document on stdout; progress/diagnostics on stderr
  only. Without `--json`: one human-readable line per item on stdout.
- Usage errors (`meta` only): message on stderr, no JSON, exit 2.
- Exit codes: 0 = every requested artifact for every item succeeded or was
  legitimately unavailable (e.g. no captions exist); 1 = at least one artifact
  failed (any `errors[]` entry with `kind` ≠ `unavailable`); 2 = usage.
- Artifacts are written only when `--subs` / `--thumbnail` ask for them, to
  `--output-dir` (default `~/Downloads/yoinks-meta/`), named by ID:
  `<videoId>.thumb.jpg`, `<videoId>.<sourceLang>[.<requestedLang>].<kind>.<fmt>`
  (e.g. `1W-4jx8g7N0.en.asr.json3`). Existing files are overwritten atomically
  (write temp, rename) — never trust a "skipped" path. All `path` values are
  absolute.

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
      "sourceLang": "en", "requestedLang": "en", "kind": "asr",
      "translated": false, "vssId": "a.en", "name": "English (auto-generated)",
      "format": "json3", "path": "/abs/…", "text": "…"
    }],
    "providers": {"metadata": "youtube-api", "captions": "innertube", "thumbnail": "youtube-api"},
    "errors": [
      {"artifact": "captions", "kind": "unavailable", "retryable": false,
       "message": "no caption tracks"}
    ]
  }]
}
```

- `videoId` is `null` for non-YouTube URLs; every `metadata` field is nullable;
  `chapters` is `null` unless the yt-dlp provider ran (the Data API has none).
- `thumbnail` / `captions` are `null` when not requested; `captions: []` +
  an `unavailable` error means "requested, none exist".
- `errors[].artifact` ∈ `metadata | captions | thumbnail`;
  `kind` ∈ `unavailable | rate_limited | auth | quota | not_found |
  login_required | network | parse | provider`. Messages pass through the
  sanitizer (below).
- `text` is plain transcript text (segments joined by spaces); the file keeps
  timings.

## Providers

| Need | Primary | Fallback |
|---|---|---|
| Metadata | **Data API `videos.list`** when `YOUTUBE_API_KEY` is set — batches of ≤50 IDs, `part=snippet,contentDetails` | yt-dlp `-J --skip-download --no-playlist` in a **new in-memory runner** (`probe()` is not reused: it persists the ~11 MB JSON to `$TMPDIR` and never deletes it). Only selected fields are kept. |
| Captions | **InnerTube ANDROID player** request → normalise tracks → select → fetch `fmt=json3` (vtt converted locally on request) | yt-dlp `--skip-download --write-subs --write-auto-subs --sub-langs <exact resolved key> --sleep-subtitles <n> --sleep-requests 0.75` |
| Thumbnail | The API's best returned URL (`maxres` → `standard` → `high`) when the key is set; otherwise probe `i.ytimg.com/vi/<id>/maxresdefault.jpg` → `hqdefault.jpg` | yt-dlp `--write-thumbnail`, adding `--convert-thumbnails jpg --ffmpeg-location` only when `findFfmpeg()` returns a path |

- **The API key is optional everywhere**, for `meta` and for any future yoinks
  feature. No key → yt-dlp metadata.
- API failure handling: `quotaExceeded` / `dailyLimitExceeded` → yt-dlp
  fallback for the rest of the run, `errors` gets one `quota` entry per affected
  item; invalid key (400 `keyInvalid`) or 403 other → `auth` error, fall back
  to yt-dlp; 5xx / network → retry ×2 with backoff, then fall back. IDs missing
  from the response → `not_found` for metadata (video private/removed), no
  yt-dlp retry.
- Thumbnail checks: HTTP 200 **and** `content-type: image/*` **and** non-empty
  body; dimensions from the API or by reading the JPEG SOF header; if
  undecodable, `width`/`height` are `null` (not an error).
- Non-YouTube URLs: yt-dlp provider only.
- InnerTube is unofficial and will break: one module, client constants in one
  place, failures (other than 429) fall through to the yt-dlp caption provider.

### Caption-track selection (`src/lib/meta/tracks.ts`, pure)

Both providers are normalised into one candidate shape before selecting:

```ts
type CaptionCandidate = {
  sourceLang: string        // BCP-47 of the spoken/written track ("en", "en-GB", "uk")
  requestedLang: string     // what the caller asked for after matching
  kind: 'manual' | 'asr'
  translated: boolean       // true only for tlang/auto-translated entries
  vssId: string | null      // InnerTube ".en", "a.en", ".en.abc123"
  name: string | null
  fetch: {provider: 'innertube' | 'ytdlp', key: string}  // baseUrl or yt-dlp sub key
}
```

- **InnerTube:** `kind === "asr"` ⇒ ASR, else manual; `sourceLang` from
  `languageCode`, cross-checked against `vssId` (`a.<lang>` = ASR,
  `.<lang>[.<variant>]` = manual). `translationLanguages` (web/mweb clients
  only) produce `translated: true` candidates, never emitted by default.
- **yt-dlp:** keys under `subtitles` ⇒ manual; under `automatic_captions`,
  `<lang>-orig` ⇒ ASR original (`sourceLang = <lang>`), any other key ⇒
  `translated: true` from the original. yt-dlp's synthesized `-orig` is
  mapped back; `a.en` and `en-orig` are never compared as strings.
- **Order for requested language L** (first hit wins, per requested language):
  1. manual, `sourceLang == L` exactly;
  2. manual, `sourceLang` starts with `L-` (regional, e.g. `en-GB`); several →
     prefer the one matching `audioLanguage`, then the one without a vssId
     variant suffix, then first;
  3. ASR original with `sourceLang` == L or `L-*`;
  4. only with `--translated-subs`: a translated candidate into L (labelled
     `translated: true`, `sourceLang` = the real source).
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
- **429 policy:** classify separately; honour `Retry-After` (seconds or
  HTTP-date, capped at 300 s); otherwise backoff 30 s → 90 s with jitter;
  max 3 attempts per artifact. After a 429 the item does **not** fall through
  to the other caption provider (both hit `timedtext`); it records
  `rate_limited, retryable: true`. Two consecutive items ending
  `rate_limited` ⇒ stop fetching captions for the rest of the run (metadata
  and thumbnails continue) and say so on stderr.
- Caching is the caller's job in v1: dewey-pipeline keys results by
  `videoId` and skips IDs it already has.

## Secrets

- `YOUTUBE_API_KEY` is read from the environment only and passed as a query
  parameter internally. Request URLs are **never** logged or put in errors.
- Every error message (fetch, API JSON, yt-dlp stderr) goes through
  `sanitize()` (redacts the literal key value and any `key=…` parameter)
  before reaching stderr or `errors[]`.
- Test: run the batch with a sentinel key against stubbed failures (400, 403,
  network error) and assert the sentinel is absent from stdout and stderr.

## Code layout

```text
src/lib/meta/
  ids.ts          URL → {extractor, videoId} (watch, youtu.be, shorts, embed, live, m., music.)
  tracks.ts       CaptionCandidate normalisation + selection (pure)
  youtube-api.ts  videos.list batching, error classification
  innertube.ts    player request, captionTracks → candidates, json3 fetch
  ytdlp-meta.ts   in-memory -J runner, field extraction, caption/thumbnail fallback (reuses ensureYtDlp/findFfmpeg)
  thumbnail.ts    URL choice, fetch, content-type + SOF dimension read
  pacing.ts       sleep injection, jitter, Retry-After parsing, 429 circuit breaker
  sanitize.ts
  run.ts          orchestrates one batch → schema-1 document
src/lib/args.ts   discriminated parse result; `meta` subcommand + flags
src/cli.tsx       early `meta` branch before line 71; help text mentions `meta`
```

## Tests (`node --test` via tsx; baseline 36/36)

- `args`: existing tests untouched; new `meta` cases (combined inputs,
  `--file -`, duplicates, usage → exit 2, unknown flag inside `meta`).
- `ids`: every URL shape above, plus non-YouTube URLs → `videoId: null`.
- `tracks` (fixtures from real `captionTracks` and yt-dlp `automatic_captions`
  lists): exact manual en; several manual en variants; `en-GB` only; ASR-only
  with `-orig`; the `uk → en` translated case (must not select without
  `--translated-subs`, and must label `sourceLang: "uk"` with it); original
  language ≠ requested; no ASR at all; Shorts; live/upcoming.
- `youtube-api`: mapping, missing IDs, quota / keyInvalid / 403 / 5xx paths.
- `pacing`: Retry-After seconds + HTTP-date, cap, jitter bounds, breaker.
- `sanitize` + the sentinel-key end-to-end test.
- One opt-in live smoke test (`YOINKS_LIVE=1`), skipped by default.

## Decisions on rev-1 open questions

1. **Cache:** none in yoinks for v1; callers key by `videoId`.
2. **Default `--sub-format`:** `json3` (timings, easy to parse); `vtt` on request.
3. **Thumbnail source:** API-returned URL when the key is set (no extra probe);
   direct `ytimg` probe otherwise.

## Out of scope (v1)

Comments, statistics snapshots, search, playlist/channel enumeration,
translated subtitles by default, PO tokens, **netrc** (ignored by yt-dlp's
YouTube extractor) and **cookies** (possible future opt-in flag, off by
default — logged-in bulk caption fetching risks the Google account), the TUI
subtitles toggle itself (Item 3; it will reuse `tracks.ts`), the download log
(Item 4).
