---
session_id: 8b6fc9e1-c4d6-4c5f-9d58-e6a36327941a
date: 2026-11-01
time: "9:21 PM PST – 10:42 PM PST"
project: yoinks
---

# Session Summary: yt-dlp release review and update check for the cached binary

## Overview

Reviewed the yt-dlp releases since yoinks started (2026.07.04 to 2026.10.26) for anything that affects yoinks, then fixed the one real concern. yoinks's fallback copy of yt-dlp in `~/.yoinks/bin` was never updated, so it now checks for a newer release once a week and replaces itself. The work was reviewed by Codex, tested with deliberately broken code, committed, fast-forwarded into `main` along with the two earlier feature branches, and pushed to the fork by the user. Afterwards, the README gained a note that YouTube needs `deno` to list all its formats. This machine already had deno, and yt-dlp detects it.

## Key Decisions Made

| Decision | Rationale |
|----------|-----------|
| **Only update yoinks's own copy, never a system yt-dlp** | A system install belongs to its package manager (Homebrew here). yoinks only owns `~/.yoinks/bin/yt-dlp`. |
| **Re-download instead of running `yt-dlp -U`** | yt-dlp's 2026.10.21 notice says old builds are open to man-in-the-middle attacks and recommends a manual download over the self-updater. Downloading through Node uses Node's TLS, not the old binary's certifi bundle. |
| **Weekly check, using the binary's mtime as "last checked"** | Avoids a network request on every run with no extra state file. The download sets the mtime, and a check that finds nothing newer updates it. |
| **Read the latest version from GitHub's redirect** | A `HEAD` request to `releases/latest` redirects to `releases/tag/<version>`. That needs no API token and isn't subject to API rate limits, and it was checked live (resolved to `2026.10.26`). |
| **Any failure keeps the working copy and leaves the mtime unchanged** | Being offline or GitHub being down shouldn't block a download, and leaving the mtime alone means the next run tries again. A user cancel still propagates. |
| **5-second timeout on the version check only** | The check runs before every probe once due, so it must not stall. The download itself has no timeout, but the user can cancel it. |
| **Skipped Codex finding 1** (`--version` checks ignore the cancel signal) | This was already true of the system-yt-dlp check, and the app checks for a cancel right after `ensureYtDlp`, so the user never sees it. The user agreed to skip it. |
| **No deno install needed** | The user asked to install deno if it was missing. It was already at `/opt/homebrew/bin/deno` (2.9.8), and `yt-dlp -v` lists `JS runtimes: deno-2.9.8`, so nothing was installed. |
| **Mention deno in two places in the README** | A one-line pointer in the requirements, where people look when setting up, and the explanation under "How it works", next to the other dependency notes (yt-dlp, ffmpeg). |
| **Fast-forward `main` instead of merging** | `feat/file-naming` → `feat/skip-picker` → `feat/ytdlp-update-check` were one straight line on top of `main`, so a fast-forward brought in all 11 commits with no merge commit. |

## Changes Made

| Change | Detail |
|--------|--------|
| **Update check** | `src/lib/ytdlp.ts`: `ensureYtDlp` now reads the cached copy's version through a new `commandOutput` helper and calls `maybeUpdateYtDlp`. New helpers: `isUpdateCheckDue`, `releaseTagFromUrl`, `downloadYtDlp` (temp file, chmod, rename; removes the temp file on failure; creates the binary's own directory) and `withTimeout` (works on Node 18, no `AbortSignal.any`). |
| **Tests** | New `src/lib/ytdlp-update.test.ts` with 8 tests: parsing the tag from the URL, the weekly timing (including an mtime in the future), replacing a stale binary, marking an up-to-date one as checked, skipping the network when recently checked, keeping the copy when offline or when the download fails (mtime unchanged), and a cancel reaching `fetch` (must reject well before the 5s timeout). `fetch` is stubbed and a temp directory is used. |
| **Docs** | `README.md`: described the weekly check and ticked the roadmap item. `docs/yoinks × yt-dlp - How It Works.md`: new "Keeping the downloaded copy current" section, and updated line numbers (`ensureYtDlp` 63, `maybeUpdateYtDlp` 95, `findFfmpeg` 174). |
| **Commit** | `c363724 feat: keep the downloaded yt-dlp binary up to date` |
| **Merge** | Fast-forwarded local `main` from `6f03720` to `c363724` (11 commits, including the earlier `feat/file-naming` and `feat/skip-picker` work). |
| **Cleanup** | Deleted untracked files from the repo root: the old `yt-dlp_macos` (Oct 16, before the security release) and the "The Daily Draught …" `.mp4` and `.en.vtt` test downloads. Deleted the local branches `feat/file-naming`, `feat/skip-picker` and `feat/ytdlp-update-check`. |
| **Pushes (by the user)** | `git push origin main` (`6f03720..c363724`), then `git push origin --delete feat/skip-picker feat/ytdlp-update-check`, then `git push origin main` (`c363724..f0d1b6a`, the first version of this summary), then a push of `1800831`. |
| **README deno note** | Requirements: "For YouTube, also install deno (`brew install deno`)", linking to How it works. How it works: a new bullet explaining that YouTube needs a JavaScript runtime to list all its formats, that yt-dlp uses deno by default, and that without it the picker may show fewer resolutions or the download may fail. Commit `1800831`. |
| **Session summary** | First version committed as `f0d1b6a`, then updated in place with the deno work (at the user's request, instead of writing a second file). |

## Testing / Research Performed

- **Release review:** read the notes for yt-dlp 2026.07.04, 2026.08.19, 2026.10.21 and 2026.10.26 via `gh release view`, and compared them with the flags yoinks passes in `src/lib/ytdlp.ts`. None of the flags yoinks uses were changed or deprecated.
- **Environment check:** Homebrew `yt-dlp` is 2026.10.26 and `deno` 2.9.8 is at `/opt/homebrew/bin/deno`. A `yt-dlp -v --simulate` run on a YouTube URL reported `JS runtimes: deno-2.9.8` and `yt_dlp_ejs-0.8.0` among the optional libraries. `~/.yoinks/bin` doesn't exist, so the new code doesn't run on this machine.
- **Live check:** a Node `HEAD` request to `https://github.com/yt-dlp/yt-dlp/releases/latest` returned 200 with final URL `…/releases/tag/2026.10.26`, and `releaseTagFromUrl` parsed `2026.10.26`.
- **Test suite:** `npm test` passed 36/36 and `npm run typecheck` was clean, both before and after the test fixes and again on `main` after the merge. `npm run build` succeeded on `main`.
- **Codex review** (`gpt-5.6-luna`, `xhigh`, read-only): no critical or major problems, three minor ones, verdict FIX. Finding 1 was skipped (see decisions). Findings 2 and 3 were fixed in the tests.
- **Deliberately broken code:**
  - Recording the check as done after a failure: 2 tests failed, as they should.
  - Not passing the user's cancel through to `fetch`: the cancel test still passed at first, because the 5s timeout eventually produced the expected error. After adding a check that the cancel lands within 2s, it failed as it should (5003 ms).
  - The source was restored from a backup and confirmed identical with `cmp` each time.

## Discoveries / Handoff Notes

- **yt-dlp 2026.10.21 security notice:** older yt-dlp executables are open to man-in-the-middle attacks because of a `certifi` advisory. Before this change, anyone running yoinks without a system yt-dlp stayed on their first-run version for good.
- **Python 3.11 is now required (2026.10.26).** This only affects pip and zipimport installs. The standalone binaries and Homebrew bundle their own Python.
- **YouTube relies more on a JS runtime.** `android_vr` was removed from the default clients (2026.08.19), and `deno` now skips a cooldown (2026.10.21). Users without deno may see fewer resolutions in the picker. The README now says so (`1800831`). To check whether yt-dlp finds a runtime, look for the `[debug] JS runtimes:` line in `yt-dlp -v` output.
- **Logins removed:** Reddit and LinkedIn login support, and the Vimeo `ios`/`macos` clients. yoinks passes no credentials, so it isn't affected.
- **Testing timeouts:** a fake `fetch` that fails on any aborted signal can't tell a user cancel from the timeout firing. Check how long the call took (or what the abort reason was) when testing that a cancel gets through.
- **Testing the full flow is hard on this machine:** the system `yt-dlp` always comes first, so it would need a machine or `PATH` without one.

## Current State

- On `main`. `origin/main` (`rymalia/yoinks`) is at `1800831` (README deno note, pushed by the user). Local `main` adds only the commit of this updated summary, which isn't pushed yet.
- `main` is the only branch left, locally and on the fork.
- Nothing was pushed to `upstream` (`pablostanley/yoinks`).
- The linked `yoinks` command runs from this checkout, and `dist/` was rebuilt from `main`.

## Summary Statistics

- yt-dlp releases reviewed: 4
- Source files changed: 1 (`src/lib/ytdlp.ts`); test files added: 1 (8 tests); doc files updated: 2 (README updated twice)
- Commits made this session: 4 (`c363724`, `f0d1b6a`, `1800831`, and the commit of this updated summary); commits fast-forwarded into `main`: 11
- Codex findings: 3 minor; 2 fixed, 1 skipped
- Deliberately broken versions tested: 2 (both caught after the cancel test fix)
- Untracked files deleted: 3; local branches deleted: 3; branches deleted from the fork (by the user): 2

## Unfinished Work

- **Optional:** fix Codex finding 1 by making `commandWorks`/`commandOutput` respect the cancel signal. Skipped on purpose for now.
- **Optional:** run the full update flow on a machine without a system yt-dlp, with an old copy in `~/.yoinks/bin`, to confirm the real swap.
- Push `main`: the commit of this updated summary isn't on the fork yet.
