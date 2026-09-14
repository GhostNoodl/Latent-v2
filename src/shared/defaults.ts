import type { AppSettings, GenerationDraft } from './types';
export const DEFAULT_DRAFT: GenerationDraft = {
  family: 'illustrious', checkpointId: '', prompt: '', negativePrompt: '', width: 1024, height: 1024,
  steps: 28, cfg: 5, sampler: 'euler', scheduler: 'normal', seed: 'random', batchSize: 1, loras: [], autoTriggers: true,
  triggerResolutionVersion: 'punctuation@2',
};
export const DEFAULT_SETTINGS: AppSettings = {
  showGenerationPreview: true,
  theme: 'system', accent: 'iris', rememberPositivePrompt: true, rememberNegativePrompt: false,
  civitaiAutoMetadata: false, civitaiDisplayMetadata: true, desktopNotifications: false, notifyGeneration: true, notifyDownload: true, notifyError: true, backendAutoStart: true, deviceMode: 'auto',
};
export const SIZE_PRESETS = [
  { name: 'Square', width: 1024, height: 1024 }, { name: 'Portrait', width: 832, height: 1216 }, { name: 'Landscape', width: 1216, height: 832 },
];
export const SAMPLERS = ["euler", "euler_cfg_pp", "euler_ancestral", "euler_ancestral_cfg_pp", "heun", "heunpp2", "exp_heun_2_x0", "exp_heun_2_x0_sde", "dpm_2", "dpm_2_ancestral", "lms", "dpm_fast", "dpm_adaptive", "dpmpp_2s_ancestral", "dpmpp_2s_ancestral_cfg_pp", "dpmpp_sde", "dpmpp_sde_gpu", "dpmpp_2m", "dpmpp_2m_cfg_pp", "dpmpp_2m_sde", "dpmpp_2m_sde_gpu", "dpmpp_2m_sde_heun", "dpmpp_2m_sde_heun_gpu", "dpmpp_3m_sde", "dpmpp_3m_sde_gpu", "ddpm", "lcm", "ipndm", "ipndm_v", "deis", "res_multistep", "res_multistep_cfg_pp", "res_multistep_ancestral", "res_multistep_ancestral_cfg_pp", "gradient_estimation", "gradient_estimation_cfg_pp", "er_sde", "seeds_2", "seeds_3", "sa_solver", "sa_solver_pece", "ddim", "uni_pc", "uni_pc_bh2"];
export const SCHEDULERS = ["simple", "sgm_uniform", "karras", "exponential", "ddim_uniform", "beta", "normal", "linear_quadratic", "kl_optimal"];
