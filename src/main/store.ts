import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_DRAFT, DEFAULT_SETTINGS } from '../shared/defaults';
import { draftSchema, settingsSchema } from '../shared/validation';
import type { AppSettings, GenerationDraft, StudioJob, GenerationRecord, Preset } from '../shared/types';
import { redactDynamicPromptDraft } from '../shared/dynamic-prompt-recipe';
import { restoreTriggerResolution } from '../shared/trigger-resolution';
import { previewSelectionIdSchema } from '../shared/history-selection';

const validJobId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
function jobIdentity(job: StudioJob): void {
  if (!job || !validJobId(job.id) || !Number.isFinite(Date.parse(job.createdAt)) || (job.kind !== undefined && job.kind !== 'image' && job.kind !== 'video')) throw new Error('Invalid job identity.');
}
function encodeReceipt(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('A serializable job execution receipt is required.');
  return encoded;
}
export class StudioStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS video_records (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  getState<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : structuredClone(fallback);
  }
  setState(key: string, value: unknown) { this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings(): AppSettings { return settingsSchema.parse({ ...DEFAULT_SETTINGS, ...this.getState('settings', {}) }); }
  saveSettings(patch: Partial<AppSettings>): AppSettings {
    const settings = settingsSchema.parse({ ...this.settings(), ...settingsSchema.partial().parse(patch) });
    this.setState('settings', settings); this.saveDraft(this.draft()); return settings;
  }
  draft(): GenerationDraft {
    const saved = this.getState<Partial<GenerationDraft> | null>('draft', null);
    if (saved === null) return draftSchema.parse(DEFAULT_DRAFT);
    return draftSchema.parse(restoreTriggerResolution({ ...DEFAULT_DRAFT, ...saved, triggerResolutionVersion: saved.triggerResolutionVersion }));
  }
  saveDraft(draft: GenerationDraft) {
    const validated = draftSchema.parse(draft); const settings = this.settings();
    const remembered = redactDynamicPromptDraft(validated, settings.rememberPositivePrompt, settings.rememberNegativePrompt);
    if (remembered.regionalPrompts && (!settings.rememberPositivePrompt || !settings.rememberNegativePrompt)) {
      remembered.regionalPrompts = { settings: { ...remembered.regionalPrompts.settings, regions: remembered.regionalPrompts.settings.regions.map(region => ({ ...region, positivePrompt: settings.rememberPositivePrompt ? region.positivePrompt : '', negativePrompt: settings.rememberNegativePrompt ? region.negativePrompt : '' })) } };
    }
    this.setState('draft', remembered);
  }
  jobs(): StudioJob[] { return this.db.prepare('SELECT value FROM jobs ORDER BY created_at ASC').all().map(row => JSON.parse(String(row.value)) as StudioJob); }
  saveJob(job: StudioJob) { this.db.prepare('INSERT INTO jobs(id,created_at,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(job.id, job.createdAt, JSON.stringify(job)); }
  /** New acceptance only: a repeated identity must never rewind a later queue or execution receipt. */
  acceptJob(job: StudioJob, context: unknown, order: string[]): void {
    jobIdentity(job);
    if (!Array.isArray(order) || order.some(id => !validJobId(id)) || new Set(order).size !== order.length || !order.includes(job.id)) throw new Error('Invalid job queue order.');
    const encodedJob = encodeReceipt(job), encodedContext = encodeReceipt(context), encodedOrder = JSON.stringify(order);
    this.jobTransaction(() => {
      if (this.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(job.id) || this.db.prepare('SELECT 1 FROM state WHERE key=?').get(`execution:${job.id}`)) throw new Error('This job identity already has a saved job or execution receipt. The original was preserved.');
      if (order.some(id => id !== job.id && !this.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(id))) throw new Error('The queue contains an unknown job.');
      this.db.prepare('INSERT INTO jobs(id,created_at,value) VALUES(?,?,?)').run(job.id, job.createdAt, encodedJob);
      this.db.prepare('INSERT INTO state(key,value) VALUES(?,?)').run(`execution:${job.id}`, encodedContext);
      this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('queue-order', encodedOrder);
    });
  }
  /** Submission and finalization transitions update an accepted job and its opaque, versioned receipt together. */
  saveJobContext(job: StudioJob, context: unknown): void {
    jobIdentity(job);
    const encodedJob = encodeReceipt(job), encodedContext = encodeReceipt(context);
    this.jobTransaction(() => {
      const row = this.db.prepare('SELECT created_at,value FROM jobs WHERE id=?').get(job.id);
      if (!row) throw new Error('Accept the job before saving its execution receipt.');
      const previous = JSON.parse(String(row.value)) as StudioJob;
      if (!previous || previous.id !== job.id || row.created_at !== job.createdAt || previous.createdAt !== job.createdAt || (previous.kind ?? 'image') !== (job.kind ?? 'image')) throw new Error('The saved job identity differs. The original was preserved.');
      this.db.prepare('UPDATE jobs SET value=? WHERE id=?').run(encodedJob, job.id);
      this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`execution:${job.id}`, encodedContext);
    });
  }
  private jobTransaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { action(); this.db.exec('COMMIT'); }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  records(): GenerationRecord[] { return this.db.prepare('SELECT value FROM records ORDER BY created_at DESC, id DESC').all().map(row => JSON.parse(String(row.value)) as GenerationRecord); }
  previewSelectionId(): string | null {
    const parsed = previewSelectionIdSchema.safeParse(this.getState('preview.selectedRecordId', null));
    return parsed.success ? parsed.data : null;
  }
  savePreviewSelection(recordId: string | null): void {
    const id = previewSelectionIdSchema.parse(recordId);
    if (id !== null && !this.db.prepare('SELECT 1 FROM records WHERE id=?').get(id)) throw new Error('This image is no longer in your history. Select another image to remember its preview.');
    this.setState('preview.selectedRecordId', id);
  }
  saveRecord(record: GenerationRecord) { this.db.prepare('INSERT INTO records(id,job_id,created_at,value) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, record.jobId, record.createdAt, JSON.stringify(record)); }
  videoRecords(): unknown[] {
    return this.db.prepare('SELECT id,value FROM video_records ORDER BY created_at DESC,id DESC').all().map(row => {
      try { const value = JSON.parse(String(row.value)); return value?.id === String(row.id) ? value : { id: String(row.id), invalidRecordId: true }; } catch { return { id: String(row.id), invalidJson: true }; }
    });
  }
  videoRecord(id: string): unknown | null {
    const row = this.db.prepare('SELECT value FROM video_records WHERE id=?').get(id);
    if (!row) return null;
    try { const value = JSON.parse(String(row.value)); return value?.id === id ? value : { id, invalidRecordId: true }; } catch { return { id, invalidJson: true }; }
  }
  saveVideoRecord(id: string, jobId: string, createdAt: string, value: unknown): void {
    if (!/^[a-f0-9]{32}$/.test(id) || !jobId || !Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid saved video identity.');
    const encoded = JSON.stringify(value); if (!encoded) throw new Error('A video record is required.');
    this.db.prepare('INSERT INTO video_records(id,job_id,created_at,value) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').run(id, jobId, createdAt, encoded);
    const row = this.db.prepare('SELECT job_id,created_at,value FROM video_records WHERE id=?').get(id)!;
    if (row.job_id !== jobId || row.created_at !== createdAt || !isDeepStrictEqual(JSON.parse(String(row.value)), JSON.parse(encoded))) throw new Error('This video identity already has a different saved record. The original was preserved.');
  }
  presets(): Preset[] { return this.db.prepare('SELECT value FROM presets ORDER BY id').all().map(row => JSON.parse(String(row.value)) as Preset); }
  savePreset(preset: Preset) {
    if (!preset.id || !preset.name.trim() || preset.name.length > 80) throw new Error('Give the preset a name up to 80 characters.');
    const validated = { ...preset, draft: draftSchema.parse(preset.draft) };
    this.db.prepare('INSERT INTO presets(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(preset.id, JSON.stringify(validated));
  }
  deletePreset(id: string) { this.db.prepare('DELETE FROM presets WHERE id=?').run(id); }
  modelMetadata<T extends object>(id: string): T | undefined { const row = this.db.prepare('SELECT value FROM model_metadata WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) as T : undefined; }
  saveModelMetadata(id: string, value: object) { this.db.prepare('INSERT INTO model_metadata(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)); }
  close() { this.db.close(); }
}
