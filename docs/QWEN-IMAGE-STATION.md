# Qwen Image Station

Open **Qwen** in the sidebar. Choose **Qwen Image 2.1** or an existing Qwen
Lightning profile in the Model selector. The same selector is available from
**Edit with Qwen** and when reusing an image's saved recipe.

With Qwen 2.1 you can:

- Create an image from a text prompt, without a source image.
- Edit an imported image or continue from a saved result.
- Request a transparent background, saved as an RGBA PNG.
- Add one additional reference image. Refer to the main input as `<image1>` and
  the second reference as `<image2>` in the instruction.

Results are retained in station history and the Library. Reuse exact recipe
restores the selected model, seed, operation, transparency setting and reference
identities. Continuing from a result switches to editing that result. Changing
models deliberately clears incompatible creation/reference options; historical
Lightning recipes remain available.

## Setup

Install the private image engine first if this is a fresh studio. Select Qwen
2.1 and use its Install button. Setup stages ComfyUI 0.37.0 and a separate Python
environment through the existing transactional updater, activates only when the
studio is idle, and downloads the three pinned model files (about 16.1 GiB).
Engine installation needs additional disk space. Settings retains the runtime
rollback controls. The newer engine is optional and is not selected by ordinary
automatic update checks.

Model downloads resume partial files and verify SHA-256 and tensor headers.
Qwen 2.1 uses its own diffusion model, Qwen3-VL encoder and VAE; it never applies
the Qwen 2511 Lightning adapter to the new architecture. No benchmark directories
or developer-machine paths are required by the application.

The model weights use the publisher's **Qwen Research License**, separate from
Latent's MIT license. The pinned license is downloaded with the models:
[publisher license](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/790c92633540aa0cb11d9abf19eb46d861714758/LICENSE).

## Expectations

The default Qwen 2.1 recipe uses 25 steps, CFG 1 and CPU text encoding. It samples
around one megapixel, then resizes to the chosen saved dimensions. The first
image and edits with changed inputs/prompts take longer than a warmed repeat.
Transparency is model-generated, not guaranteed perfect background segmentation;
reference images guide the result rather than guaranteeing an exact costume copy.

This version supports one main input and one additional reference. It does not
add Qwen LoRA training/loading or masked Qwen editing.

## Model format

Qwen Image 2.1 uses native INT8 ConvRot. Experimental Q4 and Q8 GGUF options were removed after isolated RTX 4060 Ti testing found native INT8 faster. The older Qwen 2511 Compact option remains available.
