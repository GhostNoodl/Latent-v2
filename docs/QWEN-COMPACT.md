# Compact Qwen editing

In the Qwen editor, choose **Compact · smaller model, 4 steps** under Editing profile, then **Install Compact**. Setup pauses an idle managed engine and restarts it afterward if it was running. Finish or cancel active jobs before setup. Base and Fast remain available; changing profiles never silently changes an existing recorded recipe.

Compact uses Qwen Image Edit 2511 Q4_K_S with the matching four-step Lightning adapter, CPU text encoding and the same aligned reference canvas as the existing editor. A smaller saved output does not reduce the roughly one-megapixel inference workload. This is a smaller weight format, not a promise that every edit will be faster or use less peak GPU memory.

## Files and runtime

- Diffusion: [Unsloth Q4_K_S](https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF/tree/0d33d9692b4b26212297240d87b0d4719aa4fd06), 12,410,747,488 bytes. SHA-256 `df952ef0d2b46463bd95d9afbb78e045ec5412316f453a7ad5a3d7bcbb111b72`.
- Shared encoder: Qwen 2.5 VL 7B FP8 scaled, 9,384,670,680 bytes.
- Shared VAE: Qwen image VAE, 253,806,246 bytes.
- Shared adapter: Qwen Image Edit 2511 Lightning four-step V1.0 BF16, 849,608,296 bytes.
- Total model payload: 22,898,832,710 bytes (about 22.9 GB). Existing verified supporting files are reused; existing INT8 weights are retained.
- [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF/tree/6ea2651e7df66d7585f6ffee804b20e92fb38b8a), exact source files pinned in `src/shared/qwen-gguf-release.ts`; installed as `custom_nodes/latent_qwen_gguf` inside the studio.
- GGUF Python package 0.19.0, exact wheel SHA-256 `70bcd10edfe697fb2dad6e40af2234b9d8ece9a41a99761405121ebda1c3c1cd`. Installed without resolving or replacing other dependencies. Conflicting installed versions are preserved and reported.

Model and loader files are optional setup downloads, not bundled in the app installer. Model cards and Apache-2.0 notices are retained with setup; the GGUF wheel carries its own license metadata. All executable loader files and the wheel are checksum-pinned. Verify / repair retains changed loader files in the studio cache before restoring the pinned code, and can reinstall the matching GGUF dependency. A different dependency version is preserved and reported. The managed engine is stopped while the loader/dependency is installed.

## Recipe compatibility

The Compact recipe is `qwen-image-edit-2511-gguf-q4ks@1`. It uses `UnetLoaderGGUF`, the ordinary CPU `CLIPLoader`, and the existing Lightning, conditioning and image-save nodes. Base/Fast retain `UNETLoader` and their existing INT8 workflow versions. Submission verifies the selected model hashes; execution checks live node capabilities and binds exact registered model filenames. Recorded sources, instructions, seed, four-step settings and model identities remain part of history and replay.

## Verification

Automated checks cover legacy recipes, model-route mismatches, frozen weight identities, Compact settings persistence and shared storage accounting. The actual editor was exercised headlessly for selection, setup dispatch and readiness. GPU measurements and source/output inspection are recorded separately before a hardware claim is made. Windows installer/update acceptance remains part of the final release pass.

## RTX 4060 Ti comparison, September 14, 2026

A synthetic 1024-square scene with a blue teapot, two cups, wooden table and window was edited to recolor only the teapot emerald green. Both routes used seed 12345, four steps, CFG 1, CPU text encoding, Auto GPU memory mode, 1024-square native sampling and 512-square saved output. Each ran in a separate engine process on ComfyUI 0.34.0 / Torch 2.11.0+cu130 / comfy-kitchen 0.2.31. The PC had 64 GB of system RAM and NVIDIA driver 610.74.

| Observation | Fast (native INT8) | Compact (GGUF Q4_K_S) |
| --- | ---: | ---: |
| Submission to collected output | 57.213 s | 83.357 s |
| Sampled whole-device GPU maximum | 15,293 MiB | 14,611 MiB |
| Minimum available host RAM | 14.16 GiB | 24.67 GiB |
| One-second memory samples | 58 | 84 |
| Diffusion file | 20.50 GB | 12.41 GB |

Both completed without an out-of-memory error. Both outputs recolored the teapot and retained the two cups, window, table and overall composition. The results looked similar in this simple example, with small shading/edge differences. Compact loaded its diffusion model fully for sampling; the engine subsequently offloaded some weights for VAE decoding. Fast remains the quicker measured choice; Compact reduces model storage and offers more memory headroom in this case.

Timing includes first-use model loading and text encoding but excludes installation, asset verification and engine startup, with one-second completion polling. GPU samples include the desktop and other applications and may miss instantaneous peaks; host RAM availability is also system-wide. OS caches and other desktop work were not controlled. One recoloring test on this 64 GB RAM machine does not establish quality or performance for other instructions, images, aspect ratios, GPUs or RAM capacities, nor replace final installer acceptance.

Source PNG SHA-256: `9ebca06d0f2cf264173772e531980c0edc92a78f5c9e27dae7260c379a266c1c`. Local evidence retains complete workflows, logs, memory samples and source/output images separately from the public export.
