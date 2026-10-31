import { useState, type CSSProperties } from 'react';
import { LayoutGrid } from 'lucide-react';
import { SAMPLERS, SCHEDULERS } from '../shared/defaults';
import type { GenerationDraft, GenerationRecord, ModelAsset, StudioJob } from '../shared/types';
import { isImageJob } from '../shared/types';
import { Modal } from './ui';

export type SweepInfo = NonNullable<GenerationDraft['sweep']>;
export const SWEEP_LIMIT = 16;

export type AxisKind = 'cfg' | 'steps' | 'sampler' | 'scheduler' | 'seed' | `lora:${number}`;
export interface Axis {
  kind: AxisKind;
  values: string[];
}

export function axisLabel(kind: AxisKind, draft: GenerationDraft, models: ModelAsset[]) {
  if (kind === 'cfg') return 'Guidance';
  if (kind === 'steps') return 'Steps';
  if (kind === 'sampler') return 'Sampler';
  if (kind === 'scheduler') return 'Scheduler';
  if (kind === 'seed') return 'Seed';
  const lora = draft.loras[Number(kind.slice(5))];
  const name = models.find(model => model.id === lora?.modelId)?.name ?? 'LoRA';
  return `${name} weight`;
}

/** Sensible starting values around the current setting. */
export function suggestedValues(kind: AxisKind, draft: GenerationDraft): string[] {
  const around = (value: number, step: number, min: number, max: number, digits = 0) =>
    [value - step, value, value + step].map(v => Math.min(max, Math.max(min, v)).toFixed(digits));
  if (kind === 'cfg') return [...new Set(around(draft.cfg, 2, 1, 30, 0))];
  if (kind === 'steps') return [...new Set(around(draft.steps, 8, 4, 100))];
  if (kind === 'sampler') return [...new Set([draft.sampler, 'euler', 'dpmpp_2m'])].slice(0, 3);
  if (kind === 'scheduler') return [...new Set([draft.scheduler, 'karras', 'normal'])].slice(0, 3);
  if (kind === 'seed') return ['random', 'random', 'random'];
  const lora = draft.loras[Number(kind.slice(5))];
  return [...new Set(around(lora?.weight ?? 0.7, 0.3, -4, 4, 1))];
}

export function parseValues(kind: AxisKind, text: string): { values: string[]; error?: string } {
  const values = text
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (values.length === 0) return { values, error: 'Add at least one value.' };
  if (values.length > 8) return { values, error: 'Use 8 values or fewer.' };
  for (const value of values) {
    if (kind === 'sampler' && !SAMPLERS.includes(value)) return { values, error: `Unknown sampler: ${value}` };
    if (kind === 'scheduler' && !SCHEDULERS.includes(value)) return { values, error: `Unknown scheduler: ${value}` };
    if (kind === 'seed' && value !== 'random' && !/^\d{1,15}$/.test(value))
      return { values, error: 'Seeds are whole numbers or random.' };
    if (kind === 'steps' && !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100))
      return { values, error: 'Steps go from 1 to 100.' };
    if (kind === 'cfg' && !(Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 30))
      return { values, error: 'Guidance goes from 0 to 30.' };
    if (kind.startsWith('lora:') && !Number.isFinite(Number(value))) return { values, error: 'Weights are numbers.' };
  }
  return { values };
}

function randomSeed() {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0]);
}

function apply(draft: GenerationDraft, kind: AxisKind, value: string): GenerationDraft {
  if (kind === 'cfg') return { ...draft, cfg: Number(value) };
  if (kind === 'steps') return { ...draft, steps: Number(value) };
  if (kind === 'sampler') return { ...draft, sampler: value };
  if (kind === 'scheduler') return { ...draft, scheduler: value };
  if (kind === 'seed') return { ...draft, seed: value === 'random' ? randomSeed() : value };
  const index = Number(kind.slice(5));
  return {
    ...draft,
    loras: draft.loras.map((lora, i) => (i === index ? { ...lora, weight: Number(value) } : lora)),
  };
}

/** One draft per grid cell, all sharing a seed unless the seed is what changes. */
export function buildSweepDrafts(
  draft: GenerationDraft,
  columns: Axis,
  rows: Axis | undefined,
  labels: { columns: string; rows?: string },
  id = `sw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
): GenerationDraft[] {
  const base: GenerationDraft = {
    ...draft,
    batchSize: 1,
    seed: draft.seed === 'random' ? randomSeed() : draft.seed,
  };
  const rowValues = rows?.values ?? [''];
  const drafts: GenerationDraft[] = [];
  rowValues.forEach((rowValue, row) => {
    columns.values.forEach((columnValue, column) => {
      let next = rows ? apply(base, rows.kind, rowValue) : base;
      next = apply(next, columns.kind, columnValue);
      drafts.push({
        ...next,
        sweep: {
          id,
          index: row * columns.values.length + column,
          columnLabel: labels.columns,
          columns: columns.values,
          rowLabel: rows ? labels.rows : undefined,
          rows: rows ? rows.values : [],
        },
      });
    });
  });
  return drafts.slice(0, SWEEP_LIMIT);
}

const KINDS = (draft: GenerationDraft): AxisKind[] => [
  'cfg',
  'steps',
  'sampler',
  'scheduler',
  'seed',
  ...draft.loras.map((_, i) => `lora:${i}` as const),
];

/** Tune flyout: pick one or two settings and the values to try, then queue the grid. */
export function GridSweepSetup({
  draft,
  models,
  disabledReason,
  onQueue,
}: {
  draft: GenerationDraft;
  models: ModelAsset[];
  disabledReason?: string;
  onQueue(drafts: GenerationDraft[]): void;
}) {
  const [columns, setColumns] = useState<AxisKind>('cfg');
  const [rows, setRows] = useState<AxisKind | ''>('');
  const [columnText, setColumnText] = useState(() => suggestedValues('cfg', draft).join(', '));
  const [rowText, setRowText] = useState('');
  const kinds = KINDS(draft);
  const columnValues = parseValues(columns, columnText);
  const rowValues = rows ? parseValues(rows, rowText) : undefined;
  const count = columnValues.values.length * (rowValues?.values.length ?? 1);
  const error =
    columnValues.error ??
    rowValues?.error ??
    (rows === columns ? 'Pick two different settings.' : undefined) ??
    (count > SWEEP_LIMIT ? `That is ${count} images. The limit is ${SWEEP_LIMIT}.` : undefined);
  const option = (kind: AxisKind) => (
    <option key={kind} value={kind}>
      {axisLabel(kind, draft, models)}
    </option>
  );
  return (
    <details className="extra-row tune-flyout sweep-flyout">
      <summary>Compare settings</summary>
      <div className="sweep-setup">
        <p className="muted small">Try a few values side by side. Every image uses the same seed.</p>
        <div className="sweep-axis">
          <label htmlFor="sweep-columns">Across</label>
          <select
            id="sweep-columns"
            value={columns}
            onChange={event => {
              const kind = event.target.value as AxisKind;
              setColumns(kind);
              setColumnText(suggestedValues(kind, draft).join(', '));
            }}
          >
            {kinds.map(option)}
          </select>
          <input aria-label="Values across" value={columnText} onChange={event => setColumnText(event.target.value)} />
        </div>
        <div className="sweep-axis">
          <label htmlFor="sweep-rows">Down</label>
          <select
            id="sweep-rows"
            value={rows}
            onChange={event => {
              const kind = event.target.value as AxisKind | '';
              setRows(kind);
              setRowText(kind ? suggestedValues(kind, draft).join(', ') : '');
            }}
          >
            <option value="">Nothing</option>
            {kinds.filter(kind => kind !== columns).map(option)}
          </select>
          <input
            aria-label="Values down"
            disabled={!rows}
            value={rowText}
            onChange={event => setRowText(event.target.value)}
          />
        </div>
        {(error || disabledReason) && <p className="inline-error small">{error || disabledReason}</p>}
        <button
          type="button"
          className="primary"
          disabled={Boolean(error || disabledReason)}
          onClick={() =>
            onQueue(
              buildSweepDrafts(
                draft,
                { kind: columns, values: columnValues.values },
                rows && rowValues ? { kind: rows, values: rowValues.values } : undefined,
                {
                  columns: axisLabel(columns, draft, models),
                  rows: rows ? axisLabel(rows, draft, models) : undefined,
                },
              ),
            )
          }
        >
          <LayoutGrid size={14} />
          Make {count} image{count === 1 ? '' : 's'}
        </button>
      </div>
    </details>
  );
}

/** The finished (and still running) cells of one comparison grid. */
export function SweepGrid({
  sweep,
  history,
  jobs,
  onPick,
  onClose,
}: {
  sweep: SweepInfo;
  history: GenerationRecord[];
  jobs: StudioJob[];
  onPick(record: GenerationRecord): void;
  onClose(): void;
}) {
  const cells = new Map<number, GenerationRecord>();
  for (const record of history)
    if (record.draft.sweep?.id === sweep.id && !cells.has(record.draft.sweep.index) && !record.draft.enhance)
      cells.set(record.draft.sweep.index, record);
  const waiting = new Set(
    jobs
      .filter(job => isImageJob(job) && job.draft.sweep?.id === sweep.id && ['queued', 'running'].includes(job.status))
      .map(job => (isImageJob(job) ? job.draft.sweep!.index : -1)),
  );
  const rows = sweep.rows.length ? sweep.rows : [''];
  return (
    <Modal title="Compare settings" onClose={onClose}>
      <div className="sweep-grid-wrap">
        <div
          className="sweep-grid"
          style={
            {
              gridTemplateColumns: `${sweep.rows.length ? 'auto ' : ''}repeat(${sweep.columns.length}, auto)`,
              '--sweep-columns': sweep.columns.length,
              '--sweep-rows': rows.length,
            } as CSSProperties
          }
        >
          {sweep.rows.length > 0 && <span className="sweep-corner">{sweep.rowLabel}</span>}
          {sweep.columns.map((value, i) => (
            <span key={`c${i}`} className="sweep-head">
              {sweep.columnLabel} <b>{value}</b>
            </span>
          ))}
          {rows.map((rowValue, row) => [
            sweep.rows.length > 0 && (
              <span key={`r${row}`} className="sweep-side">
                <b>{rowValue}</b>
              </span>
            ),
            ...sweep.columns.map((_, column) => {
              const index = row * sweep.columns.length + column;
              const record = cells.get(index);
              return record ? (
                <button
                  type="button"
                  key={index}
                  className="sweep-cell"
                  title="Open this image"
                  onClick={() => onPick(record)}
                >
                  <img src={record.imageUrl} alt={`${sweep.columnLabel} ${sweep.columns[column]}`} />
                </button>
              ) : (
                <span key={index} className="sweep-cell sweep-empty">
                  {waiting.has(index) ? 'Waiting…' : 'Not made'}
                </span>
              );
            }),
          ])}
        </div>
      </div>
    </Modal>
  );
}
