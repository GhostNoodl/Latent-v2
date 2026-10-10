import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {SetupActivity} from '../shared/setup-activity';
export function redactSetupText(value:string):string {
 return value.replace(/https?:\/\/[^\s"'<>]+/g,raw=>{try{const u=new URL(raw);return u.origin+u.pathname;}catch{return '[URL]';}}).replace(/(Bearer\s+)[^\s]+/gi,'$1[redacted]').slice(-2000);
}
let filename:string|undefined, changed=()=>{}, entries:SetupActivity[]=[];
function persist(item:SetupActivity){
 if(!filename)return;
 try{if(fs.existsSync(filename)&&fs.statSync(filename).size>2*1024*1024)fs.renameSync(filename,filename+'.previous');
 fs.appendFileSync(filename,JSON.stringify(item)+'\n');}catch{/* Diagnostics must never interrupt setup. */}
}
export function configureSetupActivity(logs:string,onChange:()=>void){
 fs.mkdirSync(logs,{recursive:true});filename=path.join(logs,'download-setup.jsonl');changed=onChange;
 try{const text=fs.readFileSync(filename,'utf8');const latest=new Map<string,SetupActivity>();for(const line of text.split('\n'))try{const item=JSON.parse(line) as SetupActivity;if(item.id&&item.at)latest.set(item.id,item);}catch{}
 entries=[...latest.values()].slice(-100).map(item=>item.state==='active'?{...item,state:'interrupted',message:'The app stopped before this operation reported completion.'}:item);
 for(const item of entries)if(item.state==='interrupted')persist(item);
 }catch{entries=[];}
}
export function setupActivitySnapshot(){return structuredClone(entries);}
export function beginSetupActivity(name:string,source:string,destination:string){
 const now=new Date().toISOString();const item:SetupActivity={id:randomUUID(),at:now,updatedAt:now,name,source:redactSetupText(source),destination,state:'active',message:'Preparing…'};
 entries=[...entries.filter(e=>e.state==='active'),...entries.filter(e=>e.state!=='active').slice(-99),item];persist(item);changed();
 let last=0;
 return {
 progress(message:string,progress?:number){item.message=redactSetupText(message);item.progress=progress;item.updatedAt=new Date().toISOString();if(Date.now()-last>500){last=Date.now();changed();}},
 note(message:string){item.details=((item.details??'')+'\n'+redactSetupText(message)).slice(-12000);item.message=redactSetupText(message);item.updatedAt=new Date().toISOString();persist(item);changed();},
 finish(state:SetupActivity['state'],message:string){item.state=state;item.message=redactSetupText(message);item.updatedAt=new Date().toISOString();persist(item);changed();}
 };
}
