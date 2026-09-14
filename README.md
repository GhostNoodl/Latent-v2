# Latent v2

A Windows desktop studio with a separately managed ComfyUI runtime for SDXL/Illustrious images, image editing and video workflows.

## Release candidate

Version 0.1.1 includes guided first-run setup and an unsigned per-user Windows installer. The 0.1.0 installer passed clean-VM installation, reopening, same-version reinstall, uninstall and studio-file preservation. Version 0.1.1 fixes setup-result visibility; final artifact checks are recorded separately from live installer execution. Do not redistribute private studio files or local development evidence.

## Build from source

Use Windows x64 and Node 24.15+ in the Node 24 line, or Node 26+. Run `npm ci`, `npm run public:check`, `npm test`, then `npm run build`. `npm start` launches the desktop app. `npm run package -- --output my-build` creates an unsigned portable package. End users do not need Node in a packaged build. If your npm policy disables dependency install scripts and packaging reports a missing Electron distribution, run `node node_modules/electron/install.js` to install the locked Electron build before packaging; do not change global script policies.

Your studio is stored under the current user's local application data. Models, prompts, images, logs, keys and the database are private user data. Do not include a locally generated studio pointer with public downloads.

## Test coverage

This export includes an explicit, self-contained regression suite. Historical GPU receipts, screenshots, development scripts and tests requiring those private captures remain in the private development repository. Included tests use temporary generated fixtures and do not establish live-service, GPU or fresh-machine compatibility.

## Network and optional features

Runtime and model setup download components from their publishers. Civitai browsing and metadata use Civitai; enabling automatic metadata lookup sends model checksums. Generated work stays in the local studio unless you explicitly export it. Optional dependencies/model permissions are separate from the application source license.

See [distribution controls](docs/DISTRIBUTION.md) and [third-party components](THIRD_PARTY.md).

## License

Latent v2 original code is licensed under the [MIT License](LICENSE). Third-party components and separately downloaded runtimes and models retain their own licenses.
