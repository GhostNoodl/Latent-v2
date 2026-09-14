# Latent v2 0.2.0 work plan

Status: in development on `codex/0.2.0-update`. No 0.2.0 installer or release has been published. The app version remains 0.1.1 until release preparation.

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
- [~] #8 Add consistent activity-panel transitions and color transitions, honoring reduced motion. Broader animation polish remains.

## Remaining batches

- [x] #1 Unified setup progress with the current component, known byte counts and installation/verification messages. Dependency installation uses clearly labeled stage estimates.
- [ ] #3 A new application icon, reviewed at small sizes and applied to Windows packaging.
- [x] #4 Confirmed Recycle Bin removal for studio-owned models, with in-use checks, refreshed selectors and hidden deliberately removed entries. External folders stay read-only.
- [ ] #6 Smaller Qwen editing model route, including GGUF feasibility and real 16 GB GPU memory/speed/quality testing.
- [ ] #7 Optional app updates: check/download/install preferences, defer while busy, and test upgrades.
- [x] #9 Expanded base-model discovery choices (including an exact custom label), workflow compatibility badges, and an explicitly loaded-results compatibility filter. Searching does not broaden download/generation support.
- [x] #10 Clean display names, new Civitai download/import filenames and existing files through Details / manage file. Saved references survive renames; occupied names cannot be overwritten. Civitai collisions get a short checksum suffix.
- [x] #12 Version-specific creator galleries with thumbnail selection, previous/next controls, larger view, failure retry and empty states. Up to 24 unique image previews are retained per version, regardless of rating.
- [x] #14 Stop/restart an idle managed engine around model changes. Busy queues/downloads request a retry after work finishes; no active job is interrupted or silently cancelled. Live engine verification remains a release check.
- [x] #16/16B Optional per-LoRA trigger choices insert literal text into new visible-mode prompts. Owned spans support removal, shared words and user edits. Older recipes retain their original resolver until explicitly converted.
- [x] #20 Five optional, editable starter wildcard packs (106 choices), with source references, bundled alias/duplicate cleanup and collision-safe staging.
- [x] #23 Enhance saved generations through a reviewed Create draft and one latent diffusion refinement pass, saving a linked result and preserving the original. GPU quality remains a release check.
- [x] #25 Optional automatic face refinement after generation/hires, with separate cancellable follow-up jobs, restart recovery and preserved originals. Real stylized/furry-face quality remains a hardware release check.

## Qwen integration findings

The current image editor uses a pinned native INT8-convrot workflow and is still marked `unverified-16gb` in its runtime contract. GGUF cannot be substituted by renaming the existing asset: acquisition/validation, a compatible loader, workflow capability checks and persisted recipe identity all need an explicit route. Candidate quantizations must be compared with the whole pipeline (text encoder, VAE, temporary buffers and offloading), not just model file size. No new Qwen weights have been downloaded or benchmarked for this update yet.

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
