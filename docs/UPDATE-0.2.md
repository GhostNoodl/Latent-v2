# Latent v2 0.2.0 work plan

Status: 0.2.0 candidate preparation on `codex/0.2.0-update`. No 0.2.0 release has been published. Actual Windows upgrade acceptance remains outstanding. Further Qwen speed tuning is deferred by request.

## First completed batch

- [x] #2 Move setup access into Settings; retain automatic first-run setup.
- [x] #5 Move size presets above models, add three defaults, and support saving/editing/removing named presets (1–16 entries).
- [x] #11 Show percentages for downloads with known totals; use indeterminate progress during verification or unknown totals.
- [x] #13 Add Sky, Amber, Peach, Mint and Lilac accents, with dark/light variants.
- [x] #15 Dismiss queue and notifications on outside clicks or Escape, preserving toggle behavior and mutual exclusion.
- [x] #17 Show artwork and display names on selected Create LoRA cards.
- [x] #18–19 Use Positive prompt / Negative prompt labels and equal-sized boxes.
- [x] #21 Hide routine draft-saving status; keep automatic persistence and visible failure/retry feedback.
- [x] #22 Move upscale and hires controls below models, before fine-tuning.
- [x] #24 Link selected hires scales to base-size edits. Manual dimensions and older saved recipes remain fixed until deliberately edited; existing output limits still apply.
- [x] #26 Add a preview context menu and an Image actions button, with copy image, open, show in folder and reuse parameters.
- [x] #8 Consistent dialog, activity-panel, menu and toast entrances, navigation feedback and control/card transitions, honoring reduced motion.

## Remaining batches

- [x] #1 Unified setup progress with the current component, known byte counts and installation/verification messages. Dependency installation uses clearly labeled stage estimates.
- [x] #3 Original Moonstone application icon, reviewed at small sizes and wired into Windows packaging, studio branding and favicon. Native shortcut/taskbar appearance will be checked with the final installer.
- [x] #4 Confirmed Recycle Bin removal for studio-owned models, with in-use checks, refreshed selectors and hidden deliberately removed entries. External folders stay read-only.
- [x] #6 Optional Compact Qwen editing with GGUF Q4_K_S and Lightning, including a matched real RTX 4060 Ti 16 GB memory/speed/quality check.
- [~] #7 Optional app-update controls, verified downloads and deferred installation implemented. A live published installer and real Windows upgrade/data-preservation test remain required.
- [x] #9 Expanded base-model discovery choices (including an exact custom label), workflow compatibility badges, and an explicitly loaded-results compatibility filter. Searching does not broaden download/generation support.
- [x] #10 Clean display names, new Civitai download/import filenames and existing files through Details / manage file. Saved references survive renames; occupied names cannot be overwritten. Civitai collisions get a short checksum suffix.
- [x] #12 Version-specific creator galleries with thumbnail selection, previous/next controls, larger view, failure retry and empty states. Up to 24 unique image previews are retained per version, regardless of rating.
- [x] #14 Stop/restart an idle managed engine around model changes. Busy queues/downloads request a retry after work finishes; no active job is interrupted or silently cancelled. Live idle-engine restart after Recycle Bin removal passed; a Windows ownership race found during that check was fixed.
- [x] #16/16B Optional per-LoRA trigger choices insert literal text into new visible-mode prompts. Owned spans support removal, shared words and user edits. Older recipes retain their original resolver until explicitly converted.
- [x] #20 Thirteen optional, editable starter wildcard packs (817 choices), with source references, bundled alias/duplicate cleanup and collision-safe staging.
- [x] #23 Enhance saved generations through a reviewed Create draft and one latent diffusion refinement pass, saving a linked result and preserving the original. A real 768-to-1152-pixel Enhance run passed, with composition retained and a more painterly result; quality remains image-dependent.
- [x] #25 Optional automatic face refinement after generation/hires, with separate cancellable follow-up jobs, restart recovery and preserved originals. A real anime face pass completed. The tested anthro fox was not detected and was safely skipped; reliable furry-face detection is not established.

## Qwen integration findings

Base and Fast retain their native INT8 recipes. Compact adds a separate Q4_K_S GGUF route with Lightning, the shared CPU text encoder/VAE and a pinned optional loader. Its diffusion file is 12.4 GB instead of 20.5 GB. A matched recoloring edit completed on the RTX 4060 Ti 16 GB: Fast took 57.2 seconds and Compact took 83.4 seconds. Both retained the scene and recolored the teapot. Compact had a lower sampled whole-device GPU peak (14,611 versus 15,293 MiB) and more available host RAM. It is a smaller-memory option; Fast was quicker in this test. See QWEN-COMPACT.md for scope and limitations.

## Validation of the first batch

216 automated tests passed, along with the public-source boundary checks, type checking and a development compilation. The actual development app was exercised headlessly using isolated test data at 1440×950 and 1024×768. Checks covered prompt geometry, saved custom presets, linked hires dimensions, panel dismissal, Settings setup access and accent persistence. Screenshots were visually inspected.

Preview actions were tested against a saved development fixture through the actual IPC and native PNG encoding. The final clipboard writer was intercepted to preserve the user's clipboard; this does not claim a native clipboard paste test. These checks did not generate a new GPU image or create/install a release package.

Before release: finish remaining features, run targeted hardware checks, validate a real 0.1.1-to-0.2.0 upgrade and user-data preservation, then assemble the final installer and matching public/native sources.

## Second batch: setup and model files

Setup now shows the active component, an overall progress bar and known download byte counts. Engine installation percentages are explicitly estimates; unknown download totals remain indeterminate. Runtime archive transfers expose their filenames and verification phase. Dependency-manager package downloads still use stage messages rather than fabricated per-package byte counts.

The Models page and model context dialog offer filename cleanup and confirmed Recycle Bin removal. Stable model IDs, original aliases and historical recipes remain intact. Deliberately deleted entries disappear; files restored from the Recycle Bin become visible again. Failed recycle operations restore the registry. External model roots remain read-only.

Validation: 227 automated tests passed across 23 files, plus both public-source boundary tests. TypeScript and the development build passed; the public source allowlist/privacy check passed. Tests used tiny isolated safetensors fixtures, including rename identity, collisions, modified files, recycling failures/restoration, confirmation UI, unknown progress, and engine lifecycle sequencing. No user model files or actual Recycle Bin contents were touched. Real Windows recycling, a live engine restart and a fresh dependency installation remain end-of-update checks. No installer was assembled or release published.

## Third batch: Discover

Discover supports additional exact base-model searches, with suggestions for Pony, NoobAI, SD variants and Flux, and custom labels. Existing resource, creator, tag, period and sort options remain. Search cards distinguish supported, mixed-version and unsupported workflows; the optional compatibility filter clearly applies to loaded results and preserves Load more. Selecting a result prefers the version matching the searched base. Discovery never changes acquisition or generation compatibility.

Model details show the selected version's creator images, with thumbnails, keyboard/previous/next navigation, a larger-view dialog, and recoverable failed-image states. New version/fetch identities reset the gallery. Image ratings are not filtered. Existing URL validation and response/cache bounds remain in effect; up to 24 unique image previews are retained per version. Galleries use images returned by model metadata, not an unbounded fetch of every community post.

Headless verification used the real renderer components with synthetic metadata/images at 1440 and 900 pixels: gallery navigation, larger view, version reset, base query wiring, compatibility filtering and horizontal overflow checks passed with no page errors. Screenshots were visually inspected. Anonymous live API requests for Pony, NoobAI and Flux.1 D returned HTTP 200 and matching bases. No accounts, model downloads or GPU generation were needed. Public-source checks and the development compilation remain separate from final packaged-app validation.

Validation: all 233 automated tests passed across 24 files, along with both public-boundary tests, TypeScript/development compilation and the 271-file public-source check. No installer was assembled or release published.

## Fourth batch: visible LoRA triggers

New drafts use visible trigger choices. Each LoRA offers individual checkboxes, Select all and Select none; nothing is selected implicitly. The existing global switch enables/disables selected additions. Generation uses the visible authored text (resolved normally when variations are enabled), without a hidden second trigger prefix. Selected trigger metadata is pinned into the saved job.

Inserted text has bounded, persisted ownership spans. Removing a LoRA or deselecting a word removes unchanged owned text only; shared words stay while another selected LoRA uses them. Preexisting manual text is never claimed. Edits affecting an insertion release it to the user, including adjective prefixes and word suffixes; ambiguous edits conservatively preserve text. Literal variation syntax is escaped when needed, and capacity failures produce an actionable message. Ownership text is cleared when positive-prompt memory is disabled.

Unversioned and punctuation-version historical recipes preserve their original generation behavior. Adding the first LoRA to a previously empty selection adopts visible choices; existing legacy LoRA recipes offer an explicit conversion button. Conversion preserves existing additions as user-owned prompt text and leaves a previous-draft undo available.

Validation: 249 automated tests across 26 files (including selection/removal UI, shared ownership, user edits, variation escaping, capacity, persistence and legacy replay), TypeScript/development compilation, and public-source boundary checks. A headless renderer fixture at 1000 pixels exercised the actual trigger controls and ownership helper; selection visibly updated the prompt, edited text survived removal, and no page errors occurred. Its screenshot was inspected. This does not claim a packaged-app or GPU generation test. No installer was built or release published.

## Fifth batch: Enhance saved images

The Create preview toolbar and right-click menu offer Enhance image. A compact dialog selects size and refinement strength, then prepares an editable Create draft before generation. Saved checkpoint and LoRA identities are retained when available; outputs without a saved checkpoint use the current Create selection, as disclosed in the dialog. The resolved original prompt stays literal rather than rerolling variations or adding hidden triggers. Undo restores the previous draft.

Enhance encodes the saved source pixels, scales the latent representation and performs one sampling pass into one new output. The original is preserved, the new history entry is labeled Enhanced, and its details link back to the original. Immutable source identity is checked before queueing. Conflicting modifiers are rejected rather than silently producing multiple passes. Current source and target dimensions are limited to 2048 pixels per side; same-size refinement is available.

Validation: 255 automated tests passed across 28 files, including graph structure, source identity, linked draft preparation, dimensions and recoverable dialog failures. Type checking, development compilation, the 279-file public-source check and both boundary tests passed. This does not establish GPU output quality or packaged-app behavior. No installer was assembled or release published. Automatic face refinement is a separate remaining batch.

## Sixth batch: automatic face refinement

Create now has an opt-in Automatically refine faces control, with illustration/photographic profiles and adjustable strength. The detector must be installed through Settings. Completed generations receive separate face-refinement jobs, after final hires output is retained; batch images are handled individually. The child uses the saved resolved prompt, model identities and seed, without rerolling prompt variations, repeating hires or recursively refining itself.

No detections and preparation failures retain the original and show a concise queue outcome. Child jobs use normal cancel/retry controls. Parent receipts and durable child lineage prevent duplicate automatic queueing after restart, including cancelled children. Busy detection waits; shutdown cancels the owned detection and leaves unfinished preparation recoverable. Finished parent bookkeeping avoids rescanning its records on every queue tick. Removed output records are not recreated.

Validation: the full 264-test suite, development build, public-source check and both boundary tests passed. A subsequent removed-output regression brings the suite to 265 tests; all 10 targeted automatic-face tests and type checking passed after final refinements. A headless renderer fixture exercised opt-in, profile selection, strength changes and overflow checks, with no page errors; its screenshot was inspected. These are automated orchestration and UI results, not live detector accuracy, GPU quality or packaged-app proof. Real stylized/furry-face validation remains outstanding. No model downloads, installer build or publication was performed.

## Seventh batch: starter wildcard packs

Wildcards now offers five previewable starter lists: species, locations, background styles, clothing and poses. The 106 choices were selected from public e621/Danbooru tag references. Bundled normalization removes duplicate spellings and applies the verified bunny-to-rabbit alias. Source references, the review date and selection boundaries are documented in [WILDCARD-PACKS.md](WILDCARD-PACKS.md).

Adding a pack stages an editable copy and collapses its catalog to reveal the editor. Save remains explicit; unsaved additions use the existing close/discard protection. Occupied names receive a suffix. Re-adding an unchanged copy selects it, while edited copies, manually weighted lists and frozen generation recipes remain intact. The update does not automatically add lists, alter prompts or enable variations. Runtime use is fully offline.

Validation: five focused tests cover catalog validity and actual prompt expansion, normalization, collisions, repeat imports, snapshot independence and the real editor's save/discard boundary. Type checking, development compilation and the 288-file public-source check passed. A headless renderer fixture exercised category preview, adding/selecting a pack, automatic catalog collapse and explicit save without overflow or page errors; the final screenshot was inspected. No GPU generation or installer build was needed for this batch.

## Expanded wildcard catalog

Expanded the five original categories and added lighting, time/sky, expressions, gestures, hair colors, headwear, accessories and framing: 817 choices in 13 packs. Category/choice search and bounded scrolling previews keep the larger catalog usable. Public e621 species and Danbooru group references were fetched to verify the selected vocabulary; source links and counts are updated in WILDCARD-PACKS.md.

Existing and edited starter copies are preserved when adding expanded versions. All packs fit within the unchanged 1,024-choice dictionary limit; staging now rejects additions that would exceed it, showing an error without changing the editor's lists.

Validation: seven focused wildcard tests passed, including full-catalog expansion/validation, budget overflow, old-copy preservation and explicit editor saving. Type checking and development compilation passed. A headless renderer check covered searching by a species name, no-match recovery, restoring all 13 categories, preview scrolling, adding and saving; no page errors or horizontal overflow occurred, and the screenshot was inspected. No GPU run or installer was needed.

## Eighth batch: optional desktop updates

Settings now separates desktop app updates from generation-runtime updates. Manual check/download/install actions are available, with opt-in automatic checks, downloads and installation after work finishes. Published stable releases must match the expected Windows installer identity and GitHub SHA-256 digest. Cancellation, progress, cache reuse, corruption recovery and missing/rate-limited feeds have explicit outcomes.

Installation is restricted to the installed Windows edition, waits for studio/shared-engine work, uses the existing editor flush, and starts only after successful shutdown. Flush failures preserve open edits and postpone installation. Development and portable executables are protected. No actual installer was downloaded or executed during implementation.

Validation: all 283 tests across 34 files passed, plus both public-boundary tests and development compilation. The 11 focused update tests and type checking passed again after the final exclusive-copy storage adjustment. Headless controls exercised opt-in preferences, installation request and postponement with no page errors; the screenshot was inspected. The anonymous release endpoint returned 404, so live release availability and the real 0.1.1 upgrade remain unverified. See APP-UPDATES.md for the final VM acceptance steps.

## Ninth batch: original icon and motion polish

Original MIT vector artwork replaces the stock Orbit brand: a curved L and emerging spark on a lavender Moonstone tile. The header, boot screen, favicon and nine Windows ICO sizes share the same artwork. Generic Lucide UI icons retain their existing attribution.

Dialogs use a short fade/settle entrance, activity panels and menus share a brief slide/fade, and navigation and controls have consistent feedback. Dismissal stays immediate. Motion respects the operating-system reduced-motion preference; workspace/canvas containers are not transformed.

Validation: reviewed 16 through 256 pixel icon previews on dark/light surfaces; headless checks passed normal/reduced motion, dialog initial focus, Escape and restored focus, backdrop dismissal and overflow, with no page errors. Type checking and development compilation passed. Windows icon generation validates all nine transparent frames. Actual installed icon/shortcut appearance remains part of final packaging acceptance. Qwen is the remaining feature batch and is intentionally last. No installer was assembled or release published.

## Tenth batch: Compact Qwen

The editor, stored recipes, job validation, setup and storage inventory recognize Compact independently from Base/Fast. Setup installs pinned loader code and an exact GGUF wheel under idle-engine maintenance. Repair retains changed loader code; conflicting dependency versions are preserved. Engine-update checks require the optional loader when installed. The older engine generation is not advertised as supporting this new route.

Validation: the 289-test regression suite passed before final repair/capability additions, followed by nine focused Compact tests and five setup tests. Headless editor checks covered selection, setup dispatch, readiness and persistence without page errors or overflow. The loader and verified model bundle were installed in an isolated studio. Two real GPU edits used the same synthetic source, instruction, seed and canvas in separate engine processes; both outputs were inspected. The harness needed an additional shutdown wait between runs; only Compact was restarted, preserving the Fast measurement. All test engines were stopped afterward.

No installer was assembled or release published. Previously deferred hardware/upgrade acceptance and final release packaging remain.

## Candidate acceptance pass

The actual development app ran headlessly against an isolated studio on the RTX 4060 Ti 16 GB. Existing checkpoint files were registered read-only; the user's installed app and studio were not changed. An anime portrait passed through the real queue, CPU detector, automatic child job and saved history. The original stayed intact, and the face edit was visibly softer rather than universally better. A second anthro fox portrait produced no detection: the queue reported that the original was kept, without a spurious refinement job. The current detector should not be advertised as reliable for furry faces.

Enhance processed the saved 768-square portrait into a linked 1152-square output through one latent refinement pass. The original file hash stayed unchanged. Composition and recognizable facial features remained, with a more painterly texture. The latest generated image became the saved preview selection. All app windows stayed hidden and renderer checks recorded no page errors.

Real Windows Recycle Bin removal used only tiny disposable test model files. The first run exposed a restart race: object existence was mistaken for mutex ownership after the engine was terminated. Backend startup and private-Python preparation now acquire the Windows mutex with a bounded wait; a retained unowned object or abandoned owner is recoverable, while a live owner is still rejected. Native-process checks passed for all three cases, and the actual app then removed the fixture, refreshed its library and restarted the engine successfully. No existing user model was removed.

The full 292-test suite passed before the mutex fix; 21 focused runtime and model-maintenance tests and a production compilation passed afterward. Separate native Windows checks exercised both the configuration helper and launcher against unowned, abandoned and live-owner mutexes. All owned GPU test processes were stopped. See [Microsoft's mutex documentation](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexw) for the distinction between named-object existence and ownership.

Remaining release proof: packaged candidate startup/icon checks, actual 0.1.1-to-0.2.0 upgrade with preserved studio data, and the new updater's real installer handoff. Hyper-V was unavailable through the host management interface during this pass. Source/native payload assembly and an installer do not substitute for that VM test. Qwen optimization is deferred.

## Candidate follow-up: exit Enhance

A reported draft retained Enhance after its source was removed. Create now clears that mode when the user removes/replaces the source or switches to an incompatible workflow. Explicit saved-recipe restores stay unchanged. Exit Enhance is also available beside Generate, outside the scrolling settings panel, including for already-stuck drafts; prompt/model settings are preserved.

Face-refinement outcomes were previously folded into queue summaries. They now have a separate queue line, and skipped/failed results appear under the selected original preview. The current detector is unchanged: the reported furry generations were skipped because no face was detected, not successfully refined.

Validation: 16 focused enhancement and automatic-face tests passed, plus production compilation. A hidden actual-app check restored a source-less Enhance draft, scrolled the sidebar to the bottom, used the visible exit, and verified persisted removal of Enhance/source lineage while preserving the prompt, negative prompt and hires settings. A corrected candidate supersedes the earlier 0.2.0 installer; the earlier VM disc still contains the original candidate.


## Candidate follow-up: illustrated faces and gentle hires

Face refinement now offers Illustration / furry, using the same publisher-pinned face_yolov8m model as the original Latent. The optional setup adds the verified Ultralytics architecture wheel and face checkpoint to the isolated CPU detector bundle. Training and dependency auto-installation are not invoked; the worker blocks network access and subprocess launches. Existing anime/YuNet recipes and receipts retain their identities. Newly enabled automatic refinement defaults to Illustration / furry; existing selections are preserved. Existing installations are shown an optional detector-update message. The library license and model attribution accompany setup.

A real hidden-app check updated an isolated installation and detected a face with approximately 85% confidence in a local illustrated canine image where the anime cascade found none. Another fox portrait still produced no detection, matching the original model's limitation. This improves coverage but is not a guarantee for animal faces. Geometry, scored receipts, stored provenance and automatic follow-up tests cover the new profile.

New hires settings use image/Lanczos resizing with 20% strength, DPM++ 2M and Karras. Gentle refinement applies that strategy to existing settings without changing their size or seed. Resize only skips the second sampler entirely. Switching refinement methods resets interpolation to the matching default; existing saved recipes are not silently rewritten. Stronger and latent refinement remain available with a concise explanation of anatomy changes.

A real 2048-square GPU comparison refined an existing base image with the same checkpoint, LoRA, conditioning and refinement seed. The gentle pass completed in about 95 seconds and visually retained the base pose, torso and hand shapes more closely than the prior 2x latent / nearest-exact / 35% pass. This is one inspected comparison, not a universal quality benchmark. All evaluation used a separate studio and headless processes; personal images and evidence are excluded from public source.


## Candidate follow-up: compact Create layout and window identity

Selected visible LoRA triggers are now enabled when editing their selections; a saved current draft with visible selections disabled resumes with those selections applied. The redundant master toggle is removed, and trigger lists start expanded. Historical recipe playback remains separate from authoring changes.

Generation parameters start open and precede upscaling/hires and Source image. Source image is collapsible, starting closed without an input and open with an input. Verbose hires guidance and redundant size summaries are removed. The manual Refine faces button is removed from Create; automatic refinement remains available and saved face edits can still be reused from history.

The BrowserWindow now receives the bundled Latent ICO explicitly. Windows taskbar details use the matching app ID and real unpacked icon path, including in installed builds. The existing executable and shortcut icon packaging remains in place.

Validation: 43 focused trigger, generation-settings and history tests passed. A hidden actual-app check verified the section order, open normal parameters, collapsed/expanded Source image and absence of the removed controls and prose. No image generation rerun was needed for these UI changes.

Face detector setup is now available directly beneath Automatically refine faces in Create, including installation progress, cancellation and retry. This restores setup access after removing the manual face editor shortcut and corrects the old Settings instruction.

Latent Classic refinement: hires presets restore Euler/Simple, base seed and CFG linking, and scale-dependent strength protection. Classic automatic faces use proportional context and adaptive working canvases up to 1024 pixels, preserving crop proportions with padding. Face sampling and generation LoRA use are independently configurable. Newly enabled controls use Classic; existing drafts and saved recipes retain their previous settings until Classic is selected. The custom elliptical masks and separate output history are retained; this is not a bit-for-bit Impact Pack reproduction.

Classic refinement is now the standard authoring behavior, without separate Classic presets or adaptive-crop switches. Upscale & refine immediately queues the selected saved image at up to 1.5x (2048-pixel side limit) with standard sampling and its saved seed; Refine image is shown at the size limit. It preserves the Create draft and original output, and follows with automatic faces when enabled. Existing saved enhancement graphs remain reproducible.


## SDXL-derived checkpoints

Discover and downloads now recognize NoobAI, Pony, Illustrious, SDXL 0.9/1.0, SDXL LCM, Lightning, Hyper, Turbo, Distilled, and Playground v2/v2.5. Checkpoints must still be marked Standard; separate refiner and inpainting checkpoint workflows are not enabled by this change. NoobAI uses the Illustrious family grouping. Other recognized derivatives use the SDXL grouping. Original Civitai base labels remain in metadata.

Create > Generation parameters > Model sampling defaults to Automatic, which lets ComfyUI read the checkpoint's embedded prediction information. If an untagged checkpoint needs an explicit mode, choose Epsilon, V-prediction, LCM or X0. V-prediction enables zero terminal SNR initially; it can be adjusted to match the model author's instructions. Changing checkpoints resets a manually selected override. Saved recipes, Enhance, and automatic face refinement retain their model sampling settings.

Prediction type is separate from the sampler/scheduler, steps and CFG. Follow the model author's settings, including secondary hires and face passes. NoobAI V-pred: https://huggingface.co/Laxhar/noobai-XL-Vpred-1.0 . Lightning: https://huggingface.co/ByteDance/SDXL-Lightning . Existing SDXL/Illustrious recipes without an override retain their original graphs.

Verification covers mocked downloads/imports, graph construction, saved-recipe validation and authoring behavior. No claim is made that every derivative checkpoint has been GPU-tested.

### Furry face detection update

Illustration / furry now uses publisher-hash-verified Fdetailer v1.1, restricted to
face class 0. New detections retain the 640/320 fallback and existing feathered
face-box masks. Old YOLO detections retain their original provenance and remain
replayable. Existing installations must run face-detector setup once in Settings
to download the replacement model; model weights are not bundled in the installer.

### Qwen Lightning eight-step editing

New editing conversations default to the tested eight-step FP32 Lightning adapter
on the native INT8 Qwen Edit 2511 model, CFG 1, Euler/simple, shift 3.1.
Standard, four-step Lightning and Compact remain selectable. Saved conversations
and recorded recipes keep their original profile and artifact identities.
Eight-step setup shares the installed diffusion model, encoder and VAE; its adapter
has a separate verified receipt so four-step replay remains available.
