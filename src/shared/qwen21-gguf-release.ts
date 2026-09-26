// Pinned publisher files and an isolated node name; existing Compact loader remains unchanged.
export const QWEN21_GGUF_LOADER = {
  "repository": "leejet/ComfyUI-GGUF",
  "revision": "edd981b10e107d3b8f58e16c498f2d08f631bc47",
  "directory": "latent_qwen21_gguf",
  "files": [
{"filename":"convert.py","subdirectory":"tools","url":"https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/tools/convert.py","bytes":14110,"sha256":"70df458256019dd7d2884f9cf28a1365613c37441a9a061a134d3a183563a1fb"},
    {
      "filename": "LICENSE",
      "url": "https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/LICENSE",
      "bytes": 11357,
      "sha256": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
    },
    {
      "filename": "README.md",
      "url": "https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/README.md",
      "bytes": 3225,
      "sha256": "db22b62785c762a128bf2207fc33937254e4fe4164bbabaf5e56c99eab0ff07a"
    },
    {
      "filename": "dequant.py",
      "url": "https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/dequant.py",
      "bytes": 12338,
      "sha256": "215369438d96c372c09eb8701eec3c3b0348084c96dd3ea83872601ebed42017"
    },
    {
      "filename": "loader.py",
      "url": "https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/loader.py",
      "bytes": 21260,
      "sha256": "9b84405e362d443d86d8b5e473565586f699b86abfacdd621dc90e671c0d845b"
    },
    {
      "filename": "nodes.py",
      "url": "https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/nodes.py",
      "bytes": 13649,
      "sha256": "16be3b08b13de6279fc432addc628320019fcb24963cbc6b52b248de8f06316e"
    },
    {
      "filename": "ops.py",
      "url": "https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/ops.py",
      "bytes": 12201,
      "sha256": "b927e24a7b00c181e9511900fb5afde45464793cf460e1d39a5e736ba093ce64"
    },
    {
      "filename": "requirements.txt",
      "url": "https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/requirements.txt",
      "bytes": 71,
      "sha256": "7f044de2d008cd7a4db54c27efc206327517bca4eb3e0f0835cf769b98d9de6c"
    },
    {
      "filename": "__init__.py",
      "url": "https://raw.githubusercontent.com/leejet/ComfyUI-GGUF/edd981b10e107d3b8f58e16c498f2d08f631bc47/__init__.py",
      "bytes": 103,
      "sha256": "e5f9b314234473ddd0e9936d6857352724ffd44e8b0900b7d204ae99bf80259e",
      "source": "from .nodes import UnetLoaderGGUF\nNODE_CLASS_MAPPINGS = {\"LatentQwen21UnetLoaderGGUF\": UnetLoaderGGUF}\n"
    }
  ]
} as const;
export const QWEN21_GGUF_DIFFUSION = {
  "filename": "qwen-image-2.1/qwen-image-2.1-Q4_K_M.gguf",
  "directory": "diffusion_models",
  "bytes": 4604557984,
  "sha256": "833439e91bc1152d28f37aa198c7f6f4218b7de95754c2f7a318a2422ab4b2f8",
  "headerBytes": 24,
  "headerSha256": "76b60cc60537b3df9718a082d42647c5837291baa7d15d39f3ac2bb5a5857cea",
  "tensorCount": 297,
  "dtypes": [
    "GGUF-Q4_K_M"
  ],
  "repository": "abenzerps/Qwen-Image-2.1-GGUF",
  "revision": "c4de66efa2183fb25ecbc185bac509ee37952b41",
  "sourceFile": "qwen-image-2.1-Q4_K_M.gguf"
} as const;
