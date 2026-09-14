import type { CivitaiModel, CivitaiVersion } from './civitai-types';
/** Discovery choices do not expand the generation or download compatibility contract. */
export const CIVITAI_BASE_MODELS = ['Illustrious', 'SDXL 1.0', 'Pony', 'NoobAI', 'SDXL Turbo', 'SDXL Lightning', 'SD 1.5', 'SD 2.1', 'Flux.1 D', 'Flux.1 S'] as const;
export function civitaiWorkflowIssue(model: Pick<CivitaiModel,'kind'>, version: CivitaiVersion): string | null {
 if(version.family==='unknown')return 'Unknown or unsupported base family';
 if(!['SDXL 1.0','Illustrious'].includes(version.baseModel))return 'Requires a different generation workflow';
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
