export const QWEN21_IDENTITIES = {
  "diffusion": {
    "filename": "qwen-image-2.1/qwen_image_2.1_int8_convrot.safetensors",
    "directory": "diffusion_models",
    "bytes": 7256783064,
    "sha256": "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d",
    "headerBytes": 74448,
    "headerSha256": "64ac1c737e46bf4f181d302e4836591306e26e4f62d547b2bef08270c9c97567",
    "tensorCount": 649,
    "dtypes": [
      "BF16",
      "F32",
      "I8",
      "U8"
    ]
  },
  "encoder": {
    "filename": "qwen-image-2.1/qwen3vl_8b_int8_convrot.safetensors",
    "directory": "text_encoders",
    "bytes": 9350798360,
    "sha256": "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
    "headerBytes": 140992,
    "headerSha256": "b55c03ca5443ee1514738dbf69dceddf9074ae5e745bce5a2310754e0b37078d",
    "tensorCount": 1258,
    "dtypes": [
      "BF16",
      "F32",
      "I8",
      "U8"
    ]
  },
  "vae": {
    "filename": "qwen-image-2.1/qwen_image_2.1_vae_bf16.safetensors",
    "directory": "vae",
    "bytes": 675509688,
    "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
    "headerBytes": 28872,
    "headerSha256": "c091c3d231f352db5fb44840e22388d2abe9c2c37b4daf97bdc6cc3448387759",
    "tensorCount": 238,
    "dtypes": [
      "BF16"
    ]
  }
} as const;
export const QWEN21_RUNTIME = {
  "route": "qwen21-int8",
  "comfySourceCommit": "c194dd00cd42aa18d9dbf27d977bf6b85d9ea565",
  "comfyVersion": "0.37.0",
  "torchVersion": "2.11.0+cu130",
  "comfyKitchenVersion": "0.2.35",
  "customNodes": [],
  "cpuTextEncoder": true,
  "memoryStatus": "unverified-16gb"
} as const;
export const QWEN21_REPOSITORY = "Comfy-Org/Qwen-Image-2.1";
export const QWEN21_REVISION = "ace0edeb3791a594ddfa36ed5f41a178a394e921";
export const QWEN21_SET_ID = "comfy-0-37-0-qwen21-1";
