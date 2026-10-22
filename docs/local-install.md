# Running your fork of yoinks

How the `yoinks` command on this machine is set up, and how to change it.
Written 2026-10-22 (npm 12.2.1, Node 24.18.0 via nvm).

## Which yoinks am I running?

```sh
yoinks -v        # 0.4.0-rymalia = this fork; 0.3.x = Pablo's npm release
which yoinks     # ~/.nvm/versions/node/<version>/bin/yoinks
ls -la "$(npm root -g)" | grep yoinks
```

The last line tells you how it was installed:

| You see | Meaning |
| --- | --- |
| `yoinks -> ../../../../../../projects/yoinks` | **linked** to the clone in `~/projects/yoinks` (current setup) |
| `drwxr-xr-x … yoinks` (a folder) | a normal install, from npm or from GitHub |
| nothing | not installed for this Node version |

## The current setup: linked to the local clone

The npm release (0.3.1) was uninstalled and the clone was linked:

```sh
npm uninstall -g yoinks          # only if the npm release is installed
cd ~/projects/yoinks
npm install                      # installs tsup etc. and builds dist/ (via "prepare")
npm link
```

**On a fresh clone (e.g. another Mac), `npm install` must come first.** Running
`npm run build` or `npm link` before it fails with `sh: tsup: command not found`,
because tsup is a dev dependency and isn't installed yet. If that already happened,
just run `npm install` in the clone: it builds `dist/`, and an existing link starts
working.

What that means day to day:

- `yoinks` runs `~/projects/yoinks/dist/cli.js`. Code changes take effect after
  `npm run build` (or leave `npm run dev` running, which rebuilds on save).
- **Whatever branch is checked out is what runs.** Switching branches and
  rebuilding switches the app.
- `dist/` is gitignored, so after a fresh clone or `git clean` you must run
  `npm install` (fresh clone) or `npm run build` (existing clone) or `yoinks` breaks.

## Later: a fixed install from your GitHub fork

Once the feature branches are merged into `main` and pushed:

```sh
npm unlink -g yoinks
npm i -g --allow-git=root github:rymalia/yoinks#main
yoinks -v   # 0.4.0-rymalia
```

This installs a fixed copy of your fork's `main` that does not change when you
switch branches locally. Re-run the `npm i -g …` line to update it.

Why the extra bits:

- **`--allow-git=root`:** npm 12 refuses git installs by default (error
  `EALLOWGIT`). `root` allows only the package you named, not git dependencies
  of its dependencies. To stop typing it: `npm config set allow-git=root --location=user`.
- **`"prepare": "npm run build"` in package.json:** `dist/` is not in git, so
  npm has to build it while installing from GitHub. npm runs `prepare` itself when
  it packs a git package. It also prints an `install-scripts … blocked` warning for
  `yoinks (prepare)`; that only refers to a second run at install time. The
  install still works (tested 2026-10-22 with a local `git+file://` install).
- **The `ffmpeg-static` warning:** npm 12 also blocks dependency install scripts,
  so the bundled ffmpeg binary is never downloaded. That is fine here because
  Homebrew's `ffmpeg` (`/opt/homebrew/bin/ffmpeg`) is on PATH and yoinks uses it
  first. On a machine without ffmpeg, allow it once:
  `npm i -g --allow-git=root --allow-scripts=ffmpeg-static github:rymalia/yoinks#main`.

## Gotchas

- **Installs are per Node version.** After `nvm use <other version>`, `yoinks` is
  missing (or is an older install) until you link or install again there.
- **Don't run `npm i -g yoinks`.** That installs Pablo's npm release (0.3.x) over
  your fork. `yoinks -v` shows which one you have.
- **Going back to the npm release:** `npm unlink -g yoinks && npm i -g yoinks`.

## Git remotes (for reference)

```
origin    https://github.com/rymalia/yoinks.git       your fork; push here
upstream  https://github.com/pablostanley/yoinks.git  original; pull updates from here
```

Push with `git push -u origin <branch>`, never to `upstream`.
