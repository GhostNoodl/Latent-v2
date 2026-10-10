import type {SetupActivity} from '../shared/setup-activity';
export function SetupActivityPanel({items=[],compact=false,onCopy}:{items?:SetupActivity[];compact?:boolean;onCopy?():void}){
 const visible=compact?items.filter(i=>i.state==='active'):[...items].reverse();
 if(compact&&!visible.length)return null;
 return <section className={compact?'setup-activity-strip':'settings-card'} aria-label="Download and setup activity">
 <strong>{compact?'Download / setup in progress':'Download and setup history'}</strong>
 {!compact&&<><p>Files and Python dependencies prepared by Latent. Share the relevant entry with the Windows warning. Paths may include your Windows username.</p><button onClick={onCopy} disabled={!items.length}>Copy diagnostic history</button></>}
 {visible.slice(0,compact?3:30).map(item=><details key={item.id}><summary>{item.name} · {item.state}{item.progress!==undefined&&item.state==='active'?' · '+Math.round(item.progress)+'%':''}</summary><p>{item.message}</p>{!compact&&item.details&&<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:200,overflow:'auto'}}>{item.details}</pre>}<p>Source: {item.source}</p><p>Destination: {item.destination}</p><p>Started: {new Date(item.at).toLocaleString()} · Updated: {new Date(item.updatedAt).toLocaleString()}</p></details>)}
 {!visible.length&&!compact&&<p>No download or setup activity recorded yet.</p>}
 </section>;
}
