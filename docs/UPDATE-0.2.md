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
- [ ] #9 More Discover search/filter choices and clearly marked generation compatibility.
- [x] #10 Clean display names, new Civitai download/import filenames and existing files through Details / manage file. Saved references survive renames; occupied names cannot be overwritten. Civitai collisions get a short checksum suffix.
- [ ] #12 Model-detail image galleries in Discover.
- [x] #14 Stop/restart an idle managed engine around model changes. Busy queues/downloads request a retry after work finishes; no active job is interrupted or silently cancelled. Live engine verification remains a release check.
- [ ] #16/16B Select LoRA triggers and insert them into the visible prompt, tracking ownership so removing a LoRA preserves manual edits and shared triggers. Maintain old history/recipe reproduction.
- [ ] #20 Curated, editable booru wildcard packs with provenance and alias/duplicate cleanup.
- [ ] #23 Enhance saved generations through diffusion refinement, saving a linked result and preserving the original.
- [ ] #25 Automatic face refinement after generation/hires, retaining the result when no face is detected; test stylized and furry faces.

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
