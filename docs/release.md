# Releasing Papertie

Papertie is released as a desktop app for macOS, Windows and Linux. GitHub Actions builds every
package on a Linux runner, in electron-builder's container image, whenever a version tag is
pushed, and publishes them as that tag's GitHub release. The packages are not code-signed yet.

- The workflow: `.github/workflows/release.yml`.
- The packaging: `apps/desktop/electron-builder.yml`, with its hooks in `apps/desktop/scripts/`.

## What a release has

| File | For |
| --- | --- |
| `Papertie-<version>-mac-arm64.zip` | macOS on Apple silicon (the `.app`, ad-hoc signed) |
| `Papertie-<version>-mac-x64.zip` | macOS on Intel |
| `Papertie-<version>-win-x64.exe` | Windows 10 and 11, x64 (an installer for the current user) |
| `Papertie-<version>-linux-x86_64.AppImage`, `…-linux-arm64.AppImage` | any Linux desktop |
| `Papertie-<version>-linux-amd64.deb`, `…-linux-arm64.deb` | Debian, Ubuntu and their kin |
| `SHA256SUMS` | the SHA-256 of each file above (`sha256sum -c SHA256SUMS`) |

Linux's packages use Linux's own names for the CPU: `x86_64` (AppImage) and `amd64` (.deb) are
x64. There is no DMG for macOS: one cannot be made reliably on Linux, so the Mac app comes as a zip.

## Cutting a release

1. Make sure `main` is what you want to ship: its `ci` run is green (lint, typecheck and the
   unit suites), and `pnpm test:crash`, `pnpm e2e:desktop` and `pnpm e2e:app` pass on your
   machine. The release run itself only repeats a quick gate (the desktop tests and the
   typecheck) before it builds.
2. Tag it with the version, prefixed with `v`, and push the tag:

   ```sh
   git tag v1.0.0
   git push origin v1.0.0
   ```

   The version inside the app (in its About box, the installers and the file names) comes from
   the tag, so `apps/desktop/package.json` does not need to change. A tag with a hyphen, such as
   `v1.1.0-beta.1`, is published as a pre-release.
3. Watch the run under the repository's **Actions** tab. It installs, runs the desktop tests and the
   typecheck, and builds Linux, then Windows, then macOS. It checks
   what each package holds, then launches the Linux x64 app under a virtual display (Xvfb, with
   openbox as its window manager) and runs the desktop tests against it. Then it writes
   `SHA256SUMS`. The Windows and macOS packages are built but not launched there. A second
   job, the only one allowed to write to the repository, then creates the release with every
   file attached (`gh release create`), its notes the opening instructions followed by GitHub's
   generated list of changes.
4. When the run is green, the release is under **Releases**. Edit its notes there if you like.

To redo a release, delete the release and the tag on GitHub, then tag and push again. Re-running
the same tag's workflow also works: it finds the release and replaces its files.

No secret is needed: the release job uses the run's automatic `GITHUB_TOKEN` with
`contents: write`, and nothing is signed with a certificate.

### A build without a release

**Actions → release → Run workflow** builds the same packages from the branch you pick, with the
version `<package.json version>-ci.<run number>`. It does not touch Releases. The packages are kept
as the run's artifact, `papertie-<version>`, for 30 days.

## What the downloads come with

The build fetches these during the run, besides the npm packages in `pnpm-lock.yaml`:

- the build image `electronuserland/builder:22-wine-10.26`, pinned to its digest;
- Electron's own builds for each OS, and electron-builder's tools (NSIS, AppImage, fpm), from
  GitHub, by electron-builder;
- `rcodesign` 0.29.0 (apple-codesign), which ad-hoc signs the Mac app from Linux, checked against
  its SHA-256 before it is run.

rcodesign only signs. Its own `verify` can't read an ad-hoc signature, so the proof is on a Mac:
unzip the run's `mac-arm64` zip and run `codesign --verify --deep --strict Papertie.app`, then the
desktop tests against it (`PAPERTIE_DESKTOP_EXE=…/Papertie.app/Contents/MacOS/Papertie pnpm exec
playwright test -c e2e/playwright.config.ts --project=desktop`).

## Opening an unsigned build for the first time

Each system asks once; after that Papertie opens like any other app.

- **macOS:** unzip the file and move **Papertie** to Applications, then open it. macOS says it
  cannot check Papertie for malicious software. Choose **Done**, then open **System Settings →
  Privacy & Security**, scroll to *Papertie was blocked to protect your Mac*, and choose **Open
  Anyway**, then confirm with your password. (If macOS ever says Papertie is *damaged*, the download
  lost the app's signature: download it again with a browser, not a tool that strips extended
  attributes, and unzip it with Finder.)
- **Windows:** run the installer. When **Windows protected your PC** appears (SmartScreen),
  choose **More info**, then **Run anyway**. Papertie installs for you alone, with no administrator
  rights, and starts.
- **Linux, AppImage:** make it executable, then run it:

  ```sh
  chmod +x Papertie-1.0.0-linux-x86_64.AppImage
  ./Papertie-1.0.0-linux-x86_64.AppImage
  ```

  Some distributions need FUSE 2 for AppImages (`sudo apt install libfuse2`, `libfuse2t64` on
  Ubuntu 24.04). An AppImage does not register `.papertie` files with the desktop; the .deb does.
- **Linux, .deb:** `sudo apt install ./Papertie-1.0.0-linux-amd64.deb`, then start Papertie from your
  applications.

## Where the board lives

Everything is on the computer, in Papertie's folder for the user:

| System | Folder | Papertie's log |
| --- | --- | --- |
| macOS | `~/Library/Application Support/Papertie/` | `~/Library/Logs/Papertie/papertie.log` |
| Windows | `%APPDATA%\Papertie\` (`C:\Users\<you>\AppData\Roaming\Papertie\`) | `%APPDATA%\Papertie\logs\papertie.log` |
| Linux | `~/.config/Papertie/` (or `$XDG_CONFIG_HOME/Papertie/`) | `~/.config/Papertie/logs/papertie.log` |

The board, its photos, books and history are in that folder's `data/`. Each board keeps its own
hourly backups in `data/…/backups/` (every hour for two days, then daily for a month, then
weekly for six months), which **Settings → History** restores from. The rest of the folder is
Electron's own (the window's size and place, caches).

Uninstalling Papertie does not remove this folder.

## Backing up

Papertie's own backups live on the same disk as the board, so keep a copy somewhere else as well.
Either:

- **Export:** **Settings → Export → Download .papertie** saves the whole board, with its photos and
  books, as one file. **Import…** on the same page (or opening the file with Papertie) brings it
  back, on this computer or another.
- **Copy the folder:** quit Papertie, then copy the whole folder from the table above (Time Machine,
  File History and most backup tools already include it). To restore, quit Papertie and put the
  folder back.
