# Packaging Kanbini

How to produce installers / portable builds from the repo. Builds
ship **unsigned**: Windows SmartScreen will warn on first launch,
macOS Gatekeeper will block entirely. See "Shipping unsigned" below
for what that means in practice and how to prepare the Releases page.

## Build commands

From the repo root:

```bash
# Unpacked app (fastest - no installer, no .exe wrapping).
# Output: apps/desktop/release/win-unpacked/Kanbini.exe
pnpm --filter @kanbini/desktop run package:dir

# Full installer + portable for the current platform.
# Output (Windows): apps/desktop/release/Kanbini Setup X.Y.Z.exe
#                   apps/desktop/release/Kanbini X.Y.Z.exe (portable)
pnpm --filter @kanbini/desktop run package
```

Both scripts run `apps/desktop/scripts/prepackage.mjs` first, which:

1. Builds the MCP stdio bundle (`apps/mcp/dist/index.js`) - gets
   copied to `<resources>/mcp/` so Settings → MCP can point users at
   a real bundle path instead of a placeholder.
2. Ensures `better-sqlite3` is compiled for the Electron 41 ABI (the
   dev `predev` hook does this too; tests flip it to the Node ABI and
   back, so the pre-flight re-flip is a safety net).
3. Builds main + preload + renderer via electron-vite.

After that, `electron-builder` reads `apps/desktop/electron-builder.yml`
to wrap everything into a Windows NSIS installer + portable .exe (or
a macOS .dmg / Linux AppImage when run from those platforms).

## Windows: the Developer Mode / elevation gotcha

**electron-builder pre-fetches `winCodeSign-X.Y.Z.7z` on every Windows
build and extracts a few macOS `.dylib` symlinks.** Windows 10/11 only
lets non-elevated processes create symlinks if Developer Mode is on.
First run from a regular PowerShell crashes with:

```
ERROR: Cannot create symbolic link : A required privilege is not held
by the client. : ...\winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
```

Two fixes:

- **Run from an elevated terminal** (right-click PowerShell → "Run as
  administrator", then `cd` to the repo, then `pnpm --filter
  @kanbini/desktop run package`). One-time per session.
- **Enable Windows Developer Mode** (Settings → Privacy & security →
  For developers → Developer Mode on). Persistent across reboots, no
  admin needed afterward. **Recommended for repeat builds.**

The cache directory (`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`)
ends up populated either way; subsequent builds re-use it without
re-extracting. The Mac dylibs aren't actually used for Windows-target
builds - electron-builder just extracts the whole archive regardless.

## Building for Linux

Linux ships as a single **AppImage** (`linux.target` in
`electron-builder.yml`): a self-contained binary that runs across distros
with no install step and no auto-updater pinging out, which fits the
offline ethos. It runs unsigned with no Gatekeeper/SmartScreen-style gate:

```bash
chmod +x Kanbini-X.Y.Z.AppImage
./Kanbini-X.Y.Z.AppImage
```

**It must be built from a Linux host.** electron-builder cannot
cross-compile the `better-sqlite3` native binding from Windows, so a
Windows machine cannot produce a working Linux build. Any of these hosts
work:

- A native Linux box (x64).
- **WSL2** on the Windows dev machine (a full Linux userland; install the
  build tools the same way as on native Linux).
- A Linux CI runner (GitHub Actions `ubuntu-latest`).
- A Docker image with the toolchain baked in (`electronuserland/builder`).

### Steps (native Linux or WSL2)

```bash
# 1. Build toolchain for the native module (Debian/Ubuntu shown).
sudo apt-get install -y build-essential python3

# 2. Install deps + put better-sqlite3 on the Electron 41 ABI.
pnpm install
pnpm --filter @kanbini/desktop run rebuild:native

# 3. Verify the bundle loads. A headless host has no display, so wrap
#    the launch-smoke (and e2e) in a virtual one.
xvfb-run -a pnpm verify

# 4. Package the AppImage.
pnpm --filter @kanbini/desktop run package
# Output: apps/desktop/release/Kanbini-X.Y.Z.AppImage
```

`prepackage.mjs` runs the same MCP-build + ABI-rebuild + electron-vite
steps it does on Windows. `ensure-electron-abi.mjs` probes whether the
binding loads under Electron and, if not, runs `electron-rebuild` to put
`better-sqlite3` on the Electron 41 ABI - downloading a prebuilt when one
exists for your platform, compiling from source otherwise (which is why
step 1 installs a toolchain). So step 2 is usually a fast no-op after the
first run.

The `postpackage` `check-payload.mjs` guard inspects the NSIS installer
payload and is Windows-only; on Linux it logs `SKIP` and exits 0, so the
AppImage build completes without payload verification (there is no
AppImage equivalent yet).

> **Status (2026-06):** the codebase is Linux-clean - every `win32` /
> `darwin` branch in `main` no-ops on Linux, the renderer falls back to
> the correct userData path (`~/.config/Kanbini`) and modifier keys
> (Ctrl, not Cmd), and the AppImage target + Linux icon
> (`build/icon.png`) are already configured. But no Linux build has been
> smoke-tested. Treat the first one as unverified until
> `xvfb-run -a pnpm verify` and a manual launch pass are green on the
> target host.

## Verifying a packaged build

The app's `--launch-smoke` flag boots through migrations + opens the
control channel + exits 0/1 - same path the dev `pnpm test:launch`
uses. Electron's CLI parser eats unknown `--flags` before main runs
on the packaged exe, so the same check goes through an env var:

```powershell
# From the repo root after a successful package:dir
$env:KANBINI_LAUNCH_SMOKE="1"
& "apps/desktop/release/win-unpacked/Kanbini.exe"
Remove-Item Env:KANBINI_LAUNCH_SMOKE
```

Exit 0 = main bundle loads, better-sqlite3 native binding dlopens,
migrations run clean. Exit 1 = something broke; the error is on stderr.

For a manual visual check, just launch `Kanbini.exe` (no flag) - the
boards-home should open and seed the sample board if no `userData`
exists yet.

### The stale-installer trap (now caught automatically)

`apps/desktop/scripts/check-payload.mjs` runs automatically as
`postpackage` after every `pnpm --filter
@kanbini/desktop run package`. It opens the produced installer's
`$PLUGINSDIR/app-64.7z` payload via `7z l` and asserts every
required sentinel file is present - `resources/app.asar`,
`NOTICES.md`, `mcp/index.js`,
`drizzle/meta/_journal.json`, the asar-unpacked `better_sqlite3.node`.
If anything's missing the script exits non-zero with a "stale-installer
trap" diagnostic and rebuild instructions, so a silently-broken
installer can't escape the build machine.

Run standalone any time against the latest installer in `release/`:

```bash
pnpm --filter @kanbini/desktop run check:payload
```

The original-flavour manual mtime + 7z check is still useful when
the guard itself misbehaves or you want to inspect a different file:


The `release/` directory holds BOTH the loose `win-unpacked/` tree
AND the wrapped `.exe`. They can get out of sync if you ran
`package:dir` after `package` (only the unpacked tree updates) or
edited `electron-builder.yml` without rebuilding the `.exe`. Before
trusting a VM test failure as a code bug, confirm the installer's
mtime is at least as new as the most recent `electron-builder.yml`
edit:

```powershell
Get-Item "apps/desktop/release/Kanbini Setup X.Y.Z.exe" |
  Select-Object Name, LastWriteTime
Get-Item "apps/desktop/electron-builder.yml" |
  Select-Object Name, LastWriteTime
```

If the YAML is newer, rebuild (`pnpm --filter @kanbini/desktop run
package`) before re-testing. A quick payload sniff - does the .exe
actually contain `resources\drizzle\meta\_journal.json`? - catches
`extraResources` regressions specifically:

```bash
"/c/Program Files/7-Zip/7z.exe" e -y -o/tmp/peek \
  "apps/desktop/release/Kanbini Setup X.Y.Z.exe" '$PLUGINSDIR/app-64.7z'
"/c/Program Files/7-Zip/7z.exe" l /tmp/peek/app-64.7z | grep -i "_journal"
```

A missing line is a packaging bug; a present line means the failure
is genuinely in the code
that runs after install.

## What's in the output

`apps/desktop/release/win-unpacked/`:

```
Kanbini.exe              - the renamed Electron binary (main entry)
resources/app.asar       - main + preload + renderer + bundled deps
resources/app.asar.unpacked/
  node_modules/better-sqlite3/  - native .node, MUST be outside asar
resources/mcp/index.js   - the MCP stdio server bundle
resources/drizzle/       - committed Drizzle migrations (openDatabase
                            runs them on first launch + on each
                            schema bump; missing = crash on first
                            SQL call)
*.dll, *.pak, locales/   - Electron runtime + Chromium assets
```

The `better-sqlite3` unpack is non-optional: Node can't `dlopen` a
native module from inside an asar archive. `asarUnpack` in the YAML
config keeps it loadable.

The MCP bundle path is resolved in `apps/desktop/src/main/index.ts`
via `process.resourcesPath` (`<install dir>/resources/mcp/index.js`).
Settings → MCP renders this absolute path in the config snippet so
users can paste it directly into their AI client.

## Shipping unsigned

Builds ship without code-signing. What that looks like on each
platform:

### Windows

First-run SmartScreen popup:
> *"Windows protected your PC. Microsoft Defender SmartScreen
> prevented an unrecognized app from starting. Running this app
> might put your PC at risk."*
> `[More info]` → `[Run anyway]`

Two clicks to dismiss. Recommended copy for the Releases page or
README to set expectations:

> **First launch may show a Windows SmartScreen warning** because
> Kanbini isn't yet code-signed. Click **More info** → **Run anyway**.
> The app runs entirely offline and stores your data locally; you can
> inspect / export everything from inside the app (Settings → Data).

The `release/Kanbini Setup X.Y.Z.exe` installer and `release/Kanbini
X.Y.Z.exe` portable both behave this way. Both are per-user installs
(no UAC needed at install time either).

### macOS

Gatekeeper blocks the .app entirely with "developer cannot be
verified" and no obvious bypass. Effectively broken for non-technical
users. Decision: **Mac is deferred from the v1 release**. The
`mac:` target stays in `electron-builder.yml` for the day signing +
notarization make sense ($99/yr Apple Developer Program + Mac
host required).

### Linux

AppImage runs unsigned without any warning. `chmod +x
Kanbini-X.Y.Z.AppImage && ./Kanbini-X.Y.Z.AppImage`. The painless
platform. Linux build needs a Linux host (or WSL); not auto-built
on Windows in v1.

## When / how to add signing later

If signing infra ever materialises, the wire-in points are:

- **`win.signtoolOptions`** in `electron-builder.yml` (or env vars
  `CSC_LINK` / `CSC_KEY_PASSWORD`). Microsoft's **Azure Trusted
  Signing** (~$10/mo, no USB token) or a traditional Windows
  **EV cert** (~$400/yr + USB token, instant SmartScreen trust)
  are the two realistic paths. OV certs (~$200/yr) work but
  SmartScreen still warns until you build download "reputation."
- **`mac.notarize: true`** + `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`
  env vars. Requires an active Apple Developer Program membership.

Until then, leave both blank - electron-builder will log "signing
with signtool.exe" but the resulting .exe is unsigned (signtool with
no cert is a no-op). The portable .exe still works fine.

## What's NOT done yet (other than signing)

- **macOS dmg build from Windows** - not supported by electron-builder;
  the recipe in `electron-builder.yml` is correct but has to be run
  from a Mac host (or a Mac CI runner). Moot for v1 (Mac deferred).
- **App icon** - `directories.buildResources: build` is configured;
  drop `build/icon.ico` (Windows) + `build/icon.icns` (Mac) +
  `build/icon.png` (Linux, 512x512) and electron-builder picks them
  up automatically. Without them the default Electron icon ships.
- **License audit + NOTICES file** - done.
  `pnpm --filter @kanbini/desktop run build:notices` regenerates
  `NOTICES.md` at repo root from the production dependency closure;
  electron-builder ships it under `<resources>/NOTICES.md`. Rerun
  after any `pnpm install` that adds/removes/bumps a production dep.
- **Auto-update** - none, by design. The app makes zero outbound
  calls for updates; users download a new `Kanbini Setup X.Y.Z.exe`
  from the project's Releases page and double-click. NSIS overwrites
  the program files in place and `%APPDATA%\Kanbini` (DB +
  attachments + mcp-token) is preserved across the upgrade.

## Verifying the "remove my data on uninstall" hook on Windows

The renderer's Settings → Backup & restore → "Remove my data when
uninstalling" toggle writes
`HKCU\Software\Kanbini\RemoveDataOnUninstall` to 0 or 1 via
`reg.exe`. The NSIS `customUnInstall` macro in
`apps/desktop/build/installer.nsh` reads that key during uninstall
and conditionally `RMDir /r`s `%APPDATA%\Kanbini`. None of that
path is reachable in dev mode (NSIS only runs against a packaged
installer), so end-to-end validation needs a one-time install →
toggle → uninstall cycle. The cleanest place to do this is a
disposable Windows 11 VM - snapshot before, throw away after, your
host's `%APPDATA%` stays untouched.

**Setup (host):**

```bash
# From an elevated PowerShell on the build host (winCodeSign needs
# either elevation or Developer Mode - see top of this doc).
pnpm --filter @kanbini/desktop run package

# Copy the installer to the VM. Filename is `Kanbini Setup X.Y.Z.exe`
# where X.Y.Z is from `apps/desktop/package.json`.
ls apps/desktop/release/Kanbini\ Setup*.exe
```

**In the VM (snapshot first!):**

1. **Install.** Double-click `Kanbini Setup X.Y.Z.exe`. The
   installer is per-user (`perMachine: false`), so no UAC prompt;
   it installs to `%LOCALAPPDATA%\Programs\Kanbini\` and registers
   under HKCU. **A Yes/No dialog asks whether to create a desktop
   shortcut** (`installer.nsh` customInstall - electron-builder's
   `createDesktopShortcut` is binary, so the prompt is how we offer
   the choice; default is Yes, silent `/S` installs keep that
   default). The Start-menu shortcut is always created.

2. **Verify install layout.**
   ```powershell
   # Program files:
   ls "$env:LOCALAPPDATA\Programs\Kanbini"
   # User data (created on first launch):
   ls "$env:APPDATA\Kanbini"
   ```

3. **Test path A - leave data (the default).** Launch Kanbini,
   create a board, close it. Open the toggle's location and
   confirm the default is OFF:
   ```powershell
   reg query HKCU\Software\Kanbini /v RemoveDataOnUninstall
   # Expected: RemoveDataOnUninstall    REG_DWORD    0x0
   # (Or no value yet if you never opened Settings.)
   ```
   Uninstall via Add/Remove Programs → confirm
   `%LOCALAPPDATA%\Programs\Kanbini` is gone AND
   `%APPDATA%\Kanbini` still exists with your SQLite + attachments.

4. **Reset the VM snapshot, reinstall, then test path B - opt-in.**
   This time open Settings → Backup & restore → "Remove my data
   when uninstalling", flip it ON, close the app.
   ```powershell
   reg query HKCU\Software\Kanbini /v RemoveDataOnUninstall
   # Expected: RemoveDataOnUninstall    REG_DWORD    0x1
   ```
   Uninstall → confirm `%APPDATA%\Kanbini` is now gone too.
   `reg query HKCU\Software\Kanbini` should also fail
   (our HKCU subtree is cleaned by the same macro).

**Negative checks** (worth a one-time pass to catch the obvious
ways this could go wrong):

- **Mid-uninstall app held lock.** Open the app, then run
  uninstall without closing first. NSIS's `RMDir /r /REBOOTOK`
  queues anything still locked for delete-on-reboot - the
  uninstaller should complete and you'll see one or two files
  re-attempted at next boot.
- **Hand-wiped registry.** Delete `HKCU\Software\Kanbini` by
  hand, then uninstall. The missing key reads back as "" via
  `ReadRegDWORD`, which the `IntCmp $0 1` arm maps to the
  skip-remove branch - userData stays put. Same outcome as
  "user never opened Settings."

If anything diverges from the above, the bug is in
`build/installer.nsh` or in the renderer→main IPC writing the
registry value. The IPC half is dev-testable via `regedit` after
flipping the toggle in `pnpm dev`.

## Verifying upgrade-in-place on Windows

The update strategy is "user downloads a new installer and runs it
on top." NSIS overwrites the program files; everything under
`%APPDATA%\Kanbini` survives. This procedure validates the upgrade
path end-to-end in a disposable VM.

**Setup:** build two installers with different version numbers.

```powershell
# 1. Build v0.0.1 (or whatever apps/desktop/package.json says today).
pnpm --filter @kanbini/desktop run package
Copy-Item "apps\desktop\release\Kanbini Setup*.exe" "<somewhere>\v0.exe"

# 2. Bump the version, rebuild.
#    Edit apps/desktop/package.json "version" to e.g. 0.0.2.
pnpm --filter @kanbini/desktop run package
Copy-Item "apps\desktop\release\Kanbini Setup*.exe" "<somewhere>\v1.exe"

# 3. Revert the version bump so it doesn't sneak into a commit.
git checkout apps/desktop/package.json
```

**In the VM (snapshot first):**

1. **Install v0.exe.** Accept the desktop-shortcut prompt either
   way (doesn't matter for this test). Launch Kanbini, create a
   board called "Upgrade canary" with one card. Open Settings →
   Backup & restore, flip "Remove my data when uninstalling" ON.
   Close the app.

2. **Snapshot the things that must survive.**
   ```powershell
   # The mcp-token's first 8 chars - it MUST stay identical
   # across the upgrade, or every AI client config breaks.
   (Get-Content "$env:APPDATA\Kanbini\mcp-token").Substring(0,8)
   # The registry value - must also survive.
   reg query HKCU\Software\Kanbini /v RemoveDataOnUninstall
   # The DB exists.
   ls "$env:APPDATA\Kanbini\kanbini.sqlite"
   # Note the current version shown in Settings → About.
   ```

3. **Run v1.exe.** Same per-user installer, no UAC. Accept
   whatever the customInstall prompt asks. The installer should
   complete WITHOUT asking you to uninstall the prior version
   first (NSIS one-click upgrade-in-place).

4. **Verify everything survived.**
   ```powershell
   # mcp-token unchanged (compare the 8 chars to step 2).
   (Get-Content "$env:APPDATA\Kanbini\mcp-token").Substring(0,8)
   # Registry value still 0x1.
   reg query HKCU\Software\Kanbini /v RemoveDataOnUninstall
   # DB still there.
   ls "$env:APPDATA\Kanbini\kanbini.sqlite"
   ```
   Launch Kanbini. **Expected:**
   - Settings → About shows the new version (0.0.2 or whatever).
   - The "Upgrade canary" board is in the boards list with its
     one card intact.
   - The Remove-data toggle is still ON.
   - The MCP bundle path under Settings → AI integration still
     resolves (the install dir is stable across NSIS upgrades).

5. **If the migration count changed between versions**, also
   confirm the Drizzle migrations applied cleanly on launch (no
   error toast, no console error in the dev tools attached to
   the packaged app - `KANBINI_LAUNCH_SMOKE=1` is the cleanest
   way to assert this if you want it scripted).

**What FAILS this test (regressions to watch for):**

- `mcp-token` changed across the upgrade → every Claude Desktop /
  Claude Code config the user pasted now silently fails auth.
  Check that nothing in `apps/desktop/src/main/index.ts` writes
  the token unconditionally on startup.
- Registry value reset to 0 → the toggle persistence is broken;
  upgrade somehow ran the customUnInstall macro's cleanup branch.
  Check that NSIS isn't running customUnInstall on overwrite-
  installs (it shouldn't - but worth confirming).
- `%APPDATA%\Kanbini` wiped → the NSIS recipe lost track of the
  data-vs-program-files distinction. This would be a major bug,
  not a polish task.

## CI integration

GitHub Actions runs typecheck + the unit-test suite on pull requests
(see `.github/workflows/ci.yml`). Packaging itself is not in CI: it
needs a Windows host (and a virtual display for the Electron smoke /
e2e tests), so installers are still built locally with `pnpm verify
&& pnpm --filter @kanbini/desktop run package` (~3 minutes on a clean
Windows machine). A commented-out e2e job in the workflow shows how
to add the Electron-dependent coverage later.
