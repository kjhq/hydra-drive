# Waypoint saves

This fork replaces PC snapshot, legacy Ludusavi backup, and supported emulator save storage with Google Drive. Save operations do not require a Hydra login or subscription. Catalogue, downloads, achievements, and other Hydra services remain separate.

## Build configuration

Use Node and Yarn versions supported by the upstream project, install its native build prerequisites, then run `yarn --frozen-lockfile`. Copy `.env.example` to `.env` and fill in the existing service settings plus:

- `MAIN_VITE_GOOGLE_CLIENT_ID`: a maintainer-owned Google **Desktop app** OAuth client.
- `MAIN_VITE_GOOGLE_CLIENT_SECRET`: the desktop client configuration value, if issued. Desktop applications cannot keep a client secret confidential; this is distributed application configuration, never an end-user token.
- `MAIN_VITE_RELEASE_OWNER` and `MAIN_VITE_RELEASE_REPO`: optional fork GitHub release repository. Both must be set to enable updates. Official Hydra's repository is rejected. Leave both empty to disable updates.

Pass the release variables as environment variables to the packaging command as well as the Vite build. `electron-builder.cjs` generates matching update metadata. Packaging scripts use `--publish never`; publishing a release remains an explicit maintainer operation. Existing CI build workflows accept the same repository variables. Upstream landing-page and AUR publishing jobs are disabled on forks.

Run `yarn typecheck`, `yarn test`, `yarn test:native-saves`, and `yarn build`. Build Windows and Linux packages on their respective platforms with `yarn build:win` and `yarn build:linux`. The upstream native addon requires its pinned libtorrent bridge; `yarn build:native` builds it before Rust linking.

The default product is **Waypoint**, application ID `community.hydradrive.launcher`, protocol `hydradrive://`, executable `HydraDrive` on Windows, package name `hydra-drive`, and a separate `Hydra Drive` user-data directory (retained for development-profile compatibility). For custom branding, change these values consistently in `package.json`, `electron-builder.yml`, `src/main/index.ts`, `src/main/services/system-path.ts`, generated shortcuts/protocol handlers, and the NSIS updater-cache name. Keep a distinct application identity. Other Hydra account integrations may need the maintainer to arrange acceptance of the new callback protocol by their upstream services.

## Google project and public release

Enable the Drive API in a maintainer-owned project. Configure production OAuth consent, support contact, authorized public website, privacy policy, and applicable Google verification. Request only `openid`, `email`, `profile`, and `https://www.googleapis.com/auth/drive.file`. Do not instruct end users to create Google projects.

OAuth uses the system browser, a random `127.0.0.1` loopback port, PKCE, and a validated state nonce. Tokens stay in Electron's main process. Persistent credentials use Electron `safeStorage`; Linux plaintext or unavailable keyrings prompt for a session-only connection. Disconnect cancels pending work and removes credentials without deleting remote backups or the account's queued files. Reconnecting the same account can resume those files.

Production requirements: <https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance>

Drive scope reference: <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>

A public privacy policy must describe Google identity data, save contents and file/path metadata, device name, storage in the user's Drive and local queue, token handling, disconnect/revocation, manual deletion and retention, support/deletion requests, and the other unchanged Hydra services. Supply real maintainer identity, URLs and contact details before distributing. No policy or verification approval is implied by this implementation.

## First use

1. Start with saves already on your device. If a save exists only in Hydra Cloud, restore it using official Hydra first.
2. Add your games to Waypoint, then connect Google Drive in **Settings → Cloud saves**.
3. Open a game's save settings to check its detected save folders or choose a custom folder, then create your first backup.
4. Enable automatic sync individually for supported games. Manual-only save formats remain manual.

Google accounts have separate queues, anchors, custom bindings and accepted save bases. After switching accounts, choose any custom save folders for that account. Do not run two launchers against the same game saves at once.

## Storage and recovery

`Waypoint Saves` is a visible app-created folder. Drive IDs and app properties identify records; renaming the folder does not break storage. Listing discovers tagged records across duplicate app-created roots rather than moving user data between folders.

Each snapshot has an independent compressed payload and a versioned JSON commit. The payload is uploaded and checksum-verified before its commit is published. Persisted operation journals contain account ID, allocated file IDs, immutable parent IDs and resumable-upload URLs. Queued source bytes are removed only after both the commit and remote payload are verified. Pagination and bounded transport retries handle larger accounts.

Commit metadata records parent snapshot IDs, save identity, device/time, archive hash, and PC path/file metadata or emulator format metadata. Metadata is kept for ancestry. Retention trashes old payloads beyond ten snapshots per identity while protecting every unresolved head and explicitly pinned backups. Rename annotations do not rewrite snapshot contents. Deleting a current cloud head creates an ancestry-aware tombstone; deleting a cloud backup never deletes local saves.

A divergent save creates another branch. PC launch sync restores only when local content still matches the accepted base; conflicts require an explicit choice, and local progress is preserved before replacement. Legacy/emulator manual restores also preserve the previous version and confirm the selected device/time. Restoring history stages the selected payload before creating a preservation snapshot so retention cannot remove it mid-operation.

If Drive cannot be checked, opted-in PC launch sync offers **Play offline**. Exit capture creates a durable local queued snapshot; reconnect/retry publishes the frozen parent relationship, preserving concurrent branches. Failed legacy/emulator uploads are also queued after staging. Queued operations from one Google account never run under another account.

Restores validate archive entries, hashes, path mappings, and symlink boundaries before replacing live files. Journaled replacement preserves rollback bytes, removes obsolete tracked files, and recovers interrupted restores before analysis/launch. Recovery and transactions share a per-game lock. Emulator conversions run against temporary copies, with a process check and a launcher lock before installation. Wii `data.bin` retains its existing manual-import workflow.

An exported Drive snapshot is a `.tar.gz` containing `commit.json` and `payload.tar.gz`; the manifest supplies original path mapping. The existing legacy export UI retains its format conversion/export behavior. Automated import of exported Drive bundles is not part of this release.

## Qualification required before release

The code and unit tests do not replace real account/device testing. Before declaring a public release qualified, record evidence for:

- Windows and Linux/Steam Deck packaged launch, keyring behavior, system-browser OAuth, cancellation, revocation, restart and account switches during uploads/downloads.
- Two devices using the same account: initial sync, handoff, simultaneous offline edits, equal timestamps, conflict selection, interrupted restore, tombstones, retention and queued restart recovery.
- Two separate accounts: isolation of credentials, bindings, queued uploads, history and anchors.
- Real Drive interrupted/resumed uploads, lost acknowledgments, pagination, duplicate roots, quota/rate limits, missing/tampered payloads and folder rename.
- PC Windows/Linux/Wine paths, legacy Ludusavi mapping, PS1/PS2 card imports, PPSSPP, Dolphin GCI and Wii manual export, disk exhaustion and rollback.
- Desktop and controller-operated Big Picture connection, history, labels, delete, export, conflict selection and offline launch.
- Network inspection confirming zero Hydra save API requests, no Hydra authentication requirement for backup/restore, and no official Hydra update feed.

The manual **Drive save validation** GitHub Actions workflow builds unpacked Windows/Linux artifacts and runs automated checks. Running that workflow does not perform the live-account or controller smoke tests above.

The release gate remains closed until live Google testing and packaged Windows/Linux smoke tests succeed. Keep current local saves backed up while qualifying a development build.
