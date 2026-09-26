import fs from 'node:fs/promises';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { APP_RELEASE_API,DEFAULT_APP_UPDATE_SETTINGS,appUpdateSettingsSchema,parseAppRelease,type AppUpdateSettings,type AppUpdateStatus,type AppRelease } from '../shared/app-update-types';
interface Store {getState<T>(key:string,fallback:T):T;setState(key:string,value:unknown):void;}
const describe=(error:unknown)=>error instanceof Error?error.message:String(error);
export class AppUpdateService {
 private value:AppUpdateStatus;private task?:Promise<void>;private abort?:AbortController;private file?:string;private disposed=false;private nextCheck=0;private postponed?:string;
 constructor(private root:string,private store:Store,currentVersion:string,supported:boolean,private changed:()=>void,private request:typeof fetch=fetch){
  const saved=appUpdateSettingsSchema.safeParse(store.getState('app-updates.settings',DEFAULT_APP_UPDATE_SETTINGS));
  this.value={currentVersion,supported,settings:saved.success?saved.data:DEFAULT_APP_UPDATE_SETTINGS,state:'idle',message:supported?'Check for a new Latent version.':'In-app installation is available in the installed Windows app. Development and portable copies are not replaced.',installRequested:false};
 }
 status(){return structuredClone(this.value);}
 private update(patch:Partial<AppUpdateStatus>){Object.assign(this.value,patch);this.changed();}
 settings(input:Partial<AppUpdateSettings>){const next=appUpdateSettingsSchema.parse({...this.value.settings,...appUpdateSettingsSchema.partial().parse(input)});if(!next.checkAutomatically){next.downloadAutomatically=false;next.installWhenIdle=false;}if(!next.downloadAutomatically)next.installWhenIdle=false;if(input.installWhenIdle===true)this.postponed=undefined;this.store.setState('app-updates.settings',next);this.update({settings:next,installRequested:false});}
 private async run(state:'checking'|'downloading',operation:(signal:AbortSignal)=>Promise<void>){
  if(this.disposed||this.task)throw Error('Wait for the current update operation to finish.');const controller=new AbortController();this.abort=controller;this.update({state,message:state==='checking'?'Checking for updates…':'Downloading update…',progress:undefined,installRequested:false});
  this.task=operation(controller.signal).catch(error=>{this.update({state:'error',message:controller.signal.aborted?'Update cancelled. Your installed app is unchanged.':describe(error),progress:undefined});throw error;}).finally(()=>{this.task=undefined;this.abort=undefined;});await this.task;
 }
 private async response(url:string,signal:AbortSignal){
  for(let hop=0;hop<5;hop++){
   const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(parsed.hostname))throw Error('The update download left GitHub’s release servers.');
   const response=await this.request(url,{redirect:'manual',headers:{'User-Agent':'Latent-v2-updater','Accept':parsed.hostname==='api.github.com'?'application/vnd.github+json':'application/octet-stream'},signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
   if([301,302,303,307,308].includes(response.status)){const next=response.headers.get('location');await response.body?.cancel();if(!next)throw Error('The update redirect was incomplete.');url=new URL(next,url).href;continue;}
   if(!response.ok){await response.body?.cancel();throw Error(response.status===404?'The public release feed or installer is unavailable. Try again later.':response.status===403||response.status===429?'GitHub is limiting update requests. Try again later.':`Update request failed (${response.status}).`);}return response;
  }throw Error('The update download redirected too many times.');
 }
 async check(){this.nextCheck=Date.now()+24*60*60_000;await this.run('checking',async signal=>{
  const response=await this.response(APP_RELEASE_API,signal);const chunks:Uint8Array[]=[];let bytes=0;if(!response.body)throw Error('Empty release response.');for await(const chunk of response.body){bytes+=chunk.length;if(bytes>2*1024*1024)throw Error('The release response is too large.');chunks.push(chunk);}
  const release=parseAppRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')),this.value.currentVersion);this.file=undefined;
  this.update({release,lastChecked:new Date().toISOString(),state:release?'available':'idle',message:release?`Latent ${release.version} is available.`:'You have the latest stable version.'});
 });}
 private async directory(){const dir=path.join(this.root,'app-updates');await fs.mkdir(dir,{recursive:true});const root=await fs.realpath(this.root);if((await fs.lstat(dir)).isSymbolicLink()||await fs.realpath(dir)!==path.join(root,'app-updates'))throw Error('The update cache must be a regular studio folder.');return dir;}
 private async verify(file:string,release:AppRelease){const dir=await this.directory();if(path.dirname(file)!==dir)throw Error('The update file is outside its cache.');const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==release.bytes)throw Error('The downloaded installer changed. Download it again.');const handle=await fs.open(file,'r');try{const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);if(hash.digest('hex')!==release.sha256)throw Error('The installer checksum does not match its release.');}finally{await handle.close();}}
 async download(){if(!this.value.supported)throw Error('Use the installed Windows app for in-app updates.');const release=this.value.release;if(!release)throw Error('Check for a newer release first.');await this.run('downloading',async signal=>{
  const dir=await this.directory(),file=path.join(dir,release.name),temp=path.join(dir,`${randomUUID()}.part`);let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
  try {await fs.lstat(file);await this.verify(file,release);signal.throwIfAborted();this.file=file;this.update({state:'ready',progress:100,message:'Update downloaded and verified. Install when you are ready.'});return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){signal.throwIfAborted();const old=await fs.lstat(file);if(!old.isFile()||old.isSymbolicLink()||old.nlink!==1)throw error;await fs.rename(file,path.join(dir,`${release.name}.invalid-${randomUUID()}`));}}
  try{const disk=await fs.statfs(dir);if(disk.bavail*disk.bsize<release.bytes*2+128*1024*1024)throw Error('Free some disk space before downloading this update.');const response=await this.response(release.url,signal);if(!response.body)throw Error('Empty installer response.');handle=await fs.open(temp,'wx');let received=0,last=-1;const hash=createHash('sha256');for await(const chunk of response.body){signal.throwIfAborted();received+=chunk.length;if(received>release.bytes)throw Error('Installer size does not match the release.');hash.update(chunk);await handle.writeFile(chunk);const progress=Math.floor(received/release.bytes*100);if(progress!==last){last=progress;this.update({progress});}}
   await handle.close();handle=undefined;if(received!==release.bytes||hash.digest('hex')!==release.sha256)throw Error('The installer download is incomplete or its checksum differs.');signal.throwIfAborted();await fs.copyFile(temp,file,fs.constants.COPYFILE_EXCL);await fs.unlink(temp);await this.verify(file,release);signal.throwIfAborted();this.file=file;this.update({state:'ready',progress:100,message:'Update downloaded and verified. Install when you are ready.'});
  }finally{await handle?.close();await fs.unlink(temp).catch(()=>{});}
 });}
 requestInstall(){this.postponed=undefined;if(!this.value.supported||this.value.state!=='ready'||!this.file)throw Error('Download and verify an update first.');this.update({installRequested:true,message:'Installation requested. Waiting for the studio to finish its work.'});}
 cancelInstall(message='Installation postponed. Your update is still downloaded.'){this.postponed=this.value.release?.version;this.update({installRequested:false,message});}
 async installer(){if(!this.value.installRequested||!this.file||!this.value.release)throw Error('No verified installation was requested.');try{await this.verify(this.file,this.value.release);return this.file;}catch(error){this.update({state:'error',installRequested:false,message:describe(error)});throw error;}}
 async automatic(){if(this.disposed||this.task||!this.value.supported)return;const settings=this.value.settings;if(settings.checkAutomatically&&Date.now()>=this.nextCheck)await this.check();if(this.value.settings.downloadAutomatically&&this.value.state==='available')await this.download();if(this.value.settings.installWhenIdle&&this.value.state==='ready'&&!this.value.installRequested&&this.postponed!==this.value.release?.version)this.requestInstall();}
 async cancel(){this.abort?.abort();await this.task?.catch(()=>{});if(this.value.installRequested)this.cancelInstall();}
 async dispose(){this.disposed=true;await this.cancel();}
}
