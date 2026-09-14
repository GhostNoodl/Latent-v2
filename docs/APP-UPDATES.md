# Optional desktop app updates

Settings > App updates provides manual checking, downloading and installation. Automatic checking, automatic downloading, and closing/installing when work finishes are all off by default. Automatic downloading depends on automatic checking; automatic installation depends on automatic downloading. Checks run at most daily within an app session, with a fresh opportunity after restart. Manual checking is always available.

Only the installed Windows x64 edition can install updates in place. Development and portable copies are never replaced by this mechanism. The installed-edition check requires a packaged Windows x64 executable, no portable executable marker, and the application's adjacent uninstaller.

## Download contract

The update source is the public [GhostNoodl/Latent-v2 release feed](https://api.github.com/repos/GhostNoodl/Latent-v2/releases/latest). Only a newer stable version with the exact `Latent-v2-VERSION-Setup-x64-unsigned.exe` asset is accepted. The installer must include a SHA-256 digest in [GitHub release asset metadata](https://docs.github.com/en/rest/releases/assets). Missing, private, unpublished or rate-limited feeds produce an error rather than a false up-to-date result. No credentials, prompts, model inventory or studio paths are sent.

Downloads are bounded by advertised size, capped at 1 GiB, cancellable and checked against their digest. Redirects stay on an explicit GitHub release-host allowlist. Metadata is limited to 2 MiB. The private studio cache uses exclusive file creation and rejects linked files. Unchanged verified downloads can be reused; changed regular cached installers are preserved under an invalid suffix before a replacement is downloaded. Partial files created by failed transfers are removed. Space checks include both the temporary and final installer copies.

## Installation and user data

Save, close and install requests installation after pending operations, jobs, video saving, automatic face follow-ups, model transfers and studio tools finish. Shared-engine work also blocks installation. New generation/mutation work is blocked once update shutdown starts, while draft and editor saving can complete. If editor flushing fails, installation is postponed and the app stays open; update shutdown does not offer to discard those edits. The checksum is checked again before shutdown proceeds. The installer is launched only after service shutdown and pending writes complete successfully.

Postpone installation prevents another automatic request for that version in the current session. A manual installation request or explicitly enabling automatic installation again can resume it. After restart, saved automatic preferences apply again.

The existing per-user NSIS configuration, application ID and user-data locations are unchanged. Updates do not migrate, remove or bundle user models and studio data. This remains unsigned distribution; the updater does not claim publisher code signing. Portable users continue replacing the portable application manually.

## Validation and remaining release proof

Automated tests use small inert files and mocked release responses; no fixture is executed. Coverage includes stable version ordering, installer identity, missing feeds, redirected hosts, checksum/size failures, corrupted-cache recovery, cancellation, opt-in defaults, revoking preferences during checking, postponement, and development/portable protection. The renderer settings were exercised headlessly.

Before release, install the public 0.1.1 app in the clean Windows VM and create sample preferences/history. Manually install the final candidate over it, then verify version, shortcuts, preserved data/models and later startup. Public 0.1.1 has no desktop updater, so its first upgrade cannot start from the new settings controls.

Separately exercise the new updater in the candidate against a controlled newer-version release fixture, including check/download/defer/flush/installer handoff/relaunch. Test unsaved wildcard/editor changes, running generation/shared-engine work, cancellation and a restart with the download cached. Full live automatic-upgrade certification requires a newer published compatible installer. Retain the final installer and matching source evidence.

The anonymous live latest-release endpoint returned HTTP 404 during this implementation session. Its published availability, an actual installer transfer and an actual Windows upgrade are not claimed by the automated results.
