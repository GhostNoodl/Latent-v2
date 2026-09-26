# Offline tag autocomplete

The Create tab's positive and negative prompts suggest tags after two characters.
Choose e621, Danbooru, both (default), or Off beneath either field. This preference
is shared between the two fields and retained on this device.

Arrow keys select a result; Tab or Enter inserts it; Escape dismisses suggestions.
Clicking a result also inserts it. Ctrl+Enter keeps its generation shortcut.
The tag at the caret is replaced, preserving neighboring tags and numeric weights.
Literal parentheses in tag names are escaped for ComfyUI prompt syntax.
Wildcard expressions and LoRA markup are not completed.

Tag names, aliases and post counts are bundled with the application. Lookup runs
in a lazily started local worker; no prompt text or search query is sent to a
website. Suggestions prefer exact/prefix matches, then word-boundary and substring
matches, ordered by post count within each group. Aliases resolve to canonical
names. Both-source results are deduplicated by canonical name. Counts are from
the bundled snapshot, not live totals. No rating filter is applied.

## Dictionary provenance

Unmodified `tags/e621.csv` and `tags/danbooru.csv` from:
https://github.com/DominikDoom/a1111-sd-webui-tagcomplete/tree/4170882f90b47be130a0ff9314f663c230b9153d/tags

Upstream revision: `4170882f90b47be130a0ff9314f663c230b9153d`.
Retrieved 2026-09-19. MIT notice is retained in
`licenses/TAG-AUTOCOMPLETE-MIT.txt` and the packaged third-party notices.
The dictionaries are compiled into a separate worker asset, included by Vite's
normal `dist` packaging. They are not loaded until autocomplete is used.

To update, review a new upstream revision, replace both CSV files, update this
provenance and the notice generator revision, run the tag tests, regenerate notices,
and refresh the public export hashes. No automatic remote refresh occurs.
