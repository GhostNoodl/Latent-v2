import type { AppSnapshot } from './types';

import type { HardwareInventory } from './hardware-profile-types';

import type { PackageStorageSnapshot } from './storage-types';

export type SetupCapability = 'engine' | 'images' | 'edit' | 'video';

export interface SetupCard { id: SetupCapability; title: string; ready: boolean; requirements: string[]; message: string; }

export interface SetupPreflight { capability: SetupCapability; checkedAt: string; blockers: string[]; warnings: string[]; gpu?: string; storage: PackageStorageSnapshot; }

export function setupCards(s: AppSnapshot): SetupCard[] {

  const engine = s.backend.state === 'ready';

  const checkpoint = s.models.some(m => m.kind === 'checkpoint' && m.status === 'ready' && ['sdxl','illustrious'].includes(m.family));

  return [

    { id:'engine',title:'Generation engine',ready:engine,requirements:['Private Python environment','ComfyUI and GPU libraries'],message:engine?'Running and ready':s.backend.state === 'stopped'?'Installed — start the engine':s.backend.message },

    { id:'images',title:'Create images',ready:engine && checkpoint,requirements:['Generation engine','SDXL or Illustrious checkpoint','Text encoders and VAE included in supported full checkpoints'],message:!engine?'Set up the engine first':checkpoint?'Ready to choose a model and create':'Choose an existing checkpoint, or download the Illustrious starter' },

    { id:'edit',title:'Edit images with Qwen',ready:engine && s.qwenEdit.baseReady,requirements:['Generation engine','Qwen diffusion model','Text encoder','VAE'],message:!engine?'Set up the engine first':s.qwenEdit.baseReady?'Base editing bundle ready':s.qwenEdit.message },

    { id:'video',title:'Create videos',ready:engine && s.video.canGenerate && !!s.video.assets?.fusedPresent,requirements:['Generation engine','H3 fused diffusion model','Text encoder','Video and audio VAEs'],message:!engine?'Set up the engine first':s.video.message },

  ];

}

/** Conservative guided-setup policy, not a claim of tested generation on every GPU. */

export function setupHardwareBlockers(h: HardwareInventory, capability: SetupCapability): string[] {

  const errors: string[] = [];

  if (!h.os.startsWith('Windows_NT') || h.arch !== 'x64') errors.push('Guided setup currently supports Windows x64.');

  const gpu = h.selectedGpu ?? (h.gpus.length === 1 ? h.gpus[0] : undefined);

  if (!gpu) errors.push('A single NVIDIA GPU must be identified before automatic setup. Check your driver or device selection in Settings.');

  else {

    if (!/RTX/i.test(gpu.name)) errors.push('This guided setup currently supports NVIDIA RTX GPUs. Other devices need separate compatibility verification.');

    const [major,minor] = gpu.driver.split('.').map(Number);

    if (!Number.isFinite(major) || major < 580 || major === 580 && (!Number.isFinite(minor) || minor < 88)) errors.push('Update your NVIDIA Windows driver to 580.88 or newer before setup.');

    const minimum = capability === 'edit' || capability === 'video' ? 16 * 1000 : 8 * 1000;

    if (gpu.vramMiB < minimum) errors.push(`Guided ${capability === 'edit' || capability === 'video' ? 'editing/video' : 'image'} setup requires a ${minimum === 16000 ? '16' : '8'} GB GPU. Smaller GPUs need a separately verified configuration.`);

  }

  const ram = capability === 'edit' || capability === 'video' ? 32 : 16;

  if (h.ramBytes < (ram - 1) * 1024 ** 3) errors.push(`This setup profile requires ${ram} GB of system memory.`);

  return errors;

}


export function setupStorageBlockers(storage: PackageStorageSnapshot, capability: SetupCapability): string[] {
  if (!storage.volumes.length || storage.volumes.some(v => v.availableBytes === undefined)) return ['Available storage could not be checked. Check folder access and retry.'];
  const reserve = capability === 'engine' ? 15 * 1024 ** 3 : 2 * 1024 ** 3;
  return storage.volumes.some(v => v.availableBytes! < (capability === 'images' ? storage.package.minimumDownloadBytes : v.minimumDownloadBytes) + reserve) ? ['Not enough free space in a setup destination. Choose storage or free space, then check again.'] : [];
}
export function imageSetupReason(s: AppSnapshot): string {
  if (s.backend.state !== 'ready') return 'Open Setup to start the generation engine.';
  if (!s.draft.upscale && !s.models.some(m=>m.id===s.draft.checkpointId && m.kind==='checkpoint' && m.status==='ready')) return 'Choose an installed checkpoint in Models, or open Setup.';
  return '';
}
