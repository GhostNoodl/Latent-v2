# Third-party components

The project license covers Latent's original code only. Dependency licenses and model/runtime terms remain independent.

The application uses Electron (including its Chromium/Node notices), React, lucide-react, zod, ws, adm-zip, pngjs, and sharp with native libvips components. Preserve their distributed license/notice files in packages. package-lock.json records the npm dependency tree. Resources include separate face-detailer and icon notices. A synthetic playback fixture is pinned by the packaging checks.

ComfyUI, Python, uv, PyTorch, optional workers/runtimes, and model weights are acquired separately from their listed upstream sources. Model catalog entries record provenance and source/license URLs; they do not transfer redistribution rights to this application.

Release blocker: complete the transitive and native notice inventory against the actual packaged artifact before public distribution. This document is an inventory guide, not a claim that the final notice audit is complete.
