import type { ModelDownloadRequest, ModelProvenance } from './types';

export interface ModelCatalogEntry extends ModelDownloadRequest {
  id: string;
  name: string;
  publisher: string;
  description: string;
  bytes: number;
  sha256: string;
  sourceUrl: string;
  licenseUrl: string;
  provenance: ModelProvenance;
  suggestedWeight?: number;
  triggerRequired?: boolean;
}

const SDXL_REVISION = '462165984030d82259a11f4367a4eed129e94a7b';
const SDXL_LICENSE = `https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/${SDXL_REVISION}/LICENSE.md`;
const OPENRAIL_LICENSE = 'https://huggingface.co/spaces/CompVis/stable-diffusion-license/blob/main/license.txt';

// Publisher identities were checked on 2026-09-04. A catalog entry is an
// acquisition option; it is not a claim of tested GPU or workflow compatibility.
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'onoma-illustrious-xl-1.1', name: 'Illustrious XL 1.1', publisher: 'Onoma AI',
    description: 'An illustration checkpoint with natural-language prompting. Start here for the Illustrious family.',
    kind: 'checkpoint', family: 'illustrious', filename: 'Illustrious-XL-v1.1.safetensors', bytes: 6938040728,
    sha256: '536863e9f0c13b0ce834e2f8a19ada425ee4f722c0ad3d0051ec7e6adaa8156c',
    url: 'https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.1/resolve/8d966ec810874502d56a22ec9130dab6ef74c5ff/Illustrious-XL-v1.1.safetensors',
    sourceUrl: 'https://huggingface.co/OnomaAIResearch/Illustrious-XL-v1.1/blob/8d966ec810874502d56a22ec9130dab6ef74c5ff/README.md', licenseUrl: SDXL_LICENSE,
    provenance: { repository: 'OnomaAIResearch/Illustrious-XL-v1.1', revision: '8d966ec810874502d56a22ec9130dab6ef74c5ff', version: '1.1', licenseName: 'CreativeML Open RAIL++-M (author links SDXL license)' },
  },
  {
    id: 'stabilityai-sdxl-base-1.0', name: 'SDXL Base 1.0', publisher: 'Stability AI',
    description: 'The original SDXL checkpoint for general image creation. A refiner is optional.',
    kind: 'checkpoint', family: 'sdxl', filename: 'sd_xl_base_1.0.safetensors', bytes: 6938078334,
    sha256: '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b',
    url: `https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/${SDXL_REVISION}/sd_xl_base_1.0.safetensors`,
    sourceUrl: `https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/${SDXL_REVISION}/README.md`, licenseUrl: SDXL_LICENSE,
    provenance: { repository: 'stabilityai/stable-diffusion-xl-base-1.0', revision: SDXL_REVISION, version: '1.0', licenseName: 'CreativeML Open RAIL++-M' },
  },
  {
    id: 'nerijs-pixel-art-xl-v1', name: 'Pixel Art XL', publisher: 'NeriJS',
    description: 'A pixel-art style for SDXL Base 1.0. Use without a refiner; the creator recommends a corrected VAE.',
    kind: 'lora', family: 'sdxl', filename: 'pixel-art-xl.safetensors', bytes: 170543052,
    sha256: '4234637cb80c998f41e348e6a6cb6bc20d8d038b2b0f256b6129b3b5e353eef7',
    url: 'https://huggingface.co/nerijs/pixel-art-xl/resolve/8bf4a4d9ea283e00a51fafda8e0539f8248ea037/pixel-art-xl.safetensors',
    sourceUrl: 'https://huggingface.co/nerijs/pixel-art-xl/blob/8bf4a4d9ea283e00a51fafda8e0539f8248ea037/README.md', licenseUrl: OPENRAIL_LICENSE,
    triggers: ['pixel art'], triggerRequired: false, suggestedWeight: 0.8,
    provenance: { repository: 'nerijs/pixel-art-xl', revision: '8bf4a4d9ea283e00a51fafda8e0539f8248ea037', version: 'v1', licenseName: 'CreativeML Open RAIL-M', baseModel: 'stabilityai/stable-diffusion-xl-base-1.0' },
  },
  {
    id: 'arzumata-copilot-style-illustrious', name: 'Slime Girl Copilot Style', publisher: 'ARZUMATA',
    description: 'A soft character style for Illustrious XL 1.1. The creator suggests strength 0.4–1 and also demonstrates non-slime subjects.',
    kind: 'lora', family: 'illustrious', filename: 'Slime_Girl_Copilot_Style_IL_ARZUMATA.safetensors', bytes: 303862724,
    sha256: '419d9e92a6c8c39e8cecaf43d5bd29fd58b4ad433730c92ae1c2eed666923da0',
    url: 'https://huggingface.co/ARZUMATA/Slime_Girl_Copilot_Style_Illustrious/resolve/99801a668f4891b5310411a1e5feadf3251fa4d6/Slime_Girl_Copilot_Style_IL_ARZUMATA.safetensors',
    sourceUrl: 'https://huggingface.co/ARZUMATA/Slime_Girl_Copilot_Style_Illustrious/blob/99801a668f4891b5310411a1e5feadf3251fa4d6/README.md', licenseUrl: OPENRAIL_LICENSE,
    triggers: ['c0pi1ot'], triggerRequired: false, suggestedWeight: 0.7,
    provenance: { repository: 'ARZUMATA/Slime_Girl_Copilot_Style_Illustrious', revision: '99801a668f4891b5310411a1e5feadf3251fa4d6', licenseName: 'CreativeML Open RAIL-M', baseModel: 'OnomaAIResearch/Illustrious-XL-v1.1' },
  },
];

export function catalogDownload(model: ModelCatalogEntry): ModelDownloadRequest {
  return { url: model.url, filename: model.filename, kind: model.kind, family: model.family, sha256: model.sha256, triggers: model.triggers ?? [], sourceUrl: model.sourceUrl, licenseUrl: model.licenseUrl, provenance: { ...model.provenance } };
}
