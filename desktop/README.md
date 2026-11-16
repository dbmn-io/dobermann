# DBMN desktop app

The web app's screens in an Electron window. The window is locked down (no Node in the page);
the main process sends the requests, so an API that refuses a browser still answers. No VS Code
needed.

Every build today is a **dev build on the local backend** (the `DESKTOP · LOCAL` pill). It
cannot reach production.

## Before you start

```bash
npm run dev:local        # the local backend (Docker) and the local site; leave it running
```

Sign in as the local user that command prints (`learner@dbmn.local`) with its password.

## Install and run the packaged app

```bash
npm --prefix desktop install          # once
npm --prefix web run build:desktop    # the app's pages  -> web/dist-desktop/
npm --prefix desktop run package      # the app          -> desktop/release/
```

Then either:

```bash
desktop/release/linux-unpacked/dbmn-desktop                          # no install, runs in place
desktop/release/DBMN-0.3.1-dev.AppImage --appimage-extract-and-run   # the single file
```

To run the AppImage by double-click (or without the flag), install `fuse2` once:
`sudo pacman -S fuse2`, then `chmod +x desktop/release/DBMN-0.3.1-dev.AppImage`.

## Windows

An installer comes out of the **Build desktop app** workflow (GitHub → Actions → Build desktop
app → Run workflow): download the `DBMN-Windows` artifact from the run and run
`DBMN-Setup-0.3.1-dev.exe`. It installs for the current user, no admin prompt. Until the run
was made with "sign" ticked (Azure Artifact Signing, #373) the installer is unsigned and
SmartScreen warns: More info → Run anyway. It is a dev build like the Linux one: it needs the
local backend running on that Windows machine (Docker Desktop and the Supabase CLI, then
`npm run dev:local`), or sign-in says the stack is down.

The same installer builds on Linux with Wine installed (`sudo pacman -S wine`): `npm --prefix desktop run package:win` (unsigned).

## Run from source (while developing)

```bash
npm run web:dev                       # the web app's dev server on 127.0.0.1:5180
npm --prefix desktop run start        # the window, on that dev server
```

## What to check

1. The window opens on the sign-in page. Sign in. The first time, the app gets onto a workspace
   folder before anything else: it connects by itself to the folder DBMN for VS Code uses on this
   computer, or asks (the default `~/Dobermann-Workspace`, or another folder). Then the Hub opens,
   with `DESKTOP · LOCAL` in the header.
2. Your environments and endpoints are there (the same account catalogue as the web app).
3. Run an endpoint on the local Training Ground environment: its Console opens with the response.
4. Run an endpoint on an API that the web app can't reach from a browser (one that answers
   "blocked by the browser" there): here it answers.
5. Start a batch, then Cancel: it stops, and nothing is counted as an error.
6. Close the window and open it again: still signed in, History still has the runs, and no
   folder question. The runs are files in the workspace folder (`.dbmn/executions.db` and the run
   folders); DBMN for VS Code on the same folder shows the same History.
7. Click a help link (help mode, then a control): the docs page opens in your browser, not in the app.
8. New Endpoint from Clipboard works (the app may read the clipboard).
9. On Omarchy the window opens in the desktop's theme (sign-in too). `omarchy theme set <name>`
   with the window open: it follows within a second, tabs and Monaco included.
10. Settings › UI › Theme: Follow system first, then the light themes and the dark ones (the
    standard Light and Dark, then Omarchy's stock themes). A theme picked holds across a restart;
    Follow system puts the window back on the desktop's theme.
11. Not on Omarchy (Windows, macOS): Follow system switches with the computer's light or dark
    setting, between the Light theme and Dark theme rows that appear under it, and the standard
    Light and Dark wear the computer's accent colour. Not yet tried on either: no build for them.
12. Home shows "New since v…" (or "New in v…"), as DBMN for VS Code does: the build ships its
    version and changelog as `/release-notes.json`, and where "new" is measured from is kept on
    the installation.

## The workspace folder

The app always runs on a workspace folder: History and run results are files in it, never in the
app's own storage. Home has no "Use a folder…" card here.

- **Which folder** is this installation's choice, kept in the app's data
  (`~/.config/dbmn-desktop-local/workspace-folder.json`). Delete that file to be asked again.
- **A new installation** looks for the folders your account says DBMN has used. One on this
  computer: connected, nothing asked. Several: you pick. None: the default folder
  (`~/Dobermann-Workspace`) or one you choose in the folder dialog.
- **Settings › Workspace**: Change folder… (the app starts again on it) and Open folder.
- **The folder goes** (moved, renamed, its drive unplugged): within a few seconds the app stops
  on "Your workspace folder can't be found" until it is back, or you choose another. It is never
  quietly made again or swapped.
- Runs an earlier build kept in the app's own storage are moved into the folder the first time.

## Themes

Outside VS Code the pages ship VS Code's Dark Modern as `/theme.css`; a theme goes on top of it
as `--vscode-*` properties on the root element (`web/src/shell/theme.ts`), which the tab frames
copy and Monaco re-reads.

The choice (`src/services/theme/theme-choice.ts`) is Follow system until the user picks a theme:

- On Omarchy, Follow system is the desktop's current theme and each change to it.
- Anywhere else it is the computer's light or dark setting (`prefers-color-scheme`), between the
  user's light theme and their dark one: the standard Light and Dark until they pick others.
- The standard Dark is the page's own sheet; the standard Light is VS Code's Light Modern for the
  same colours (`standard-light.ts`). On Windows and macOS the main process reports the
  computer's accent colour and the standard themes wear it (`system-accent.ts`): the main button,
  the focus ring, the progress bar, links where they still read, the selected row in Dark. A
  named theme keeps its own. The e2e names an accent with `DBMN_SYSTEM_ACCENT` (a dev-build switch).

The mapping for an Omarchy theme is Omarchy's own: `omarchy theme set` renders a complete
VS Code colour theme for every theme from `/usr/share/omarchy/default/themed/vscode-theme.json.tpl`
(664 colours over the palette). VS Code on Omarchy wears that only for a theme that names no
VS Code extension of its own; most stock themes name one (their `vscode.json`), so VS Code and
this app can differ in colour on the same Omarchy theme. That is known and left as it is: this
app wears Omarchy's theme, not the extension's. The main process reads
the desktop's current theme from `~/.local/state/omarchy/current` (`theme/colors.toml` and
Omarchy's rendered `theme/vscode-theme.json`) and follows the directory
(`src/services/desktop/omarchy-theme-source.ts`); the template itself is bundled too, and
rendered over a palette (`src/services/theme/omarchy-vscode-theme.ts`) for the stock themes on a
computer without Omarchy. `node scripts/import-omarchy-themes.mjs` copies the stock themes and the
template from an Omarchy machine (re-run after an `omarchy update` that changes either). The
choice is the installation's, not the account's. The e2e points the app at a folder of its own
with `DBMN_OMARCHY_STATE_DIR` (a dev-build switch).

## Not built yet

- **Environment OAuth sign-in.** The sign-in popup is refused; the desktop app will sign in
  through your browser instead. Environments with no auth, a pasted token or DBMN auth work.
- **Secrets in the OS keychain.** Tokens are kept as the web app keeps them (encrypted in the
  app's own storage) for now.
- **Production.** No build can use the production backend yet.
- **Windows and macOS packages, signing, auto-update.**
- **Download progress** for large responses (the body arrives in one piece).
- Environments set to run through VS Code still go to VS Code.

## Tests

```bash
npm run test-stack:start
npm run test:e2e:desktop            # the app from source, on the web app's dev server
npm run test:e2e:desktop:packaged   # the packaged app in desktop/release (package it first)
```

Both run hidden (xvfb), never at the same time as the web tests. They run the desktop app's own
tests and the web app's Hub test, unchanged, in the app's window. More of the web app's tests by
name: `DBMN_DESKTOP_E2E_MORE=web/lesson-1.spec.ts,web/cancel.spec.ts npm run test:e2e:desktop:packaged -- lesson-1 cancel`.
