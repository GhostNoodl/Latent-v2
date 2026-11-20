/**
 * Checks one workflow input against the engine's dropdown choices.
 * Returns a plain message when the engine won't take the value, otherwise undefined.
 *
 * The engine's picture dropdowns (LoadImage, LoadImageMask) list only top-level files,
 * while the engine itself happily loads nested ones. Pictures the app saved and checked
 * itself are passed in `verifiedImages` and skip the dropdown check.
 */
export function unofferedInputMessage(
  classType: string,
  name: string,
  value: unknown,
  allowed: unknown,
  verifiedImages: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  if (!Array.isArray(allowed) || Array.isArray(value) || allowed.includes(value)) return undefined;
  if (name === 'image' && typeof value === 'string') {
    if (verifiedImages.get(classType)?.has(value)) return undefined;
    return /mask/i.test(classType)
      ? "The engine can't find the painted area. Paint it again and retry."
      : "The engine can't find a picture this needs. Add the picture again and retry.";
  }
  const file = String(value).split(/[\\/]/).pop() || String(value);
  return `The engine can't find ${file}. Refresh models and try again.`;
}
