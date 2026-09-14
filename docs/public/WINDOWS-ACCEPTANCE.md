# Windows installer acceptance

Run this in a disposable Windows account or VM, not an existing studio. The test requires only built-in Windows PowerShell; it does not need Node or Python. It changes per-user installed-program registration and shortcuts, then uninstalls the app. It preserves a tiny studio sentinel for inspection. Do not run it with administrator privileges or against your normal account.

Copy the reviewed Setup EXE, its SHA256SUMS.txt, and scripts/test-windows-installer.ps1 to the test machine. Read the installer hash from SHA256SUMS.txt. First run the plan (no installation):

```powershell
.\test-windows-installer.ps1 -Installer .\Latent-v2-0.1.0-Setup-x64-unsigned.exe -ExpectedSha256 '<hash from SHA256SUMS.txt>'
```

If the plan reports ready, repeat with `-Run`. The script refuses existing studios, Latent registrations (including machine-wide installs), running Latent processes, existing shortcuts, earlier test folders or a LATENT_DATA_ROOT override. It checks the installer hash before any installation. On a clean account it:

1. Installs silently into a dedicated test directory and checks executable and notice files.
2. Writes a tiny studio sentinel and reinstalls the same version.
3. Checks that the sentinel survived, runs the owned uninstaller, and verifies app/shortcut/registration removal and studio preservation.
4. Saves a result under %LOCALAPPDATA%\LatentInstallerAcceptance\result.json. On failure it stops and retains evidence rather than deleting unknown state.

This script has been parsed and its read-only refusal path checked on the development account. Its installation path has not yet run on a clean account/VM. A passing receipt proves same-version reinstall, not a different-version upgrade. For actual upgrade acceptance, retain the previous reviewed installer and repeat the preservation test with a newly versioned installer.

## Interactive acceptance

Acceptance update (2026-09-13): the reviewed 0.1.0 unsigned installer was installed interactively in a fresh Hyper-V Windows VM. First-run setup was visually observed and reopening was confirmed by the tester. A separate existing-install test then passed same-version reinstall, uninstall, and preservation of every baseline studio file. Its guest JSON receipt was visually inspected; see `docs/verification/windows-vm-20260913/REPORT.md` for the evidence and limits. This does not change the unexecuted status of the original clean-account script above or establish different-version upgrade or GPU acceptance.

On a fresh VM snapshot, install interactively and confirm Start/Desktop shortcuts and automatic first launch. Confirm first-run Setup appears without system Node, Python or Git. In a VM without a supported GPU, verify that setup explains hardware requirements; do not treat that as a GPU test. Check choosing storage, closing/reopening the app and locating licenses in Help. Use the supported physical GPU system for engine/model setup and one generation smoke test when final application code is frozen.

## Signing decision

The publisher chose unsigned distribution on 2026-09-12. Paid signing and certificate provisioning are outside the release scope. The current build explicitly disables signing. Test and describe Windows security prompts honestly; do not disable Windows protections to make acceptance pass. No signing credentials are needed or included in source exports.
