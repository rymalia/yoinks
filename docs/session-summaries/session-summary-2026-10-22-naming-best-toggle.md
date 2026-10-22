---
session_id: 8f7e3c85-1f8e-4d54-afb9-74b17576e0fe
date: 2026-10-22
time: "2026-10-16 10:21 PM PDT – 2026-10-22 01:08 AM PDT"
resumed: "2026-10-21 11:00 PM PDT, 2026-10-22 12:42 AM PDT"
project: yoinks
branch: feat/skip-picker
---

# Session Summary: file naming, short-side picker, res:best toggle, fork setup

### Overview

This session continued after the earlier research summary
(`session-summary-2026-10-17-ytdlp-usage-guide.md`, which covers 2026-10-16 to 10-17).
Since resuming on 2026-10-21 it pointed the repo at the user's fork, finished item 1
(file naming) and item 2 (skip the picker) from the user's feature list, fixed the
picker's resolution labels, updated the guide, and switched the global `yoinks` to a
link to the local clone. Seven commits sit on `feat/file-naming` → `feat/skip-picker`,
none pushed.

Timestamps: start and resume times come from the SessionStart hook output. The
metadata collector reported `session_start: 2026-10-22 12:42 AM PDT` because the hook
re-fires on resume; the true start of this session id was the first hook value,
2026-10-16 10:21 PM PDT.

### Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **Renamed `origin`→`upstream`, added the fork as `origin`** | Fork-only contribution flow; `main` now tracks `origin/main` (rymalia/yoinks). |
| **Add the video id to every filename** | Reproduced a real bug: two videos sharing a 60-char title prefix mapped to one name, yt-dlp printed "already downloaded", exited 0 and returned the first file's path, so yoinks reported success with the wrong file. |
| **Title cut by bytes (`.60B`), id via yt-dlp's `%(id)s`** | Character cuts can exceed 255-byte limits on multi-byte titles; interpolating the raw id bypassed yt-dlp sanitizing (caught in review). |
| **`--names slug` style; `video-<service>-` prefix when a title has no usable characters** | User wanted CLI-friendly names. YouTube ids can start with `-`, so a bare id could produce a name that tools read as an option. Service is yt-dlp's extractor (X shows as `twitter`, as the user wanted). |
| **Resolution suffix after the id, short side of the actual download** | Groups variants of one video together; matches yt-dlp's habit of suffixing variants. Orientation is decided once from the probe, then yt-dlp fills `%(height)s` or `%(width)s`, so a fallback format is named truthfully. User chose short side for vertical video. |
| **Picker labels use the short side too, via the shared `isPortrait`** | Picker said 1280p for a file named 720p; one shared helper keeps label, selector and filename in agreement. |
| **Toggle named `res:ask` / `res:best`, key `^p`, flag `--best`, session-only** | Mirrors the existing `--theme`/`^t` pattern. `^b` is used by the text input and is tmux's prefix. `res:` was the user's choice and fits the 80-column picker footer on one line. Persistence deferred to a shared settings file. |
| **Footer hints joined with non-breaking spaces** | At 80 columns the footer split `^t` from `theme:auto`, which also broke that hint's click target (click-map matches one rendered line). |
| **Version `0.4.0-rymalia`, add `prepare` script, `npm link` now** | `yoinks -v` tells the fork from the npm release; `dist/` is gitignored, so a GitHub install needs `prepare` to build. Linking runs whatever branch is checked out during development. |

### Changes Made

| Change | Detail |
|--------|--------|
| **Git remotes** | `origin` = https://github.com/rymalia/yoinks.git, `upstream` = pablostanley/yoinks. |
| **`6a44df0` feat: id and resolution in names, `--names slug`** | New `src/lib/naming.ts` + tests; `ytdlp.ts` takes an output template; `app.tsx` builds it once and reuses it for the retry; `args.ts`, `cli.tsx` help, README. |
| **`59eb927` fix: picker short side** | `buildChoices` groups/labels/selects by width for vertical video; new `src/lib/ytdlp.test.ts`. |
| **`3541cf8`, `f82c1cb` docs** | Committed the yt-dlp guide and the earlier session summary; updated the guide with a File names section and marked the naming gotchas fixed. |
| **`b5f74e2` feat: `--best` and `^p` toggle** | `app.tsx` (refs so the memoized probe reads the current mode; `startDownload` shared by pick and auto-download), `args.ts`, tests, `cli.tsx`, README, `components/shortcuts.tsx` (non-breaking hints + `hintText`). |
| **`4e69bd0` build** | `"prepare": "npm run build"`, version `0.4.0-rymalia` (package.json + lock). |
| **`e2d7366` docs: `docs/local-install.md`** | How this machine runs the fork, how to tell which yoinks is running, the later GitHub install, npm 12 gotchas. |
| **Global install** | `npm uninstall -g yoinks` (npm 0.3.1) then `npm link` from `~/projects/yoinks`. |

### Testing / Research Performed

- **Unit tests:** `npm test` 28/28 pass, `npm run typecheck` and `npm run build` clean (run locally after each change; Codex's own counts were not relied on).
- **Collision bug reproduced** in a `mktemp -d` dir with yt-dlp 2026.08.19 before fixing it.
- **End-to-end downloads** through yoinks' own `probe`/`download` code against real yt-dlp: every picker choice of a landscape YouTube video (`jNQXAC9IVRw`) and the vertical X post (`2111099342325166198`) in both styles — 14 downloads, 14 distinct files, every suffix matching ffprobe's measured dimensions; picker labels matched files after the short-side fix.
- **Real TUI in Terminal.app:** `--best` skipped the picker and saved `Me at the zoo [jNQXAC9IVRw] 240p.mp4`; `^p` toggled the label live; ask mode still shows the picker; footer read back as one line at 80 columns.
- **Footer render check** with Ink at 80/60/40 columns: every hint stayed whole.
- **Git install test:** `npm i -g --prefix <tmp> --allow-git=root git+file:///…#feat/skip-picker` built `dist/` and `yoinks -v` printed `0.4.0-rymalia`. Without `--allow-git` npm 12 refused (`EALLOWGIT`).
- **Codex passes:** 1 plan review, 5 delegated implementations (gpt-6-luna high), 6 code reviews (gpt-5.6-luna xhigh/high). Findings that changed the code: raw id in title template, tests locking that bug in, wrong README examples, weak hash tests, missing suffix cases.
- **Not verified:** mouse clicks on footer hints (synthetic clicks never reached the app, not even on a known-good row); the `res:` rename and README wording were not re-reviewed by Codex.

### Summary Statistics

- Commits: 7 (`6a44df0`, `59eb927`, `3541cf8`, `f82c1cb`, `b5f74e2`, `4e69bd0`, `e2d7366`), none pushed
- Tests: 17 → 28, all passing
- New source files: 2 (`naming.ts`, plus tests `naming.test.ts`, `ytdlp.test.ts`)
- Real downloads verified: 14 naming end-to-end + 1 TUI `--best` run

### Discoveries / Handoff Notes

- **yt-dlp silently skips existing names:** same output path → "has already been downloaded", exit 0, `--print after_move:filepath` prints the old file. Any future naming change must keep names unique per video and resolution.
- **yt-dlp template syntax verified:** `%(height&-{}p|)s` gives `-240p` or nothing; `.60B` cuts by bytes. `--print` shows names before yt-dlp's character replacement (`|` → `｜`).
- **X titles are already shortened** by yt-dlp's extractor (98–114-char default names), so the original 60-char cut was mostly cosmetic. X filenames use the media id, not the post id.
- **npm 12 defaults:** git installs blocked (`--allow-git=root` to allow); dependency install scripts blocked (`ffmpeg-static` never downloads its binary — fine while Homebrew ffmpeg is on PATH). `prepare` still runs when npm packs a git package despite an "install-scripts blocked" warning.
- **Testing traps hit this session:** zsh needs URLs with `?` quoted; tsx treats `.ts` outside the repo as CommonJS (use `.mts`, or `.tsx` in a dir with `{"type":"module"}`); System Events `click at` and Peekaboo clicks did not reach the Ink app.
- **Process slip:** one Codex run was started with a shell `&` (untracked); it was killed before touching files and re-run as a tracked background task. One `rm -f *` was blocked by a guard; replaced with `mktemp -d` folders.

### Current State

- Branch `feat/skip-picker` (on top of `feat/file-naming`, which is on top of `main`), clean apart from untracked user media in the repo root, `yt-dlp_macos`, and `docs/.DS_Store`.
- Global `yoinks` is linked to `~/projects/yoinks` (`yoinks -v` → `0.4.0-rymalia`); it runs whatever branch is checked out after `npm run build`.
- A Terminal window opened for testing may still be running yoinks (`^c` to quit). Test file `~/Downloads/Me at the zoo [jNQXAC9IVRw] 240p.mp4` (~300 KB) can be deleted.
- The Claude Docs copy of the guide (https://claude.ai/code/artifact/7de30b00-1f1b-4ed6-a803-6bdee0a6be35) was not updated; the repo copy is current.

### Unfinished Work

Planned next steps, in the order agreed with the user:

- [ ] **Push:** `git push -u origin feat/skip-picker` (includes `feat/file-naming`). User pushes.
- [ ] **Item 4 — readable download log:** new file beside `history.json` (which stays as is) recording time, URL, title, chosen format and output path for each successful download.
- [ ] **Item 3 — subtitles toggle:** yt-dlp `--write-subs` / `--write-auto-subs`, probably `--embed-subs`; subtitle files should follow the new naming (`…-<id>-1080p.en.vtt`).
- [ ] **Item 5 — batch URLs:** paste several URLs, download one after another with a pause between; build on `res:best` so a batch doesn't stop at the picker for each video.
- [ ] **Settings persistence:** a shared settings file for `res` mode, subtitles and naming style, instead of session-only toggles.
- [ ] **Picker size estimates:** still wrong (e.g. repeated "~1.9 MB"; the label score prefers mp4/H.264 while `-f` downloads VP9).
- [ ] **Hand-check footer hint clicks** in a real terminal with a real mouse; optional Codex pass over the `res:` rename.
- [ ] **When the work is done:** merge into `main`, push, then `npm unlink -g yoinks && npm i -g --allow-git=root github:rymalia/yoinks#main` (see `docs/local-install.md`).
- [ ] **Optional:** H.264/AAC sort (`-S vcodec:h264,res,acodec:m4a`) so `.mp4` files play in Apple tools; update the Claude Docs copy of the guide.
