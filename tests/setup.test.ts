import { describe,it,expect } from 'vitest';
import {setupCards,setupHardwareBlockers,setupStorageBlockers} from '../src/shared/setup';
import type {AppSnapshot} from '../src/shared/types';
import type {HardwareInventory} from '../src/shared/hardware-profile-types';
import type {PackageStorageSnapshot} from '../src/shared/storage-types';
const hardware = ():HardwareInventory => ({os:'Windows_NT 10',arch:'x64',ramBytes:64*1024**3,gpus:[{index:0,uuid:'synthetic',name:'NVIDIA GeForce RTX 4060 Ti',vramMiB:16380,driver:'610.74'}],detection:'nvidia',messages:[],observedAt:'fixture',fingerprint:'fixture'});
describe('guided setup checks',()=>{
 it('checks hardware before an engine exists',()=>expect(setupHardwareBlockers(hardware(),'engine')).toEqual([]));
 it('blocks an old driver and small video GPU',()=>{const h=hardware();h.gpus[0].driver='579.99';expect(setupHardwareBlockers(h,'engine').join()).toContain('580.88');h.gpus[0].driver='610.74';h.gpus[0].vramMiB=8192;expect(setupHardwareBlockers(h,'video').join()).toContain('16 GB GPU');});
 it('does not guess a device for multiple GPUs or an unknown host',()=>{const h=hardware();h.gpus.push({...h.gpus[0],index:1});expect(setupHardwareBlockers(h,'engine').join()).toContain('single NVIDIA');h.arch='arm64';expect(setupHardwareBlockers(h,'engine').join()).toContain('Windows x64');});
 it('requires measured capacity and includes headroom',()=>{const s={package:{minimumDownloadBytes:6*1024**3},volumes:[{availableBytes:7*1024**3,minimumDownloadBytes:6*1024**3}]} as PackageStorageSnapshot;expect(setupStorageBlockers(s,'images')).toHaveLength(1);s.volumes[0].availableBytes=10*1024**3;expect(setupStorageBlockers(s,'images')).toEqual([]);s.volumes[0].availableBytes=undefined;expect(setupStorageBlockers(s,'images')[0]).toContain('could not be checked');});
 it('recognizes a full checkpoint without extra VAEs and encoders',()=>{const s={backend:{state:'ready'},models:[{kind:'checkpoint',status:'ready',family:'illustrious'}],qwenEdit:{baseReady:false},video:{canGenerate:true,assets:{fusedPresent:false}}} as unknown as AppSnapshot;expect(setupCards(s)[1].ready).toBe(true);expect(setupCards(s)[3].ready).toBe(false);expect(setupCards(s)[1].requirements.join()).toContain('included');});
});
