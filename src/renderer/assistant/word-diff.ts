export interface DiffPiece {
  text: string;
  added: boolean;
}

/** Splits text into words and the separators between them, so it can be put back together exactly. */
function tokens(text: string): string[] {
  return text.match(/[^\s,]+|[\s,]+/g) ?? [];
}

/**
 * Marks the words in `next` that aren't in `before`, keeping word order (longest common subsequence).
 * Long prompts fall back to "all new" past a size limit so typing stays smooth.
 */
export function wordDiff(before: string, next: string): DiffPiece[] {
  const a = tokens(before);
  const b = tokens(next);
  if (!b.length) return [];
  if (a.length * b.length > 400_000) return [{ text: next, added: false }];
  const word = (token: string) => !/^[\s,]+$/.test(token);
  const key = (token: string) => token.toLowerCase();
  const rows = a.length + 1;
  const columns = b.length + 1;
  const table = new Uint16Array(rows * columns);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * columns + j] =
        key(a[i]) === key(b[j])
          ? table[(i + 1) * columns + j + 1] + 1
          : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
  const pieces: DiffPiece[] = [];
  const push = (text: string, added: boolean) => {
    const last = pieces[pieces.length - 1];
    if (last && last.added === added) last.text += text;
    else pieces.push({ text, added });
  };
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && key(a[i]) === key(b[j])) {
      push(b[j], false);
      i++;
      j++;
    } else if (i < a.length && table[(i + 1) * columns + j] >= table[i * columns + j + 1]) i++;
    else {
      push(b[j], word(b[j]));
      j++;
    }
  }
  // Join neighbouring new words so "wet hair" reads as one highlight.
  const joined: DiffPiece[] = [];
  pieces.forEach((piece, index) => {
    const bridge = !piece.added && /^\s+$/.test(piece.text) && pieces[index - 1]?.added && pieces[index + 1]?.added;
    const value = bridge ? { text: piece.text, added: true } : piece;
    const last = joined[joined.length - 1];
    if (last && last.added === value.added) last.text += value.text;
    else joined.push({ ...value });
  });
  return joined;
}
