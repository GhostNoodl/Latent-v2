import type { TagSource, TagSuggestion } from '../shared/tag-autocomplete';
let worker: Worker | undefined;
let sequence = 0;
const cache=new Map<string,Promise<TagSuggestion[]>>();
const pending = new Map<number, { resolve: (results: TagSuggestion[]) => void; reject: (error: Error) => void }>();
export async function findTags(query: string, source: TagSource): Promise<TagSuggestion[]> {
  const key=source+':'+query.trim().toLowerCase().replace(/\s+/g,'_');
  const cached=cache.get(key);if(cached)return cached;
  if (!worker) {
    worker = new Worker(new URL('./tag-search.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => { pending.get(data.id)?.resolve(data.results); pending.delete(data.id); };
    worker.onerror = () => { worker?.terminate(); worker = undefined; for (const task of pending.values()) task.reject(new Error('Tag lookup unavailable')); pending.clear(); cache.clear(); };
  }
  const result=new Promise<TagSuggestion[]>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); worker!.postMessage({ id, query, source }); });
  cache.set(key,result);if(cache.size>128)cache.delete(cache.keys().next().value!);
  return result;
}
