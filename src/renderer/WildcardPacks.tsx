import { useState } from 'react';
import { WILDCARD_PACKS, type WildcardPackGroup } from '../shared/wildcard-packs';

const GROUPS: { id: WildcardPackGroup; title: string; hint: string }[] = [
  { id: 'tags', title: 'Tags', hint: 'Short tags, best for SDXL and Illustrious models.' },
  { id: 'mix', title: 'Mix and match', hint: 'Each pick combines other lists, like a full outfit in random colors.' },
  { id: 'plain', title: 'Plain English', hint: 'Whole sentences, best for the newer models.' },
];

/** Every starter pack already works as __name__ in a prompt; Add makes your own editable copy. */
export function WildcardPacks({ disabled, onAdd }: { disabled: boolean; onAdd(id: string): void }) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase().replace(/_/g, ' ');
  const visible = WILDCARD_PACKS.filter(pack =>
    [pack.id, pack.name, pack.description, ...pack.entries].some(text =>
      text.toLowerCase().replace(/_/g, ' ').includes(query),
    ),
  );
  return (
    <section className="wildcard-starter-packs" aria-label="Starter packs">
      <p className="muted small">
        These work right away: type <code>__species__</code> and so on. Add one to make your own copy to edit.
      </p>
      <label className="field">
        <span>Find a pack or choice</span>
        <input
          type="search"
          value={search}
          disabled={disabled}
          placeholder="Species, hairstyles, red panda…"
          onChange={event => setSearch(event.target.value)}
        />
      </label>
      {!visible.length && <p className="muted small">No packs match. Try another word.</p>}
      {GROUPS.map(group => {
        const packs = visible.filter(pack => pack.group === group.id);
        if (!packs.length) return null;
        return (
          <div className="wildcard-pack-group" key={group.id}>
            <h4>
              {group.title} · <span>{group.hint}</span>
            </h4>
            {packs.map(pack => (
              <details key={pack.id}>
                <summary>
                  <code>__{pack.id}__</code> {pack.name} · {pack.entries.length} choices
                </summary>
                <p className="small">{pack.description}</p>
                <p className="small pack-entries">{pack.entries.join(' · ')}</p>
                <p className="muted small">{pack.source.label}</p>
                <button type="button" disabled={disabled} onClick={() => onAdd(pack.id)}>
                  Add {pack.name.toLowerCase()}
                </button>
              </details>
            ))}
          </div>
        );
      })}
    </section>
  );
}
