import { z } from 'zod';

export const previewSelectionIdSchema = z.string().regex(/^[a-f0-9]{32}$/).nullable();

/** History is newest first. An explicit, available image wins over new results;
 * an absent selection falls back to the newest image without changing recipes. */
export function selectedHistoryRecord<T extends { id: string }>(records: readonly T[], selectedId: string | null | undefined): T | undefined {
  return records.find(record => record.id === selectedId) ?? records[0];
}

export function historyPageForSelection(records: readonly { id: string }[], selectedId: string | undefined, pageSize: number, fallbackPage = 0): number {
  const index = records.findIndex(record => record.id === selectedId);
  return index < 0 ? fallbackPage : Math.floor(index / pageSize);
}
