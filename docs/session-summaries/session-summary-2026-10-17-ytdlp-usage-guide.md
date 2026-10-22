---
session_id: 8f7e3c85-1f8e-4d54-afb9-74b17576e0fe
date: 2026-10-17
time: "2026-10-16 10:21 PM PDT – 2026-10-17 12:54 AM PDT"
project: yoinks
---

# Session Summary: How yoinks uses yt-dlp

### Overview

A research-only session that traced every yt-dlp call yoinks makes and the flags it passes. It used ffprobe to compare yoinks output with plain yt-dlp output for a YouTube video and an X/Twitter video, and checked what download history yoinks keeps. The findings went into a Claude Docs guide, which the user saved to `docs/yoinks × yt-dlp - How It Works.md`. No source code was changed.

### Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **Verify format selection against live yt-dlp, not just the code** | Reading `-f` selectors can't show which stream yt-dlp's default sort picks. Running `--print '%(format_id)s %(ext)s'` with both selectors showed `616+251` either way, which settled that only the container differs. |
| **Hash the X/Twitter files instead of only probing them** | Same codecs and size could still hide differences. Matching SHA-256 proved the files are byte-identical. |
| **Wrote the guide as a Claude Docs doc** | The user asked for a comprehensive guide covering the whole discussion. A doc with tables and a pipeline diagram reads better than terminal output. The user then exported it into the repo. |
| **Proposed changes but implemented none** | The user only asked questions. Fixes like `-S vcodec:h264,…`, adding `[%(id)s]` to the filename and a `downloads.jsonl` log were offered, not applied. |

### Changes Made

| Change | Detail |
|--------|--------|
| **Guide doc (Claude Docs)** | "yoinks × yt-dlp: How It Works" at https://claude.ai/code/artifact/7de30b00-1f1b-4ed6-a803-6bdee0a6be35. Ten sections plus a 6-step pipeline diagram. Private until the user shares it. |
| **Repo copy of the guide** | `docs/yoinks × yt-dlp - How It Works.md`, saved by the user from the doc. The embedded diagram shows only as a placeholder line in the markdown. |
| **This summary** | `docs/session-summaries/session-summary-2026-10-17-ytdlp-usage-guide.md` (directory created). |

No commits were made. The untracked `.webm`/`.vtt` files and `yt-dlp_macos` in the repo root came from the user's manual testing, not from this session.

### Research Performed

- **Source audited:** `src/lib/ytdlp.ts` (all of it), `src/app.tsx` (probe and download orchestration, lines ~160–300), `src/lib/history.ts`, `README.md`.
- **yt-dlp calls catalogued:** four kinds of process launch (`--version` checks, `ffmpeg -version`, the `-J` probe, the download), with 3 format-choice argument sets and 12 download flags documented.
- **ffprobe on 2 YouTube outputs** (`UmLNzZsEgA4`): both VP9 1080p + Opus 48 kHz stereo. webm 290,860,463 B vs mp4 290,925,692 B.
- **Live format checks** with yt-dlp 2026.08.19: plain default → `616+251 webm`; yoinks 1080p selector → `616+251 mp4`. `-F` listing captured the 1080p formats (616, 270, 614, 137, 248, 399).
- **ffprobe + SHA-256 on 3 X/Twitter copies** (`2111099342325166198`): all H.264 720×1280 + AAC, 20,633,476 B, SHA-256 `ab9e376b…`, identical.
- **History file inspected:** `~/.config/yoinks/history.json` holds exactly 50 URLs (the cap). `~/.yoinks` doesn't exist because yt-dlp is installed system-wide.
- **Diagram render checked** by screenshot of the doc widget.

### Summary Statistics

- Source files audited: 3 (+ README)
- Media files probed: 5 (2 YouTube, 3 X/Twitter)
- Live yt-dlp queries: 3 (default selection, yoinks selection, `-F`)
- Source files modified: 0
- Guide sections written: 10 + 1 diagram

### Discoveries / Handoff Notes

- **yoinks never picks a codec.** The `-f` selectors only set a height. On YouTube, yt-dlp's default sort then picks VP9/AV1, so `--merge-output-format mp4` produces **VP9/Opus inside `.mp4`**. That plays in VLC, mpv and browsers but may fail in QuickTime, Photos and many editors. Neither container is "truer to the source": YouTube serves separate streams, both outputs copy them without re-encoding, and only the container differs.
- **The picker's size label is computed separately from the download.** `scoreVideo` (`src/lib/ytdlp.ts:190`) gives mp4/H.264 extra points, so the 1080p label for the test video is ≈174 MiB (137+140), but the download was the 291 MB VP9 stream. This is inferred from code; the picker screen wasn't checked.
- **X/Twitter serves H.264/AAC mp4 already**, so yoinks and plain yt-dlp give byte-identical files there. Only the filename differs.
- **Filename template** `%(title).60s.%(ext)s` cuts titles at 60 characters and leaves out the video ID, so two videos can overwrite each other.
- **Retry behavior:** any failure with `--load-info-json` triggers a full re-extraction (`src/app.tsx` ~265), not only expired URLs.
- **History is not a log:** successful downloads only, capped at 50, URL only, duplicates removed by exact text (so `&pp=…` variants count as separate entries), and write errors are ignored. Probe JSONs in `$TMPDIR/yoinks-info-*.json` are never deleted by yoinks.
- **zsh gotcha:** `echo ======` fails in zsh (`=` expansion) and aborted a chained command once this session.

### Current State

- Branch `main`, no commits made this session. New untracked files: `docs/yoinks × yt-dlp - How It Works.md` (user-saved) and this summary.
- The Claude Docs guide is private; others can't open the link until the user shares it.

### Unfinished Work

None of these were requested; they're open options from the discussion:

- [ ] Optionally add `-S vcodec:h264,res,acodec:m4a` so `.mp4` downloads are H.264/AAC, and make the size label match what `-f` downloads.
- [ ] Optionally add ` [%(id)s]` to the output template.
- [ ] Optionally add an append-only `~/.config/yoinks/downloads.jsonl` log (time, URL, title, format, path).
- [ ] Optionally limit the `--load-info-json` retry to expired-URL errors.
