import { z } from 'zod';
export const appUpdateSettingsSchema=z.object({checkAutomatically:z.boolean(),downloadAutomatically:z.boolean(),installWhenIdle:z.boolean()}).strict();
export type AppUpdateSettings=z.infer<typeof appUpdateSettingsSchema>;
export const DEFAULT_APP_UPDATE_SETTINGS:AppUpdateSettings={checkAutomatically:false,downloadAutomatically:false,installWhenIdle:false};
export interface AppRelease {version:string;url:string;name:string;bytes:number;sha256:string;}
export interface AppUpdateStatus {currentVersion:string;supported:boolean;settings:AppUpdateSettings;state:'idle'|'checking'|'available'|'downloading'|'ready'|'error';message:string;release?:AppRelease;progress?:number;installRequested:boolean;lastChecked?:string;}
export const APP_RELEASE_API='https://api.github.com/repos/GhostNoodl/Latent-v2/releases/latest';
const version=(value:string)=>{if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)||value.length>32)throw Error('The release version is not a stable version.');return value.split('.').map(BigInt);};
export function newerVersion(candidate:string,current:string){const a=version(candidate),b=version(current);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return false;}
/** The repository, stable channel, installer name and digest are fixed boundaries, not renderer input. */
export function parseAppRelease(input:unknown,current:string):AppRelease|undefined {
 const data=z.object({tag_name:z.string().max(40),draft:z.boolean(),prerelease:z.boolean(),assets:z.array(z.object({name:z.string().max(200),size:z.number().int().nonnegative(),digest:z.string().nullable().optional(),browser_download_url:z.string().max(1000)})).max(100)}).parse(input);
 if(data.draft||data.prerelease)throw Error('Only published stable releases can update this app.');
 const v=data.tag_name.replace(/^v/,'');if(!newerVersion(v,current))return;
 const name=`Latent-v2-${v}-Setup-x64-unsigned.exe`,assets=data.assets.filter(a=>a.name===name);
 if(assets.length!==1)throw Error('This release does not have one supported Windows installer.');const asset=assets[0];if(asset.size<1||asset.size>1024**3)throw Error('The Windows installer exceeds its supported size.');
 const url=`https://github.com/GhostNoodl/Latent-v2/releases/download/${data.tag_name}/${name}`;
 if(asset.browser_download_url!==url||!/^sha256:[a-f0-9]{64}$/.test(asset.digest??''))throw Error('The release installer is missing its verified download identity.');
 return {version:v,url,name,bytes:asset.size,sha256:asset.digest!.slice(7)};
}
