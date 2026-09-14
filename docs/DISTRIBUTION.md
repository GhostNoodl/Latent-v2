# Distribution controls

Only files explicitly listed in public-source-manifest.json enter a public staging export. New source files require a reviewed manifest addition. The export has no inherited Git history, remotes, studio state, generated media, or private verification archive. Keep the original repository private; do not push its existing history.

Run `npm run public:check` to check allowlisted inputs. Run `npm run public:export -- .artifacts/public-source-NAME` in the private checkout to create a new export without overwriting an earlier one. In the export, install dependencies and run its tests and build. Run `npm run public:release-check` before any publication. It blocks an unapproved license. No command here uploads files.

Pattern checks are defense in depth, not certification that arbitrary credentials cannot exist. Human review of exactly the proposed source and release artifacts remains necessary. Credential findings report file/category only. The release workflow performs checks but does not publish or upload artifacts.

Historical tests bound to original GPU captures remain private; they must not be rewritten into synthetic evidence and presented as measured results. The public regression suite is explicitly smaller and independent of those captures. Future behavior coverage can migrate through new synthetic fixtures without importing private history.

Before release: finish onboarding and supported-hardware acceptance, validate a clean Windows setup, retain the chosen unsigned distribution policy, review third-party notices, inspect built artifacts and choose a version. Updating code must preserve user studios. The publisher chose unsigned distribution on 2026-09-12; paid signing is not a release requirement.

## Guided setup preview

Setup is available from the sidebar and opens automatically when the private engine is not installed. It offers engine setup, an optional Illustrious starter checkpoint, Qwen Base editing, and fused H3 video. Existing files are passed through each service's verification/reuse logic. Video acquisition still follows its existing availability rules.

Guided setup currently targets Windows x64 with a single identifiable NVIDIA RTX GPU, driver 580.88+, at least 8 GB GPU memory / 16 GB RAM for images and 16 GB GPU memory / 32 GB RAM for Qwen/video. These are conservative setup admission rules, not performance or full hardware compatibility guarantees. Existing advanced configuration remains available. NVIDIA documents driver requirements at https://nvidia.github.io/cuda-python/cuda-bindings/13.0.1/install.html . Setup installs private GPU libraries; users do not need the CUDA development toolkit.

Disk checks include a 15 GiB engine planning allowance or 2 GiB headroom per asset destination. Sizes of additional runtime packages and extraction may vary; asset estimates are minimum remaining downloads, not a guarantee of exact final installation size. Setup rechecks before acquisition. Runtime archive retries currently reuse complete verified files but restart incomplete archives; per-file model downloads retain their existing resume support.

The first-run shell is shared by the portable app and the per-user Windows installer. The installer supplies Electron and the desktop dependencies; guided setup then installs the private engine after hardware/storage review. Clean-VM installation, first launch, same-version reinstall and uninstall preservation passed on the 0.1.0 installer. Optional tools remain in their dedicated tabs; supported-hardware generation is a separate acceptance check. No credentials are required for the local image engine; optional service keys remain in their dedicated settings.


## Windows installer and notices

Run `npm run package:installer -- --output NEW-RELEASE-FOLDER` for the unsigned x64 NSIS setup executable. `npm run package -- --output NEW-RELEASE-FOLDER` continues to build the portable executable. Each command builds once into a new output folder. The setup is per-user, requires no elevation, adds Start/Desktop shortcuts, and opens the app after an interactive installation. A silent installation does not open the app. Uninstall preserves studio data; no custom uninstall deletion script is supplied. Close Latent before updating it.

Node.js, Python, Git and the CUDA development toolkit are not prerequisites for launching the packaged desktop shell. The NVIDIA driver remains a user-managed prerequisite. Internet access and adequate space are needed for guided engine/model downloads. The installer itself does not bundle model weights or the separately downloaded runtime.

`npm run notices` regenerates THIRD-PARTY-NOTICES.txt from the locked, installed Windows production dependencies, including bundled renderer libraries. `npm run notices:check` and packaging reject stale notices. Install LICENSE, THIRD-PARTY-NOTICES.txt and README-WINDOWS.txt alongside the executable. Electron's LICENSE.electron.txt and LICENSES.chromium.html are retained and checked byte-for-byte. Sharp's installed native-library inventory and upstream notices are included, along with LGPLv3/GPLv3 text from SPDX license-list-data v3.27.0. Native libraries remain unpacked and replaceable. The app Help page explains where notices are located.

Publish the checksum-verified native-source companion described in NATIVE-SOURCES.md alongside the Windows binary. The clean-VM 0.1.0 install, same-version reinstall, uninstall and studio-file preservation tests passed. Different-version upgrade and a fresh installation of the final 0.1.1 build remain distinct from those results; do not present a static payload check as live installer execution.

References: https://www.electron.build/nsis/ ; https://github.com/lovell/sharp-libvips ; https://github.com/spdx/license-list-data/tree/v3.27.0/text .
