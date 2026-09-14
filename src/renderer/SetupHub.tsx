import { useEffect, useRef, useState } from 'react';

import type { AppSnapshot } from '../shared/types';

import { setupCards, type SetupCapability, type SetupPreflight } from '../shared/setup';

import { actionErrorMessage } from '../shared/action-error';

import { Modal, Notice, bytes } from './ui';

import './setup.css';

export function SetupHub({ snapshot, receive, onClose, onModels, onSettings, onCreate, onEdit, onVideo }: { snapshot: AppSnapshot; receive(s:AppSnapshot):void; onClose():void; onModels():void; onSettings():void; onCreate():void; onEdit():void; onVideo():void }) {

  const [review,setReview] = useState<SetupPreflight>();

  const [busy,setBusy] = useState<SetupCapability>();

  const [checking,setChecking] = useState(false);

  const [error,setError] = useState('');

  const serial = useRef(0);

  const reviewRegion = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!review) return;
    reviewRegion.current?.focus({ preventScroll: true });
    reviewRegion.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [review]);

  async function check(id:SetupCapability) { const current=++serial.current; setChecking(true);setError('');setReview(undefined);try {const next=await window.latent.getSetupPreflight(id);if(current===serial.current)setReview(next);}catch(e){setError(actionErrorMessage(e));}finally{if(current===serial.current)setChecking(false);} }

  async function install() { if(!review || busy)return;setBusy(review.capability);setError('');try {await window.latent.runGuidedSetup(review.capability);receive(await window.latent.getSnapshot());setReview(undefined);}catch(e){setError(actionErrorMessage(e));}finally{setBusy(undefined);} }

  async function cancel() { try {if(busy==='engine')await window.latent.stopBackend();else if(busy==='edit')await window.latent.cancelQwenEditSetup();else if(busy==='video')await window.latent.cancelVideoAssetSetup();else if(busy==='images')for(const d of snapshot.downloads.filter(d=>d.name==='Illustrious-XL-v1.1.safetensors' && ['downloading','verifying'].includes(d.state)))await window.latent.cancelDownload(d.id);}catch(e){setError(actionErrorMessage(e));} }

  const leave=(action:()=>void)=>{serial.current++;onClose();action();};

  const cards=setupCards(snapshot);

  return <Modal title="Set up your studio" onClose={()=>{if(!busy){serial.current++;onClose();}}}><div className="setup-hub">

    <p>Choose what you want to make. Latent installs its own tools and reuses components you already have.</p>

    <div className="button-row"><button disabled={!!busy} onClick={()=>leave(onSettings)}>Choose storage / advanced settings</button><button disabled={!!busy} onClick={()=>leave(onModels)}>Use my existing models</button></div>

    <div className="setup-cards">{cards.map(card=><section key={card.id} className="setup-card"><h3>{card.title}</h3><strong>{card.ready?'Ready':busy===card.id?'Setting up…':review?.capability===card.id&&review.blockers.length?'Needs attention':'Needs setup'}</strong><p>{card.message}</p><ul>{card.requirements.map(item=><li key={item}>{item}</li>)}</ul>{card.ready?<button disabled={!!busy} onClick={()=>leave(card.id==='video'?onVideo:card.id==='images'?onCreate:card.id==='edit'?onEdit:onSettings)}>Open</button>:<button disabled={checking||!!busy || card.id!=='engine'&&!cards[0].ready} onClick={()=>void check(card.id)}>Check setup</button>}</section>)}</div>

    <p className="small">Image setup offers Illustrious XL 1.1. Qwen uses the Base editing bundle. Video uses the fused H3 profile. Other models, faster editing profiles and optional tools remain available in their own tabs.</p>

    {checking&&<p role="status">Checking hardware and available space…</p>}{error&&<Notice error>{error}</Notice>}

    {review&&<section ref={reviewRegion} tabIndex={0} className="setup-review" aria-label="Setup review"><h3>Review before downloading</h3>{review.gpu&&<p>{review.gpu}</p>}<p>{review.capability==='engine'?'Engine download size depends on resolved packages.':`At least ${bytes(review.storage.package.minimumDownloadBytes)} left to download.`}</p>{review.storage.destinations.map(d=><p key={d.id} className="inline-path">{d.path}</p>)}{review.storage.volumes.map(v=><p key={v.id}>{v.path} · {v.availableBytes===undefined?'Space unknown':bytes(v.availableBytes)+' free'}</p>)}{review.warnings.map(w=><p key={w} className="small">{w}</p>)}{review.blockers.map(b=><Notice error key={b}>{b}</Notice>)}{review.blockers.some(b=>b.includes('driver'))&&<p>Install a current driver from NVIDIA, then return and check again.</p>}<button disabled={!!busy||review.blockers.length>0} onClick={()=>void install()}>{busy?'Setting up…':'Install missing components'}</button><button disabled={!!busy} onClick={()=>void check(review.capability)}>Check again</button></section>}

    {busy&&<div role="status"><p>{busy==='engine'?snapshot.backend.message:busy==='edit'?snapshot.qwenEdit.message:busy==='video'?snapshot.video.assets?.message:snapshot.downloads.find(d=>d.name==='Illustrious-XL-v1.1.safetensors')?.state}</p><button onClick={()=>void cancel()}>Cancel setup</button></div>}

    <p className="small">No account is required for the local engine. Optional services may ask for a key in their settings. You can return here at any time.</p>

  </div></Modal>;

}

