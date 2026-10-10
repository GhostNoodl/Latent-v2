import e621 from './tag-data/e621.csv?raw';
import danbooru from './tag-data/danbooru.csv?raw';
import { parseTagCsv, createTagSearch, type TagSource } from '../shared/tag-autocomplete';
const entries = [...parseTagCsv(e621, 'e621'), ...parseTagCsv(danbooru, 'danbooru')];
const search = createTagSearch(entries);
self.onmessage = (event: MessageEvent<{ id: number; query: string; source: TagSource }>) => {
  const { id, query, source } = event.data;
  self.postMessage({ id, results: search(query, source) });
};
