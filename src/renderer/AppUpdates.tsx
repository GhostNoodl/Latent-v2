import type { AppUpdateStatus,AppUpdateSettings } from '../shared/app-update-types';
import { Toggle } from './ui';
export function AppUpdates({status,busy,onSettings,onCheck,onDownload,onInstall,onCancel}:{status:AppUpdateStatus;busy:boolean;onSettings(value:Partial<AppUpdateSettings>):void;onCheck():void;onDownload():void;onInstall():void;onCancel():void}){
 const active=busy||status.state==='checking'||status.state==='downloading';
 return <section className="settings-card"><h2>App updates</h2><p>Installed version {status.currentVersion}. Updates keep your studio data and models.</p><p role="status">{status.message}</p>
 {status.supported&&<fieldset className="app-update-options" disabled={active}><Toggle label="Check automatically for stable releases" checked={status.settings.checkAutomatically} onChange={checkAutomatically=>onSettings({checkAutomatically})}/>
 {status.settings.checkAutomatically&&<Toggle label="Download updates automatically" checked={status.settings.downloadAutomatically} onChange={downloadAutomatically=>onSettings({downloadAutomatically})}/>}
 {status.settings.downloadAutomatically&&<Toggle label="Close and install when studio work finishes" checked={status.settings.installWhenIdle} onChange={installWhenIdle=>onSettings({installWhenIdle})}/>}</fieldset>}
 {status.progress!==undefined&&status.state==='downloading'&&<progress max={100} value={status.progress} aria-label="Update download"/>}
 <div className="button-row"><button disabled={active||status.installRequested} onClick={onCheck}>Check for updates</button>{status.supported&&status.release&&status.state!=='ready'&&<button disabled={active} onClick={onDownload}>Download {status.release.version}</button>}{status.state==='ready'&&<button className="primary" disabled={active||status.installRequested} onClick={onInstall}>Save, close and install</button>}{(status.installRequested||status.state==='downloading')&&<button onClick={onCancel}>{status.installRequested?'Postpone installation':'Cancel download'}</button>}</div>
 </section>;
}
