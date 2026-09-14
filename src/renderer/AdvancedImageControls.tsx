import { PackageSetupStorage } from './PackageSetupStorage';
import type { AppSnapshot, GenerationDraft } from '../shared/types';
import type { HiresFixSettings } from '../shared/advanced-image-types';
import { editHiresSettings, suggestedHiresDimensions, suggestedUpscaleDimensions } from '../shared/advanced-image-workflow';
import { SAMPLERS, SCHEDULERS } from '../shared/defaults';
import { Field, Notice, Toggle, type RunAction } from './ui';

export function AdvancedImageControls({ draft, snapshot, onChange, run }: { draft: GenerationDraft; snapshot: AppSnapshot; onChange: (change: Partial<GenerationDraft>) => void; run: RunAction }) {
  const hires = draft.hiresFix; const upscale = draft.upscale;
  const updateHires = (change: Partial<HiresFixSettings>) => { if (hires) onChange({ hiresFix: editHiresSettings(hires, change) }); };
  const enableHires = () => onChange({ upscale: undefined, hiresFix: { method: 'image', ...suggestedHiresDimensions(draft.width, draft.height), steps: 16, cfg: draft.cfg, sampler: draft.sampler, scheduler: draft.scheduler, denoise: 0.35, seed: 'random' } });
  const source = snapshot.sourceImages.sources.find(source => source.id === draft.imageInput?.sourceId);
  return <section className="advanced-image-controls"><details open={Boolean(hires || upscale)}><summary>Upscale and refine</summary>
    <p className="muted small">Keep a source image, enlarge it, or add a second generation pass.</p>
    <Toggle label="Resize or enhance a source" checked={Boolean(upscale)} onChange={enabled => {
      if (!enabled) onChange({ upscale: undefined });
      else onChange({ hiresFix: undefined, upscale: { mode: 'resize', ...suggestedUpscaleDimensions(source?.normalized.width ?? draft.width, source?.normalized.height ?? draft.height), resize: 'stretch' }, ...(draft.imageInput ? { imageInput: { ...draft.imageInput, crop: undefined, cropPlan: undefined, mode: 'img2img' as const } } : {}), batchSize: 1 });
    }} />
    {upscale && <div className="advanced-image-options">
      {!source && <Notice error>Choose a source image above before resizing.</Notice>}
      <Field label="Enlargement method"><select value={upscale.mode} onChange={event => onChange({ upscale: { ...upscale, mode: event.target.value as 'resize' | 'learned' } })}><option value="resize">Simple resize · Lanczos</option><option value="learned">Real-ESRGAN · illustration detail</option></select></Field>
      <div className="two-columns"><Field label="Output width"><input type="number" min={1} max={4096} value={upscale.width} onChange={event => onChange({ upscale: { ...upscale, width: Number(event.target.value) } })} /></Field><Field label="Output height"><input type="number" min={1} max={4096} value={upscale.height} onChange={event => onChange({ upscale: { ...upscale, height: Number(event.target.value) } })} /></Field></div>
      <Field label="Fit source"><select value={upscale.resize} onChange={event => onChange({ upscale: { ...upscale, resize: event.target.value as 'stretch' | 'center-crop' } })}><option value="stretch">Stretch to fit</option><option value="center-crop">Center crop</option></select></Field>
      <p className="muted small">This action uses source pixels. Prompts, LoRAs, change strength and sampling settings do not affect it.</p>
      {upscale.mode === 'learned' && <><p className="muted small">The illustration model creates a 4× intermediate image, then resizes to your output. It can alter texture.</p><p className="muted small">{snapshot.upscaler.message}</p>{snapshot.upscaler.state !== 'ready' && <PackageSetupStorage packageId="upscaler" />}{snapshot.upscaler.state !== 'ready' && <button type="button" className="soft-button" disabled={snapshot.upscaler.state === 'installing'} onClick={() => void run('setup-upscaler', () => window.latent.setupUpscaler(snapshot.upscaler.state === 'error'))}>{snapshot.upscaler.state === 'installing' ? 'Setting up…' : snapshot.upscaler.state === 'error' ? 'Repair illustration upscaler' : 'Set up illustration upscaler'}</button>}{snapshot.upscaler.state === 'installing' && <button type="button" onClick={() => void run('cancel-upscaler', () => window.latent.cancelUpscaler())}>Cancel setup</button>}</>}
    </div>}
    {!upscale && <><Toggle label="Hires fix · retain base and refine" checked={Boolean(hires)} onChange={enabled => enabled ? enableHires() : onChange({ hiresFix: undefined })} />
      {hires && <div className="advanced-image-options">
        <p className="muted small">Generate the base at {draft.width} × {draft.height}, then refine at the size below. Both images are saved.</p>
        {draft.width * draft.height >= 4 * 1024 * 1024 && <Notice error>The base already reaches the 4 megapixel refinement limit. Reduce the base width or height before using hires fix.</Notice>}
        {hires.workflowVersion === 'sdxl-hires-latent@1' && <Notice>This saved recipe uses the original latent refinement graph. It does not guarantee that the base file is saved before refinement starts. Editing a refinement setting uses the revised save order.<button type="button" onClick={() => onChange({ hiresFix: { ...hires, workflowVersion: 'sdxl-hires-latent@2' } })}>Use revised save order</button></Notice>}
        {draft.imageInput?.mode === 'inpaint' && <Notice error>Hires fix and inpainting are not available together yet. Turn off one before generating.</Notice>}
        <Field label="Resize interpolation"><select value={hires.interpolation ?? 'default'} onChange={event => updateHires({ interpolation: event.target.value === 'default' ? undefined : event.target.value as HiresFixSettings['interpolation'] })}><option value="default">{hires.method === 'latent' ? 'Bislerp (default)' : 'Lanczos (default)'}</option><option value="bicubic">Bicubic</option><option value="bilinear">Bilinear</option><option value="area">Area</option><option value="nearest-exact">Nearest exact</option></select></Field><div className="button-row" aria-label="Hires scale">{[1.25, 1.5, 2].map(scale => { const width = Math.round(draft.width * scale / 8) * 8, height = Math.round(draft.height * scale / 8) * 8; return <button type="button" key={scale} disabled={width * height > 4 * 1024 * 1024} aria-pressed={hires.width === width && hires.height === height} onClick={() => updateHires({ width, height })}>{scale}×</button>; })}</div><Field label="Refinement method" hint={hires.method === 'latent' ? 'If the refined image looks smeared, try Image resize and re-encode. Switching methods keeps your other refinement settings.' : undefined}><select value={hires.method} onChange={event => updateHires({ method: event.target.value as 'latent' | 'image' })}><option value="image">Image resize and re-encode</option><option value="latent">Latent upscale</option></select></Field>
        <div className="two-columns"><Field label="Refined width"><input type="number" min={64} max={4096} step={8} value={hires.width} onChange={event => updateHires({ width: Number(event.target.value) })} /></Field><Field label="Refined height"><input type="number" min={64} max={4096} step={8} value={hires.height} onChange={event => updateHires({ height: Number(event.target.value) })} /></Field></div>
        {hires.width > 0 && hires.height > 0 && hires.width * draft.height !== hires.height * draft.width && <p className="muted small">These dimensions change the base image’s proportions. It will be stretched to fit before refinement.</p>}
        <Field label={`Refinement strength · ${Math.round(hires.denoise * 100)}%`}><input type="range" min={0} max={1} step={0.01} value={hires.denoise} onChange={event => updateHires({ denoise: Number(event.target.value) })} /></Field>
        <div className="two-columns"><Field label="Refinement steps"><input type="number" min={1} max={100} value={hires.steps} onChange={event => updateHires({ steps: Number(event.target.value) })} /></Field><Field label="Refinement CFG"><input type="number" min={0} max={30} step={0.5} value={hires.cfg} onChange={event => updateHires({ cfg: Number(event.target.value) })} /></Field></div>
        <Field label="Refinement seed"><input value={hires.seed} maxLength={16} onChange={event => updateHires({ seed: event.target.value })} placeholder="random" /></Field>
        <Field label="Refinement sampler"><select value={hires.sampler} onChange={event => updateHires({ sampler: event.target.value })}>{SAMPLERS.map(value => <option key={value}>{value}</option>)}</select></Field>
        <Field label="Refinement scheduler"><select value={hires.scheduler} onChange={event => updateHires({ scheduler: event.target.value })}>{SCHEDULERS.map(value => <option key={value}>{value}</option>)}</select></Field>
        <p className="muted small">Refined size must enlarge the base and stay within 4 megapixels. Keep the base image’s proportions to avoid stretching.</p>
      </div>}
    </>}
  </details></section>;
}
