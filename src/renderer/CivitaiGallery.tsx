import { useState } from 'react';
import { ChevronLeft, ChevronRight, Expand, ImageOff } from 'lucide-react';
import type { CivitaiPreview } from '../shared/civitai-types';
import { Modal } from './ui';
/** Key by model/version and fetch identity so a new version starts at its first image. */
export function CivitaiGallery({previews,name}:{previews:CivitaiPreview[];name:string}) {
 const [index,setIndex]=useState(0),[expanded,setExpanded]=useState(false),[failed,setFailed]=useState<string[]>([]);
 const images=[...new Map(previews.map(p=>[p.url,p])).values()];
 const selected=images[index]??images[0];
 const move=(delta:number)=>setIndex(i=>(i+delta+images.length)%images.length);
 if(!selected)return <section className="civitai-gallery-empty"><ImageOff size={24}/><p>No creator images are available for this version.</p></section>;
 const picture=(large=false)=>failed.includes(selected.url)?<div className="civitai-gallery-empty" role="status"><ImageOff/><p>This image couldn’t load.</p><button onClick={()=>setFailed(f=>f.filter(url=>url!==selected.url))}>Retry image</button></div>:<img className={large?'civitai-gallery-large':''} src={selected.url} alt={`${name} · creator image ${index+1}`} referrerPolicy="no-referrer" onError={()=>setFailed(f=>[...new Set([...f,selected.url])])}/>;
 const controls=<div className="civitai-gallery-controls"><button aria-label="Previous creator image" disabled={images.length<2} onClick={()=>move(-1)}><ChevronLeft size={18}/></button><span aria-live="polite">{index+1} / {images.length}</span><button aria-label="Next creator image" disabled={images.length<2} onClick={()=>move(1)}><ChevronRight size={18}/></button></div>;
 return <section className="civitai-gallery" aria-label="Creator image gallery" onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();move(e.key==='ArrowLeft'?-1:1);}}}>
   <div className="civitai-gallery-stage">{picture()}</div>
   <div className="button-row">{controls}<button onClick={()=>setExpanded(true)}><Expand size={14}/>Larger view</button></div>
   {images.length>1&&<div className="civitai-gallery-thumbnails" aria-label="Choose creator image">{images.map((p,i)=><button key={p.url} aria-label={`Show creator image ${i+1}`} aria-pressed={i===index} onClick={()=>setIndex(i)}>{failed.includes(p.url)?<ImageOff size={20}/>:<img loading="lazy" src={p.url} alt="" referrerPolicy="no-referrer" onError={()=>setFailed(f=>[...new Set([...f,p.url])])}/>}</button>)}</div>}
   {expanded&&<Modal title={`${name} · creator images`} onClose={()=>setExpanded(false)}><div className="civitai-gallery-stage expanded">{picture(true)}</div>{controls}</Modal>}
 </section>;
}
