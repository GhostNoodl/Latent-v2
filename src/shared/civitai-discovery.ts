import type { CivitaiModel, CivitaiVersion } from './civitai-types';
import type { ModelFamily } from './types';
/** Explicit SDXL architecture labels; unrelated architectures stay unsupported. */
export const SDXL_BASE_MODELS = ['SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM', 'SDXL Lightning', 'SDXL Hyper', 'SDXL Turbo', 'SDXL Distilled', 'Pony', 'Illustrious', 'NoobAI', 'Playground v2', 'Playground v2.5'] as const;
export function sdxlBaseFamily(base: string): ModelFamily | 'unknown' {
 return base === 'Illustrious' || base === 'NoobAI' ? 'illustrious' : (SDXL_BASE_MODELS as readonly string[]).includes(base) ? 'sdxl' : 'unknown';
}
export const CIVITAI_BASE_MODELS = [...SDXL_BASE_MODELS, 'SD 1.5', 'SD 2.1', 'Flux.1 D', 'Flux.1 S'] as const;
export function civitaiWorkflowIssue(model: Pick<CivitaiModel,'kind'>, version: CivitaiVersion): string | null {
 if(version.family==='unknown')return 'Unknown or unsupported base family';
 if(sdxlBaseFamily(version.baseModel)==='unknown')return 'Requires a different generation workflow';
 if(model.kind==='checkpoint'&&version.baseModelType!=='Standard')return 'Requires an explicitly Standard checkpoint';
 if(model.kind==='lora'&&version.baseModelType&&version.baseModelType!=='Standard')return 'Requires a different checkpoint workflow';
 return null;
}
export function civitaiCompatibilityLabel(model:CivitaiModel):string {
 const supported=model.versions.filter(v=>!civitaiWorkflowIssue(model,v));
 if(!supported.length)return 'Needs another workflow';
 return supported.length===model.versions.length?'Create supported':'Some versions support Create';
}

export function civitaiPreferredVersion(model:CivitaiModel, baseModel?:string, compatibleOnly=false):CivitaiVersion|undefined {
 const candidates=model.versions.filter(v=>!compatibleOnly||!civitaiWorkflowIssue(model,v));
 return candidates.find(v=>v.baseModel===baseModel)??candidates[0]??model.versions[0];
}
