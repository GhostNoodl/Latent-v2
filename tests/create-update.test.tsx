// @vitest-environment jsdom
import { act, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFT, DEFAULT_SETTINGS } from '../src/shared/defaults';
import { draftSchema, settingsSchema } from '../src/shared/validation';
import { applyHiresPreset, augmentHiresWorkflow, editHiresSettings, followHiresScale } from '../src/shared/advanced-image-workflow';
import type { HiresFixSettings } from '../src/shared/advanced-image-types';
import { SizePresets } from '../src/renderer/SizePresets';
import { useDismissiblePanel } from '../src/renderer/useDismissiblePanel';
const hires: HiresFixSettings = { method:'latent', workflowVersion:'sdxl-hires-latent@1', width:1536, height:1536, steps:16, cfg:4, sampler:'euler', scheduler:'normal', denoise:0.35, seed:'1' };
describe('0.2 authoring preferences', () => {
 it('restores old settings and accepts new accents and user sizes', () => {
   const old = {...DEFAULT_SETTINGS}; delete old.sizePresets;
   expect(settingsSchema.parse(old).accent).toBe('iris');
   expect(settingsSchema.parse({...old, accent:'amber', sizePresets:[{name:'My portrait',width:768,height:1344}]}).sizePresets).toHaveLength(1);
   expect(settingsSchema.safeParse({...old,sizePresets:[{name:'same',width:512,height:512},{name:'SAME',width:512,height:768}]}).success).toBe(false);
   expect(settingsSchema.safeParse({...old,sizePresets:[{name:'bad',width:513,height:768}]}).success).toBe(false);
 });
 it('updates linked hires dimensions without rewriting fixed historic recipes', () => {
   expect(followHiresScale(hires,768,1344)).toBe(hires);
   const linked=followHiresScale({...hires,scaleFactor:1.5},768,1344);
   expect(linked).toMatchObject({width:1152,height:2016,scaleFactor:1.5,workflowVersion:undefined});
   expect(draftSchema.parse({...DEFAULT_DRAFT,hiresFix:linked}).hiresFix?.scaleFactor).toBe(1.5);
   expect(followHiresScale({...hires,scaleFactor:2},0,1024).width).toBe(1536);
 });
});
it('closes activity on outside click and Escape without breaking its toggle',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 function Panel(){const [open,setOpen]=useState(false);useDismissiblePanel(open,useCallback(()=>setOpen(false),[]),'.toggle,.panel');return <><button className="toggle" onClick={()=>setOpen(!open)}>Toggle</button>{open&&<section className="panel"><button>Inside</button></section>}<button className="outside">Outside</button></>;}
 const click=async(selector:string)=>act(async()=>{const el=host.querySelector(selector)!;el.dispatchEvent(new Event('pointerdown',{bubbles:true}));(el as HTMLElement).click();});
 try{await act(async()=>root.render(<Panel/>));await click('.toggle');expect(host.querySelector('.panel')).not.toBeNull();await click('.panel button');expect(host.querySelector('.panel')).not.toBeNull();await click('.toggle');expect(host.querySelector('.panel')).toBeNull();await click('.toggle');await click('.outside');expect(host.querySelector('.panel')).toBeNull();await click('.toggle');await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(host.querySelector('.panel')).toBeNull();}finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it('keeps edited size presets available when saving fails and can retry',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const save=vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValueOnce(undefined),choose=vi.fn();
 const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
 try{await act(async()=>root.render(<SizePresets sizes={[{name:'Personal',width:768,height:1344}]} width={1024} height={1024} onChoose={choose} onSave={save}/>));await act(async()=>button('Personal').click());expect(choose).toHaveBeenCalledWith({name:'Personal',width:768,height:1344});await act(async()=>button('Edit sizes').click());await act(async()=>button('Save sizes').click());expect(host.querySelector('[role="alert"]')?.textContent).toContain('try again');expect(host.querySelector('input')?.value).toBe('Personal');await act(async()=>button('Save sizes').click());expect(host.querySelector('[role="dialog"]')).toBeNull();expect(save).toHaveBeenCalledTimes(2);}finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

 it('gentle hires deliberately removes aggressive settings but preserves the saved recipe', () => {
   const original={...hires, interpolation:'nearest-exact' as const, denoise:.6, sampler:'euler_ancestral',scaleFactor:1.5};
   const gentle=applyHiresPreset(original,'gentle');
   expect(gentle).toMatchObject({method:'image',denoise:.2,sampler:'dpmpp_2m',scheduler:'karras',width:1536,height:1536,seed:'1',scaleFactor:1.5});
   expect(gentle.interpolation).toBeUndefined(); expect(gentle.workflowVersion).toBeUndefined();
   expect(original).toMatchObject({method:'latent',denoise:.6,interpolation:'nearest-exact',workflowVersion:'sdxl-hires-latent@1'});
   expect(applyHiresPreset(original,'resize').denoise).toBe(0);
   expect(editHiresSettings(original,{method:'image'}).interpolation).toBeUndefined();
   expect(editHiresSettings(original,{denoise:.2}).interpolation).toBe('nearest-exact');
 });

it('gentle hires refines saved image pixels, and resize-only cannot run a second sampler',()=>{
 const graph: import('../src/shared/types').ComfyWorkflow={
 '1':{class_type:'CheckpointLoaderSimple',inputs:{}},'2':{class_type:'CLIPTextEncode',inputs:{}},'3':{class_type:'CLIPTextEncode',inputs:{}},'4':{class_type:'EmptyLatentImage',inputs:{}},
 '5':{class_type:'KSampler',inputs:{model:['1',0],positive:['2',0],negative:['3',0],latent_image:['4',0],seed:1,steps:20,cfg:4,sampler_name:'euler',scheduler:'normal',denoise:1}},
 '6':{class_type:'VAEDecode',inputs:{samples:['5',0],vae:['1',2]}},'7':{class_type:'SaveImage',inputs:{images:['6',0],filename_prefix:'Latent_test'}}
 };
 const gentle=augmentHiresWorkflow(graph,DEFAULT_DRAFT,applyHiresPreset(hires,'gentle'),'1');
 expect(Object.values(gentle.workflow).filter(n=>n.class_type==='LatentUpscale')).toHaveLength(0);
 expect(Object.values(gentle.workflow).find(n=>n.class_type==='ImageScale')?.inputs).toMatchObject({image:['7',0],upscale_method:'lanczos'});
 expect(gentle.passes[1]).toMatchObject({enabled:true,denoise:.2,sampler:'dpmpp_2m',scheduler:'karras'});
 const resize=augmentHiresWorkflow(graph,DEFAULT_DRAFT,applyHiresPreset(hires,'resize'),'1');
 expect(Object.values(resize.workflow).filter(n=>n.class_type==='KSampler')).toHaveLength(1);
 expect(resize.passes[1]).toMatchObject({enabled:false,nodeId:null});expect(resize.outputs).toHaveLength(2);
});

it('offers face setup directly in Create and follows progress, cancellation, retry and readiness',async()=>{
 const {AutomaticFaceControls}=await import('../src/renderer/AutomaticFaceControls');
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const setup=vi.fn().mockResolvedValue(undefined),cancel=vi.fn().mockResolvedValue(undefined),change=vi.fn();
 vi.stubGlobal('latent',{setupFaceDetailer:setup,cancelFaceDetailerSetup:cancel});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const run=async(_key:string,task:()=>Promise<unknown>)=>{await task();return true;};
 const render=async(state:import('../src/shared/face-detailer-types').FaceDetailerStatus['state'],enabled=false)=>act(async()=>root.render(<AutomaticFaceControls draft={{...DEFAULT_DRAFT,autoFace:enabled?{profile:'illustrated',strength:.3}:undefined}} status={{state,message:'Setup failed. Try again.',device:'cpu',experimental:true,logTail:[],installProgress:42}} onChange={change} run={run}/>));
 try {
  await render('not-installed');expect(host.textContent).not.toContain('Settings');expect(host.querySelector('input')?.disabled).toBe(true);
  await act(async()=>host.querySelector('button')!.click());expect(setup).toHaveBeenCalledWith(false);
  await render('installing');expect(host.querySelector('progress')?.value).toBe(42);await act(async()=>host.querySelector('button')!.click());expect(cancel).toHaveBeenCalledOnce();
  await render('error',true);expect(host.querySelector('[role="alert"]')?.textContent).toContain('Setup failed');expect(host.querySelector('input')?.disabled).toBe(false);
  await act(async()=>host.querySelector('input')!.click());expect(change).toHaveBeenCalledWith({autoFace:undefined});
  await act(async()=>host.querySelector('button')!.click());expect(setup).toHaveBeenLastCalledWith(true);
  await render('ready');expect(host.querySelector('button')).toBeNull();await act(async()=>host.querySelector('input')!.click());expect(change).toHaveBeenLastCalledWith({autoFace:{profile:'illustrated',strength:.45,classic:true,applyLoras:false,steps:20,cfg:7,sampler:'euler',scheduler:'normal'}});
 } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it('Classic hires links seed and CFG and protects larger scales without changing old recipes',async()=>{
 const {resolveClassicHires}=await import('../src/shared/advanced-image-workflow');
 const classic=applyHiresPreset(hires,'classic');expect(classic).toMatchObject({classic:true,method:'latent',interpolation:'nearest-exact',sampler:'euler',scheduler:'simple',denoise:.5});
 const base={width:1024,height:1024,cfg:6};
 expect(resolveClassicHires({...classic,width:2048,height:2048,denoise:.7},base,'42')).toMatchObject({cfg:6,seed:'42',denoise:.4});
 expect(resolveClassicHires({...classic,width:1536,height:1536,denoise:.6},base,'42').denoise).toBe(.6);
 expect(resolveClassicHires(hires,base,'42')).toBe(hires);
 expect(applyHiresPreset(classic,'gentle').classic).toBe(false);
});


it('enables hires with candidate pixel resizing and encodes the resized base',async()=>{
 const {AdvancedImageControls}=await import('../src/renderer/AdvancedImageControls');
 const {buildWorkflow}=await import('../src/shared/workflow');
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host),change=vi.fn();
 const draft={...DEFAULT_DRAFT,checkpointId:'checkpoint:test.safetensors'};
 try{
  await act(async()=>root.render(<AdvancedImageControls draft={draft} snapshot={{sourceImages:{sources:[]},faceDetailer:{state:'ready'}} as any} onChange={change} run={vi.fn()}/>));
  const label=[...host.querySelectorAll('label')].find(l=>l.textContent?.includes('Hires fix'))!;
  await act(async()=>(label.querySelector('input') as HTMLInputElement).click());
  const settings=change.mock.calls[0][0].hiresFix;
  expect(settings).toMatchObject({method:'image',denoise:.3,steps:20,sampler:'euler',scheduler:'simple'});
  const base=buildWorkflow(draft,[{id:draft.checkpointId,kind:'checkpoint',family:draft.family,filename:'test.safetensors',status:'ready'}] as any,'42','candidate-test');
  const graph=augmentHiresWorkflow(base,draft,settings,'42').workflow;
  expect(Object.values(graph).some(n=>n.class_type==='LatentUpscale')).toBe(false);
  const encode=Object.values(graph).find(n=>n.class_type==='VAEEncode')!;
  const resize=graph[(encode.inputs.pixels as [string,number])[0]];
  expect(resize).toMatchObject({class_type:'ImageScale',inputs:{upscale_method:'lanczos',image:['7',0]}});
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});


it('routes SDXL sampling overrides through the base and hires samplers',async()=>{
 const {buildWorkflow}=await import('../src/shared/workflow');
 const draft={...DEFAULT_DRAFT,checkpointId:'checkpoint:test.safetensors',modelSampling:{prediction:'v_prediction' as const,zeroTerminalSnr:true}};
 const asset={id:draft.checkpointId,kind:'checkpoint',family:draft.family,filename:'test.safetensors',status:'ready'} as any;
 const graph=buildWorkflow(draft,[asset],'42','variant');
 expect(graph['49']).toEqual({class_type:'ModelSamplingDiscrete',inputs:{model:['1',0],sampling:'v_prediction',zsnr:true}});
 const hiresGraph=augmentHiresWorkflow(graph,draft,{...hires,method:'image',workflowVersion:undefined,seed:'42'},'42').workflow;
 for(const node of Object.values(hiresGraph).filter(n=>n.class_type==='KSampler'))expect(node.inputs.model).toEqual(['49',0]);
 const legacy=buildWorkflow({...draft,modelSampling:undefined},[asset],'42','variant');expect(legacy['49']).toBeUndefined();expect(legacy['5'].inputs.model).toEqual(['1',0]);
});

it('validates sampling overrides without accepting a changed prediction mode',async()=>{
 const {buildWorkflow,samplingValidationGraph}=await import('../src/shared/workflow');
 const draft={...DEFAULT_DRAFT,checkpointId:'checkpoint:test.safetensors',modelSampling:{prediction:'v_prediction' as const,zeroTerminalSnr:true}};
 const graph=buildWorkflow(draft,[{id:draft.checkpointId,kind:'checkpoint',family:draft.family,filename:'test.safetensors',status:'ready'}] as any,'42','test');
 expect(samplingValidationGraph(graph,draft)['49']).toBeUndefined();expect(graph['49']).toBeDefined();
 graph['49'].inputs.sampling='eps';expect(()=>samplingValidationGraph(graph,draft)).toThrow('sampling override');
});

it.each([['illustrious','sdxl'],['sdxl','illustrious']] as const)('loads a %s checkpoint with a %s LoRA', async (family,loraFamily)=>{
 const {buildWorkflow}=await import('../src/shared/workflow');
 const checkpoint={id:'checkpoint',kind:'checkpoint',family,filename:'base.safetensors',status:'ready',sha256:'a'.repeat(64),triggers:[]} as any;
 const lora={id:'lora',name:'Pixel Art XL',kind:'lora',family:loraFamily,filename:'pixel.safetensors',status:'ready',sha256:'b'.repeat(64),triggers:[]} as any;
 const draft={...DEFAULT_DRAFT,family,checkpointId:'checkpoint',loras:[{modelId:'lora',weight:0.7,clipWeight:0.8}]};
 const graph=buildWorkflow(draft,[checkpoint,lora],'42','compatibility');
 expect(Object.values(graph).find(node=>node.class_type==='LoraLoader')?.inputs).toMatchObject({lora_name:'pixel.safetensors',strength_model:0.7,strength_clip:0.8});
 expect(()=>buildWorkflow(draft,[checkpoint,{...lora,family:'unknown'}],'42','unknown')).toThrow('family');
 expect(()=>buildWorkflow(draft,[checkpoint,{...lora,status:'missing'}],'42','missing')).toThrow('missing');
});

it('allows an SDXL LoRA in the Illustrious picker while blocking unknown, missing and selected assets',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const {ModelPicker}=await import('../src/renderer/ModelPicker');
 const base={id:'pixel',name:'Pixel Art XL',kind:'lora',family:'sdxl',status:'ready',bytes:200000000,triggers:[]} as any;
 const snapshot={models:[base,{...base,id:'unknown',name:'Unknown',family:'unknown'},{...base,id:'missing',name:'Missing',status:'missing'},{...base,id:'selected',name:'Selected'}],history:[],collections:{collections:[]},settings:{civitaiDisplayMetadata:false}} as any;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const choose=vi.fn();
 try{
 await act(async()=>root.render(<ModelPicker snapshot={snapshot} kind="lora" family="illustrious" selectedIds={['selected']} onChoose={choose} onClose={()=>{}}/>));
 const cards=[...document.querySelectorAll<HTMLButtonElement>('.visual-model-card')];
 const pixel=cards.find(b=>b.textContent?.includes('Pixel Art XL'))!;
 expect(pixel.disabled).toBe(false);await act(async()=>pixel.click());expect(choose).toHaveBeenCalledWith(base);
 for(const name of ['Unknown','Missing','Selected'])expect(cards.find(b=>b.textContent?.includes(name))?.disabled).toBe(true);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

it.each(['lora','checkpoint'] as const)('filters the Create %s picker with folder buttons',async kind=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const {ModelPicker}=await import('../src/renderer/ModelPicker');
 const model={id:'m',name:'Example',kind,family:'sdxl',status:'ready',bytes:100,triggers:[]} as any;
 const snapshot={models:[model,{...model,id:'other',name:'Other',kind:kind==='lora'?'checkpoint':'lora'}],history:[],settings:{civitaiDisplayMetadata:false},collections:{collections:[{id:'styles',kind:'model',name:'Styles',memberIds:['m']},{id:'empty',kind:'model',name:'Empty',memberIds:[]}]}} as any;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const folder=(name:string)=>[...host.querySelectorAll<HTMLButtonElement>('.picker-folders button')].find(b=>b.textContent?.includes(name))!;
 try{await act(async()=>root.render(<ModelPicker snapshot={snapshot} kind={kind} family="illustrious" selectedIds={[]} onChoose={()=>{}} onClose={()=>{}}/>));
 expect(folder('Styles').textContent).toBe('Styles1');
 await act(async()=>folder('Empty').click());expect(host.querySelectorAll('.visual-model-card')).toHaveLength(0);
 await act(async()=>folder('Styles').click());expect(host.querySelectorAll('.visual-model-card')).toHaveLength(1);
 expect(folder('Styles').getAttribute('aria-pressed')).toBe('true');
 await act(async()=>folder('All ').click());expect(host.querySelectorAll('.visual-model-card')).toHaveLength(1);
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
