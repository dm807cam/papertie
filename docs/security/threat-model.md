# Papertie threat model

Papertie is an Electron app for macOS, Windows and Linux: one window, one board, one person, with no accounts, no sync, no hosting and no standalone server.

Scope: who can reach the board, what a hostile file can do, how data can be lost or leak, and the one request the app makes to the outside. Mitigations name the code; verification names the test.

Assumptions: one person uses the app, on a computer they control, as an operating-system user of their own. Board content is JSONL files plus images under the data folder, `<userData>/data/users/<userId>/` ([ADR-0001](../adr/0001-storage.md)), with the one user's id in `<userData>/data/local-user.json`. The app's store (apps/server, `createHostApp`) runs inside Electron's main process; the window's page talks to it only through a custom scheme. The page keeps no copy of the board: edits not yet sent are in memory only. Other software running as the same operating-system user is out of scope: it can read the data folder as the app can.

## 1. Who can reach the board

- **Threat:** Another program on the machine, another machine on the network, or a web page in a browser reading or changing the board through the app's API; a page inside the app's window being turned against it.
- **Mitigation:**
  - **No network listener in the packaged app.** The desktop host (`apps/desktop/src/main.ts`) hands each request of the page to the app's `fetch` through `protocol.handle('papertie')` (`apps/desktop/src/bridge.ts`): no port is opened, so nothing else on the machine or the network reaches the API. Only `papertie://app` is answered; any other host, and a path with an encoded slash, backslash or NUL, is a 404 before the app sees it.
  - **The custom scheme** `papertie://app` is registered as privileged (standard, secure, fetch and streaming), so the page is an origin of its own with the browser's same-origin rules.
  - **Origin check on writes.** Every POST, PUT, PATCH and DELETE needs the app's own `Origin`, `papertie://app`; nothing else is trusted (`apps/server/src/middleware/security.ts`, `config.ts`). The bridge adds `Origin: papertie://app` only to the page's own requests that came without one. No response grants another origin a read (no CORS headers).
  - **No sessions, so none to steal.** Nothing sets a cookie and there are no sign-in or account routes. Every board route takes the one user (`asUser` in `apps/server/src/user.ts`).
  - **The renderer is sandboxed:** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`. The preload exposes six functions and nothing else of Electron or Node: `papertieDesktop.onOpenFile` (a `.papertie` file the system opened) and the update check's five (`onUpdateAvailable`, `openUpdate`, `dismissUpdate`, `getUpdateSetting`, `setUpdateSetting`; section 12). The main process listens to them only from the app's own page in its own window (`fromApp` in `main.ts`). The page cannot navigate away from `papertie://app` (a web link opens in the system browser), open windows or attach webviews, and the session grants only the permissions it needs.
  - **Strict CSP** on every response, the web app's pages included: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; …; frame-ancestors 'none'`, with `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and same-origin COOP/CORP.
  - **The store's own tests** put the app behind a port on 127.0.0.1 (`apps/server/test/helpers/httpServer.ts`), never on the network and never in the app.
- **Verification:** `apps/server/test/oneUser.test.ts` (no account route answers, nothing sets a cookie; the origin check: the app scheme passes, others and none are refused; `createHostApp` answers through `app.fetch` with no port, and refuses any other origin), `apps/server/test/authz.test.ts` (every state-changing route, "delete all data" included, refused without a trusted `Origin`; the route matrix's completeness), `apps/server/test/http.test.ts` (headers on every response), `apps/desktop/test/bridge.test.ts` (only `papertie://app`, forged paths, the opened file once), `e2e/desktop` (`pnpm e2e:desktop`: the built app), `e2e/app/csp.spec.ts` (`pnpm e2e:app`: no CSP violation in the built app).

## 2. Forged ids and path traversal

- **Threat:** A request reaching files outside a board's directory, or another board's, through a forged id, a `../` path or an encoded separator.
- **Mitigation:**
  - Every board, asset, export, backup, import and book route checks its ids (`idParam`, `requireBoardOwner` in `apps/server/src/middleware/owner.ts`): an id must match `^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$` and be the user's; anything else is the same 404 as a missing resource.
  - Paths are built only from server-generated ids, resolved, and checked to stay inside the user's directory (`apps/server/src/store/paths.ts`). A restore's `:backupId` must be a canonical backup file name.
  - Region corners and other query values are strictly parsed and bounded; anything else is 400 `invalid`.
- **Verification:** `apps/server/test/authz.test.ts` (every id row with every forged spelling, `%2f`-encoded ids that would resolve onto a real board, raw-path traversal from `/api/assets`, and the board unchanged after the whole matrix), `apps/server/test/http.test.ts` (`idParam`, `requireBoardOwner`), `apps/server/test/region.test.ts`, `apps/server/test/static.test.ts`.

## 3. Corruption and data loss

- **Threat:** Crash or power loss mid-write, truncated or hand-edited files, invalid or dangling records, lost unacked edits, concurrent write races, disk loss.
- **Mitigation:**
  - Per-board single writer (promise-chain mutex) and group commit; a batch is acknowledged only after it is durable: its line in `journal.jsonl`, appended and fsynced ([ADR-0001](../adr/0001-storage.md), Snapshot plus journal).
  - Atomic snapshot (compaction, restore): write `board.jsonl.next`, fsync, rename over `board.jsonl`, fsync the directory, then rotate the journal the same way. On macOS, Node's `sync()` is a full flush (`F_FULLFSYNC`).
  - Batches validated (schema, invariants, asset ownership) on a clone, then committed whole or rejected whole.
  - `eof` checksum; on load, malformed lines go to `quarantine/`, dangling references are repaired and logged to `repairs.jsonl`, and a missing or mismatched `eof` marks the board *recovered* while preserving the damaged file. Nothing is silently dropped.
  - The page holds an edit in memory until the store acknowledges it and sends it again if the answer is lost; `clientId`+`seq` idempotency applies it once. As the page goes away, every edit not yet sent goes as one request (`apps/web/src/sync/unload.ts`). An edit the store refuses is kept for the unsaved-changes download (Settings → Export). Staged batches carry their digest, so a stage never combines different parts ([ADR-0005](../adr/0005-ops-commit-and-undo.md)).
  - Hourly, daily and weekly backups in the data folder; restoring one (Settings → History) first keeps the current board as a safety backup, and commits at a revision above every one reached.
  - Quitting the app waits for the board's writes in flight and closes the store before the process ends (`will-quit` in `apps/desktop/src/main.ts`).
  - Disk loss: the backups are on the same disk as the board. The user's own backup of the data folder (Time Machine or the platform's equivalent) covers it.
- **Verification:** `pnpm test:crash` (SIGKILL at injected points; every restart loads the last acked revision exactly; truncated files, garbage lines and dangling yarn are recovered or quarantined; deletions survive), `apps/server/test/backups-routes.test.ts`, `apps/server/test/recovery.test.ts`, `apps/web/test/sync/SyncClient.test.ts` and `unload.test.ts` (an answer lost, a refused edit kept for the download, the page leaving), `e2e/desktop/desktop.spec.ts` (a note, a thread and a book's words outlive a quit), fast-check fuzzing of corrupted JSONL (`pnpm test`).

## 4. Malicious uploads

- **Threat:** Executable or scriptable content (SVG, HTML, polyglot files), decompression bombs, oversized uploads, spoofed MIME types, metadata leaks (GPS EXIF), disk exhaustion.
- **Mitigation:**
  - Raw upload limit 25 MB. Magic-byte sniffing accepts JPEG, PNG, WebP, AVIF and GIF (first frame only); SVG and HTML are rejected; the client MIME type and file name are ignored.
  - sharp decodes with `limitInputPixels`, auto-orients, strips all metadata including GPS EXIF, and re-encodes to WebP (2560, 1024 and 256 px) under server-generated ids.
  - A photo quota (64 GB) bounds what a runaway page can write.
  - Served with `nosniff`, `Content-Disposition: inline`, and the strict CSP.
- **Verification:** `apps/server/test/assets.test.ts` (polyglot files, SVG, a decompression bomb, a wrong MIME type, a file over the size limit).

### 4a. Imports of `.papertie` files

- **Threat:** A hostile `.papertie` (zip) or `.jsonl` file, opened from Settings → Import or by the system (a double-click, a file dropped on the app's icon): a zip bomb, an entry inflating past its claimed size, `../` or absolute entry names, symlink or directory entries, duplicate entries, a board over `LIMITS.maxNotes`, an oversized or non-image "photo", a damaged or newer-version board file; an upload sized to fill the disk; an import half done when the app dies; a crafted file leaking into logs.
- **Mitigation:**
  - A file the system opens is never imported on its own: the desktop host queues its path and hands the page a one-time `papertie://app/_opened/<token>` URL (`apps/desktop/src/openedFiles.ts`), which the page fetches and gives to Settings → Import, where the user sees the preview and confirms. Only `.papertie` paths named by the system are taken.
  - The preview streams the body to the board's own `import-<ulid>/` directory, never into memory, reading at most the photo quota left plus 1 GB of text. Nothing is committed until the commit; a staged import expires after 15 minutes, and leftovers are removed at start. One import per board at a time; all imports together stay within one staging budget (65 GB, and the free disk less 2 GB).
  - The archive is listed before anything is read: only `manifest.json`, `board.jsonl` and `assets/asset_<ULID>.webp`, each once, regular files, unencrypted, stored or deflated, at most 100:1, within caps. Names are compared byte for byte and never used as paths.
  - `board.jsonl` is judged strictly as it streams in; any invalid line, schema failure, duplicate id, `eof` mismatch, dangling reference or newer version rejects the whole file (422 `import-invalid`).
  - Photos go through the upload pipeline under fresh ids. The commit keeps a safety backup first and installs the file at a revision above every one reached; killed at any point, the board loads as it was or as imported.
  - Logs carry ids, counts, sizes and reason codes only.
- **Verification:** `apps/server/test/import.test.ts` (one case per hostile archive, each leaving the board, its assets, the quota and the staging directories as they were; the staging budget; a deletion of all data not held by a stalled upload), `apps/server/test/crash/import.crash.test.ts`, `apps/desktop/test/fileOpen.test.ts` and `bridge.test.ts` (the opened-file queue and its one-time URL), `apps/web/test/settings/ImportBoard.test.tsx` and `openedFile.test.tsx`, `e2e/app/data.spec.ts` ("export, then import: the board comes back from its .papertie file"), `e2e/desktop/desktop.spec.ts` (a `.papertie` file opened by the system, and one on the command line, asked about first).

## 5. Secrets

- **Threat:** Credentials or keys leaking through the repo, board files, the page or logs.
- **Mitigation:**
  - Papertie holds no secret: no password, session, token or mail setting exists, and nothing needs setting (`apps/server/src/config.ts`).
  - Releases are built by GitHub Actions (`.github/workflows/release.yml`). The workflow publishes with its automatic `GITHUB_TOKEN`, granted `contents: write`; no other credential exists, and none is in the repository. The packages are not code-signed: the Mac app is signed ad hoc only (`apps/desktop/scripts/afterPack.mjs`), with no Developer ID, and a `SHA256SUMS` file is published beside the packages.
  - The data, `users/` and `trash/` directories are created 0700 and repaired to it at every start, best effort, so another operating-system user cannot read the boards.
  - No secret is tracked in git; exports and backups hold board files and photos only.
- **Verification:** `apps/server/test/modes.test.ts` (a 0755 data folder repaired; a refused mode warned by count), `apps/server/test/config.test.ts` (nothing needs setting), `apps/desktop/scripts/checkPackages.mjs` (what a built package may and may not hold: no sources, tests or source maps).

## 6. Backup access

- **Threat:** Backups, which hold full board history and images, being exposed through a route.
- **Mitigation:**
  - Backups sit in each board's own `backups/` in the data folder, outside any static directory. Backup, export and restore routes go through the id checks of section 2 and, for a restore, the Origin check of section 1.
  - Assets referenced by retained backups are not deleted until after the 30-day grace period.
- **Verification:** `apps/server/test/authz.test.ts` (backup, export and restore routes in the matrix), `apps/server/test/export.test.ts`, `e2e/app/journey.spec.ts` (Settings → Export → `.papertie`: `manifest.json`, `board.jsonl` and the photo).

## 6a. Serving the web app

- **Threat:** The static route that serves the built web app reading files outside its directory, shadowing an API route, or serving pages without the CSP.
- **Mitigation:**
  - The app serves the web app only when given its directory (the desktop host's `web/`).
  - Registered after every route, for `GET`/`HEAD` only, never for `/api` or `/api/*`. Paths are decoded, resolved and checked to stay inside the directory, symlinks included; dot segments, encoded slashes, backslashes and NULs are a 404.
  - Every response, `index.html` included, gets the security headers of section 1.
- **Verification:** `apps/server/test/static.test.ts`, `apps/desktop/test/bridge.test.ts`.

## 7. Logging

- **Threat:** Logs leaking note text, labels, file names, book text or ids.
- **Mitigation:**
  - Only the keys of `LOG_KEYS` are ever written; requests are logged as route templates, never raw paths with ids. The desktop app writes the log to `papertie.log` in the platform's logs folder, rotated at a size cap.
- **Verification:** `apps/server/test/logs.test.ts` (one full flow through a real server: a board, ops with sentinel text and labels, an upload under a sentinel name, a rejected op and an oversized body, both exports, an import previewed, cancelled and committed, hostile archives, a restore, the asset sweep a month on, and "delete all data": no line holds a key outside `LOG_KEYS`, a sentinel, any id or the user id; book text, titles and references never logged), `apps/server/test/http.test.ts` (route templates, never the raw path).

## 8. Deleting data

- **Threat:** Residual data after the user deletes everything; deletion by mistake.
- **Mitigation:**
  - Settings → Data → "Delete all data", behind the word *delete* typed, removes every board, photo, book and backup: the user's directory is moved into `trash/` (both parents fsynced) and removed, and one empty board is left. A deletion cut short after the move is finished at the next start. The request needs a trusted `Origin` like every write.
  - The page then lets go of what it holds (section 10) and loads afresh on the empty board.
  - Note and thread deletion are undoable batches; an import replaces a board only after a safety backup and a confirmation. Photos no note shows any more are removed by the asset sweep, about daily, once 30 days old and in no retained backup.
- **Verification:** `apps/server/test/oneUser.test.ts` (the typed confirmation; the board, its photos and backups gone, one empty board left; a deletion cut short finished at the next start), `apps/server/test/import.test.ts` (a deletion and an import commit in either order end clean), `apps/web/test/settings/oneUser.test.tsx` (the word typed, then the page loads afresh), `e2e/app/data.spec.ts` ("Delete all data, typed, leaves one empty board and the app starts again"), `apps/server/test/assetSweep.test.ts`.

## 9. Encryption at rest

- **Threat:** Another person reading data from a lost or stolen disk or machine.
- **Mitigation:** Relies on FileVault, BitLocker or an encrypted Linux volume. App-level encryption is out of scope because it would hurt portability; this is documented.
- **Verification:** None by test: an operating-system setting, noted in user documentation.

## 10. Page storage

- **Threat:** Board content the page keeps outliving a "Delete all data", or read by injected script.
- **What the page keeps:**
  - No board content: no note or book text is written to the page's storage. Edits not yet sent are in memory only and go with the page.
  - `localStorage`: `papertie.board` (the id of the board last opened), `papertie.camera.<boardId>`, `papertie.screen.<boardId>` and `papertie.places.<boardId>` (the screen and the places left off at), `papertie.split`, `papertie.prefs`, `papertie.dropForms`, `papertie.ownRecovery.<boardId>` (a backup's file name). Ids, positions and choices only.
- **Mitigation:**
  - "Delete all data" ends in the store first, then the page lets go (`leaveDevice` in `apps/web/src/settings/leave.ts`): the screens and places remembered are forgotten, the session is stopped so it sends nothing more, and the page loads afresh on the empty board. What is left in `localStorage` names only boards that no longer exist.
  - Strict CSP (`script-src 'self'`) against injected script; the built app runs under it without a violation in every page and worker.
- **Verification:** `apps/web/test/settings/oneUser.test.tsx`, `apps/web/test/app/screenMemory.test.ts`, `e2e/app/data.spec.ts` and `e2e/app/journey.spec.ts` (after "Delete all data" the page opens on one empty board), `e2e/app/csp.spec.ts`.

## 11. Test and benchmark tooling

- **Threat:** A test or benchmark run changing data it was not made for, or leaving test data behind.
- **Mitigation:** The end-to-end suites and the desktop bench (`pnpm e2e:app`, `pnpm e2e:desktop`, `pnpm bench:desktop`) launch the app on a fresh temporary data folder of their own (`PAPERTIE_USER_DATA`, `e2e/desktop/helpers.ts`) and remove it afterwards. The canvas bench (`pnpm bench`, `e2e/bench/canvas.bench.ts`) runs the prototype page, with no store. None touches the user's data folder.
- **Verification:** None by test: by construction, run by hand.

## 12. The update check

Papertie makes one kind of request to the outside: it asks GitHub whether a newer release exists. Nothing else in the app connects to anything; the page itself still reaches only `papertie://app`.

- **What is sent:** one `GET https://api.github.com/repos/dm807cam/papertie/releases/latest` from the main process (Electron's `net.fetch`; `fetchLatest` in `apps/desktop/src/updates.ts`), unauthenticated, with no body, no cookies (`credentials: 'omit'`) and no query. Its headers are `Accept: application/vnd.github+json`, `User-Agent: Papertie/<version>` (the running app's version, and nothing of the machine), a fixed `Accept-Language: en` (so the system's language is not sent), and the network stack's own `Host`, `Connection`, `Accept-Encoding` and `Sec-Fetch-*`. No identifier, no board content, no telemetry. As with any request, GitHub sees the IP address it comes from and the time.
- **When:** a few seconds after the window is shown, and then at most once in 24 hours while the app stays open (`Updater.automatic`). Only in a packaged app on the person's own data: never in development, and never under the end-to-end tests (`PAPERTIE_USER_DATA`) unless a test names a stand-in with `PAPERTIE_UPDATE_URL`, which is accepted only as an `http` address on `127.0.0.1` or `localhost` (`testUrl`). **Papertie → Check for Updates…** (Help on Windows and Linux) asks once more, when chosen.
- **How to turn it off:** Settings → Preferences → "Check for updates automatically" → Off. The choice is kept by the main process in `<userData>/updates.json`, with the time of the last answer, the release it named and the version answered "Later". With it off, Papertie connects to nothing unless "Check for Updates…" is chosen.
- **Threat:** A forged or tampered answer (a hostile network, a compromised or renamed repository) making the app open an address of the attacker's, show the attacker's words, or run the attacker's code; the check being used to track the person; a hung request holding the app.
- **Mitigation:**
  - **Nothing is downloaded, installed or executed.** The packages are not code-signed, so the app only says that a newer version exists; "Download" opens the release page in the system browser, where the person downloads it themselves and can check it against `SHA256SUMS`.
  - **What is trusted from the answer is two fields, each checked** (`parseRelease`): `tag_name`, which must be a plain `major.minor.patch` version (a pre-release, or a release marked `draft` or `prerelease`, is never announced) and must be newer than the running one (`compareVersions`); and `html_url`, which must be an `https://github.com/dm807cam/papertie/releases/…` address exactly as written (`isReleaseUrl`: host, scheme, no port, no credentials, nothing the URL parser had to mend). Anything else is a failed check. The stand-in address of the tests relaxes the host asked, never this check.
  - **The page names no address.** It is told the version and the release page; "Download" sends no argument, and the main process opens the address it validated itself, once (`Updater.take`), checking it again. "Later" carries a version string, kept only if it is the version GitHub named. The page prints the version only when it is digits and dots.
  - **No redirect is followed** (`redirect: 'error'`), anything but a 200 is a failure (a rate limit's 403 or 429 too), the answer must be JSON under 1 MB, and the request ends after 10 seconds. An automatic check that fails says nothing; one asked for says "Couldn’t check for updates."
  - **Quitting never waits:** the request is aborted and the timers cleared at `before-quit`.
  - The CSP, the navigation lock and the session's permission handlers are as they were: the request is the main process's, not the page's.
- **Residual risk:** GitHub (or whoever can publish a release in that repository) can make every Papertie say that a newer version exists and point at a release page of that repository. That is the trust the download itself already rests on. A network that blocks the request only keeps the slip from showing.
- **Verification:** `apps/desktop/test/updates.test.ts` (version order; the answer's fields, a draft, a pre-release, a page on another host; the request's method and headers, non-200s, the timeout and the abort; the first launch asks, within 24 hours it does not, a dismissed version stays quiet and a newer one speaks, the setting off, the manual check), `apps/desktop/test/menu.test.ts`, `apps/web/test/app/updates.test.tsx` and `apps/web/test/settings/updateSetting.test.tsx`, `e2e/desktop/desktop.spec.ts` (against a stand-in on 127.0.0.1: the headers actually sent, the slip, "Later" across a relaunch, "Download" opening only the validated GitHub address, a release page elsewhere refused, the menu's answers, the switch, a quit during a request with no answer; every other spec launches with no check at all).

## Open items

- The `F_FULLFSYNC` behaviour on macOS is verified ([ADR-0001](../adr/0001-storage.md)); the equivalent durability on Windows and Linux (`FlushFileBuffers`, `fsync` on ext4/APFS-like volumes) rests on Node's `fsync` and is not measured.
- Release builds carry no publisher signature (the Mac app is signed ad hoc, with no Developer ID or notarisation; Windows and Linux builds are unsigned): the operating system warns on first launch, and an altered download would not be caught by a signature check.
