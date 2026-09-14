"""Per-model H3 attention selection using ComfyUI's native attention adapters.

No global attention override and no package installation on import.
"""


class LatentVideoAttention:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "attention": (["sage-auto"],)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "Latent/video"

    def patch(self, model, attention):
        from comfy.ldm.modules.attention import SAGE_ATTENTION_IS_AVAILABLE, attention_sage
        if attention != "sage-auto" or not SAGE_ATTENTION_IS_AVAILABLE:
            raise RuntimeError("SageAttention is not available in the private engine. Select Default attention or install the matching optional packages.")
        clone = model.clone()
        clone.set_model_optimized_attention(attention_sage)
        return (clone,)


NODE_CLASS_MAPPINGS = {"LatentVideoAttention": LatentVideoAttention}
