const codeRevision = 'a0f451a5113cf9becb0847b92884cb10cbdec0ef';
const modelRevision = '018e402774aeeddd60609b4ecdb7e298259dc729';
export const IPADAPTER_RELEASE = Object.freeze({
  id: 'ipadapter-plus-sdxl-vit-h-v1', codeRepository: 'cubiq/ComfyUI_IPAdapter_plus', codeRevision, codeLicense: 'GPL-3.0', customNodeDirectory: 'latent_ipadapter_plus',
  modelRepository: 'h94/IP-Adapter', modelRevision, modelLicense: 'Apache-2.0', encoderOriginLicense: 'MIT',
  modelCardUrl: `https://huggingface.co/h94/IP-Adapter/blob/${modelRevision}/README.md`,
  encoderOriginUrl: 'https://huggingface.co/laion/CLIP-ViT-H-14-laion2B-s32B-b79K',
  encoderOriginRevision: '1c2b8495b28150b8a4922ee1c8edee224c284c0c',
  codeSourceUrl: `https://github.com/cubiq/ComfyUI_IPAdapter_plus/tree/${codeRevision}`,
  runtimeTarget: { comfyCommit: '12d5279438bfefc058a269eae805ceab6047777f', comfyVersion: '0.34.0', dependencies: { torch: '2.11.0+cu130', torchvision: '0.26.0+cu130', einops: '0.8.2', Pillow: '12.3.0', safetensors: '0.8.0' } },
  codeFiles: [
    { filename: 'CrossAttentionPatch.py', bytes: 10658, sha256: '34c2cc84d26f2b5250a30e69106fd346fd3c2778c885f179220096dade7bbdd6' },
    { filename: 'IPAdapterPlus.py', bytes: 90229, sha256: 'c10f4a8dd8e96b1c1733f513a22d2468c7687c2dd45a0d7ddf5a5b1f7e811c23' },
    { filename: 'LICENSE', bytes: 35149, sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986' },
    { filename: 'NODES.md', bytes: 5244, sha256: '64e3de828064cf65975f7396c74eefda82f53eeb88be998e682bd0ec4481885e' },
    { filename: 'README.md', bytes: 9911, sha256: '07f3a69829464a79656713fd28fcded8c12b6631d8a26414e03dbbd53d49d607' },
    { filename: '__init__.py', bytes: 1787, sha256: '9d96e97512e15d079b48a67aef4b42b25fde78df697bb8672d3f70ddd9ad8e85' },
    { filename: 'image_proj_models.py', bytes: 8946, sha256: '35f7bb34fb420b9659b02ba9288229430788397b271504e6536a08676073cb8b' },
    { filename: 'pyproject.toml', bytes: 560, sha256: '2d5e8fbb4900676dbbdc7046ce3c410496b36a26b197f7b0b86d35fc67e52dad' },
    { filename: 'utils.py', bytes: 15966, sha256: '1174018754abea857d76f5e2bc139e6d2b4673c85489a5410a6001153f894a3d' },
  ].map(file => ({ ...file, url: `https://raw.githubusercontent.com/cubiq/ComfyUI_IPAdapter_plus/${codeRevision}/${file.filename}` })),
  supportFiles: [
    { filename: 'MODEL_CARD.md', bytes: 3091, sha256: 'ba3a50dc2093d0eb075890e9af7409382874669d83939e64323246d0c4403cf8', url: `https://huggingface.co/h94/IP-Adapter/resolve/${modelRevision}/README.md` },
    { filename: 'ENCODER_MODEL_CARD.md', bytes: 8209, sha256: '14db420f00ddf78a07194dc4cdc57977d979e0f2c34994137679046defdf6577', url: 'https://huggingface.co/laion/CLIP-ViT-H-14-laion2B-s32B-b79K/resolve/1c2b8495b28150b8a4922ee1c8edee224c284c0c/README.md' },
    { filename: 'APACHE-2.0.txt', bytes: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30', url: 'https://www.apache.org/licenses/LICENSE-2.0.txt' },
  ],
  models: [
    { role: 'adapter', filename: 'ip-adapter-plus_sdxl_vit-h.safetensors', directory: 'ipadapter', bytes: 847517512, sha256: '3f5062b8400c94b7159665b21ba5c62acdcd7682262743d7f2aefedef00e6581', url: `https://huggingface.co/h94/IP-Adapter/resolve/${modelRevision}/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors` },
    { role: 'clip-vision', filename: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors', directory: 'clip_vision', bytes: 2528373448, sha256: '6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030', url: `https://huggingface.co/h94/IP-Adapter/resolve/${modelRevision}/models/image_encoder/model.safetensors` },
  ] as const,
});
