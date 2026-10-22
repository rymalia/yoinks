# yoinks × yt-dlp: How It Works

Oct 17, 2026 · @Ryan

yoinks is a terminal UI around two yt-dlp calls: one `-J` call to read the video's formats, and one download call with a format selector, a forced mp4 container and a custom progress template. Nothing is re-encoded; on most sites the result matches what plain yt-dlp would download, except for the filename and, on YouTube, the container. All code references are to `src/lib/ytdlp.ts` unless noted.

## At a glance

&#91;embedded content: yoinks pipeline · 6 steps, 2 yt-dlp calls\]

The probe and the download are the only two yt-dlp runs per video; the dashed line is the probe's JSON being reused so the download starts without a second extraction.

## Finding yt-dlp and ffmpeg

yoinks uses whatever yt-dlp is already installed and only downloads its own copy as a last resort. `ensureYtDlp` (line 39) tries these in order, checking each with `--version` (10-second timeout, output ignored):

1. `yt-dlp` on your PATH.
2. `~/.yoinks/bin/yt-dlp`, a copy from an earlier run.
3. A fresh download from `https://github.com/yt-dlp/yt-dlp/releases/latest/download/<asset>`, where the asset is `yt-dlp_macos`, `yt-dlp.exe`, `yt-dlp_linux` or `yt-dlp_linux_aarch64`. It is saved as `yt-dlp.download`, made executable (`chmod 755`) and renamed into place.

`findFfmpeg` (line 66) does the same for ffmpeg, which is needed to merge separate video and audio streams and to make mp3s:

- If `ffmpeg -version` works on PATH, yoinks passes nothing and yt-dlp finds ffmpeg itself.
- Otherwise it uses the bundled `ffmpeg-static` binary and passes `--ffmpeg-location <path>`.
- If neither exists, single-file formats still download, but merges and mp3 extraction fail.

The resolved yt-dlp path is reused for the rest of the session. On a machine with yt-dlp installed system-wide, `~/.yoinks` never gets created.

## Probe: reading the video's formats

Before showing the picker, yoinks runs one metadata-only call (`probe`, line 106):

```
yt-dlp -J --no-playlist --no-warnings <url>
```

- `-J` prints one JSON object with the title, uploader, duration and the full `formats` list. Nothing is downloaded.
- `--no-playlist` means a playlist or thread URL only resolves to the one video it points at.
- The raw JSON is saved to `$TMPDIR/yoinks-info-<pid>-<timestamp>.json`. The download step loads it with `--load-info-json` so it can start without extracting everything again.

These temp files are never deleted by yoinks; macOS cleans old files out of `$TMPDIR` eventually. Probe errors show only the last `ERROR:` line from stderr, with its `[extractor]` prefix removed.

## Format choices

Each picker option is a height plus a container; yoinks never chooses a codec. `buildChoices` (line 143) lists the 8 tallest distinct heights in the probe, then one audio-only option.

| Picker option | Arguments passed | What it means |
| --- | --- | --- |
| `<H>p · mp4` (one per height, up to 8) | `-f "bv*[height=H]+ba/b[height=H]/bv*[height<=H]+ba/b" --merge-output-format mp4` | Best video at exactly H plus best audio; else a combined file at H; else the best at or below H. Always merged into mp4. |
| `best available · mp4` (only if no format has a height) | `-f "bv*+ba/b" --merge-output-format mp4` | Best video plus best audio, or the best combined file. |
| `audio only · mp3` | `-f "ba/b" -x --audio-format mp3 --audio-quality 0` | Best audio, converted to mp3 at the highest VBR quality. This is the one option that re-encodes. |

Within a height, yt-dlp's own default sort picks the stream. On YouTube that favours AV1/VP9 over H.264, so a `1080p · mp4` choice usually holds VP9 video and Opus audio.

The size shown next to each option comes from a separate score (`scoreVideo`, line 190) that adds 10,000 for mp4 and 5,000 for H.264. That score only feeds the label. When it picks a different stream than `-f` downloads, the estimate is wrong (see the YouTube case study).

## The download command

The download (`download`, line 218) is one spawned yt-dlp process, with arguments passed as an array (no shell). The full command for a 1080p pick:

```
yt-dlp --load-info-json $TMPDIR/yoinks-info-….json \
  -f "bv*[height=1080]+ba/b[height=1080]/bv*[height<=1080]+ba/b" --merge-output-format mp4 \
  --no-playlist --no-warnings --newline --no-quiet --progress \
  --progress-template "download:YOINK|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s" \
  --print after_move:filepath --no-simulate \
  -o ~/Downloads/%(title).60s.%(ext)s \
  [--ffmpeg-location <ffmpeg-static path>]
```

| Flag | Why yoinks passes it |
| --- | --- |
| `--load-info-json <file>` | Reuses the probe's metadata so the download starts at once. Replaced by the URL on retry. |
| `-f … --merge-output-format mp4` (or the mp3 args) | The picked format choice. |
| `--no-playlist` | Downloads one video, never a whole playlist. |
| `--no-warnings` | Keeps stderr to real errors. |
| `--newline` | Prints each progress update on its own line instead of redrawing with `\r`, so it can be parsed. |
| `--no-quiet` | `--print` turns on quiet mode, which would hide the `[Merger]` and `[ExtractAudio]` lines yoinks watches for. |
| `--progress` | Keeps progress output on while quiet-related flags are in play. |
| `--progress-template download:YOINK\|…` | One machine-readable line per update: bytes done, total, estimated total, speed, ETA. |
| `--print after_move:filepath` | Prints the final file path once the file is in place. |
| `--no-simulate` | `--print` also implies simulate mode; this makes it actually download. |
| `-o ~/Downloads/%(title).60s.%(ext)s` | Saves to `~/Downloads`, title cut to 60 characters, no video ID. |
| `--ffmpeg-location <path>` | Only when ffmpeg isn't on PATH and the bundled `ffmpeg-static` is used. |

**Retry:** if the cached-JSON attempt fails for any reason, `src/app.tsx` (around line 265) runs the same command again with the URL in place of `--load-info-json`. The intent is to handle expired media URLs, but any error triggers it.

Not passed: cookies, rate limits, subtitles, `--embed-*`, archive files or self-update (`-U`).

## Reading yt-dlp's output

The progress bar, the processing state and the final path all come from parsing yt-dlp's stdout line by line (lines 264–299).

| stdout line | What yoinks does with it |
| --- | --- |
| `YOINK\|bytes\|total\|estimate\|speed\|eta` | Updates the progress bar. When the byte count goes down, a new file has started, so the part counter goes up. `NA` and `None` count as unknown. |
| `[info] … Downloading 1 format(s): 616+251` | Counts the `+`-separated IDs to get the number of files (2 for a video+audio merge). |
| `[download] Destination: <path>` | Records the path for cleanup. |
| `[Merger] Merging formats into "<path>"` or `[ExtractAudio] Destination: <path>` | Records the path and switches the UI to "processing". |
| Any absolute path on its own line | Taken as the final file (from `--print after_move:filepath`). |

- **Cancel (`esc`):** the process is killed, and every recorded path is deleted along with its `.part` and `.ytdl` files.
- **Quit:** the running yt-dlp process gets `SIGTERM` when Node exits.
- **Errors:** only the last `ERROR:` line from stderr is shown, without its `[extractor]` prefix. With no such line, the message is the exit code.

## Case study: YouTube, webm vs mp4

On YouTube, yoinks downloads exactly the same streams as plain yt-dlp and only wraps them in a different container. Test video: [All the President's Men, Dahlberg's Check](https://www.youtube.com/watch?v=UmLNzZsEgA4), with yt-dlp 2026.08.19.

- `yt-dlp '<url>'` saved `All the President's Men ｜ Dahlberg's Check ｜ Robert Redford's One Shot ｜ Warner Classics [UmLNzZsEgA4].webm`.
- yoinks (1080p) saved `All the President's Men ｜ Dahlberg's Check ｜ Robert Redford'.mp4`.

|  | Plain yt-dlp | yoinks 1080p |
| --- | --- | --- |
| Formats selected | `616+251` | `616+251` |
| Container (ffprobe) | `matroska,webm` | `mov,mp4` |
| Video | VP9 Profile 0, 1920×1080, yuv420p, 23.976 fps | VP9 Profile 0, 1920×1080, yuv420p, 23.976 fps |
| Audio | Opus, 48 kHz, stereo | Opus, 48 kHz, stereo |
| Duration | 569.64 s | 569.63 s |
| Size | 290,860,463 bytes | 290,925,692 bytes |

The 65 KB difference is container overhead; nothing was re-encoded. ffprobe reports the webm's frame rate as `11582/483`, which is how it estimates Matroska timing; both files are 23.976 fps.

**Why the containers differ.** Format 616 is VP9 1080p over HLS (\~5.5 Mbps, listed as `mp4`) and 251 is Opus audio (\~102 kbps, `webm`). Both tools have to merge them into a new file. Plain yt-dlp picks webm because that suits VP9 and Opus. yoinks forces mp4 with `--merge-output-format mp4`.

**Which is truer to the source?** Neither. YouTube has no single original file, only separate streams in mixed containers, and both outputs carry those streams unchanged. The container matters only for playback support:

- **webm with VP9/Opus** is the expected pairing.
- **mp4 with VP9/Opus** is valid and plays in VLC, mpv and browsers. QuickTime, iOS Photos, iMovie, many editors and some TVs expect H.264/HEVC with AAC in an mp4 and may refuse it. The `.mp4` name promises a compatibility the file doesn't have.

**Size estimate.** For this 1080p option, the label score prefers format 137 (H.264, 165.24 MiB) plus format 140 (AAC, 8.79 MiB), about 174 MiB. The actual download is the 291 MB VP9 file. (Worked out from the code, not seen on the picker screen.)

1080p formats offered for this video:

| ID | Container | Codec | Bitrate | Size |
| --- | --- | --- | --- | --- |
| 616 | mp4 (HLS) | VP9 | 5551k | \~377 MiB (est.) |
| 270 | mp4 (HLS) | H.264 | 3810k | \~259 MiB (est.) |
| 614 | mp4 (HLS) | VP9 | 2684k | \~182 MiB (est.) |
| 137 | mp4 | H.264 | 2434k | 165.24 MiB |
| 248 | webm | VP9 | 1369k | 92.95 MiB |
| 399 | mp4 | AV1 | 867k | 58.87 MiB |

## Case study: X/Twitter, identical files

On X, yoinks and plain yt-dlp produce byte-identical files; only the filename differs. Test post: [Survival Instinct, band-aid handcuffs](https://x.com/SurvivalInstint/status/2111099342325166198).

- Plain yt-dlp: `Survival Instinct - Using a band-aid to set yourself free from handcuffs [2110911926595125248].mp4`
- yoinks: `Survival Instinct - Using a band-aid to set yourself free fr.mp4`
- Both: H.264 video, 720×1280, AAC audio, mp4 container, 20,633,476 bytes, SHA-256 `ab9e376b…`.

X serves H.264/AAC already in mp4, as one combined stream. Nothing needs merging, so `--merge-output-format mp4` has no effect and both tools save the bytes X sent. The same is true of most sites that serve combined H.264 mp4 files; YouTube's separate VP9/Opus streams are the main case where yoinks' output differs.

## Download history

yoinks keeps a short recent-URL list, not a download log. It lives at `~/.config/yoinks/history.json` (`src/lib/history.ts`) as a JSON array of URLs, newest first, and powers the ↑ recall in the URL input.

| Recorded | Not recorded |
| --- | --- |
| URLs of successful downloads | Failed or cancelled downloads |
| The 50 most recent | Anything older (the oldest drops off) |
| One entry per exact URL, moved to the top when repeated | Repeat downloads; the same video under two URL forms (e.g. with YouTube's `&pp=…`) counts as two |
| The URL only | Timestamp, title, format, output path |

Write errors are ignored, so a failure to save history never breaks a download. As of this guide, the file holds exactly 50 entries, so older downloads have already been dropped.

Other traces of a download: the `$TMPDIR/yoinks-info-*.json` probe files (full metadata, kept until the OS clears them) and the files in `~/Downloads`. Because filenames are cut to 60 characters and have no video ID, a file can't reliably be matched back to its URL.

## Gotchas and possible changes

| Behavior | Effect | Possible change |
| --- | --- | --- |
| `--merge-output-format mp4` with no codec preference | YouTube downloads are VP9/Opus in an `.mp4`, which Apple tools and many editors may not play | Add `-S vcodec:h264,res,acodec:m4a` to get real H.264/AAC mp4s, at the cost of the higher-bitrate VP9/AV1 streams at top resolutions |
| Size label scored for mp4/H.264 | Estimate can be far off (≈174 MiB shown vs 291 MB downloaded in the YouTube test) | Score the label with yt-dlp's own sort, or adopt the `-S` change so both agree |
| `%(title).60s` with no `[id]` | Long titles are cut; two videos with the same first 60 characters overwrite each other | Add `  [%(id)s] ` to the template |
| `--no-playlist` everywhere | Playlist and multi-video thread URLs give only one video | Playlist support is on the README roadmap |
| Retry on any `--load-info-json` failure | A real error runs the full extraction a second time before it shows | Retry only on errors that look like expired URLs |
| history.json capped at 50, URL only | No lasting record of what was downloaded | Append one line per success to `~/.config/yoinks/downloads.jsonl` (time, URL, title, format, path), optionally keeping the probe JSON beside the video |
| Bundled yt-dlp never updates | `~/.yoinks/bin/yt-dlp` goes stale as sites change | `yt-dlp -U` self-update is on the README roadmap |
