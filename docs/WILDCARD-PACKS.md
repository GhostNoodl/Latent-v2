# Starter wildcard packs

Open Create > Wildcards > Starter packs. Preview a category and choose Add, edit its copied list, then Save wildcard lists. Enable Prompt variations and use names such as:

```
__starter_species__, __starter_locations__, __starter_outfits__, __starter_poses__
```

Each wildcard chooses independently. Add anthro/feral, character details and composition yourself. Model training affects how tags are understood; these lists do not guarantee a coherent outfit or pose. Background styles are separate from physical locations.

## Bundled vocabulary, version 1

| List | Choices | Reference |
| --- | ---: | --- |
| starter_species | 20 | [e621 species tags](https://e621.net/tags?search%5Bcategory%5D=5&search%5Border%5D=count) |
| starter_locations | 24 | [Danbooru locations](https://danbooru.donmai.us/wiki_pages/tag_group:locations) |
| starter_backgrounds | 20 | [Danbooru backgrounds](https://danbooru.donmai.us/wiki_pages/tag_group:backgrounds) |
| starter_outfits | 22 | [Danbooru attire](https://danbooru.donmai.us/wiki_pages/tag_group:attire) |
| starter_poses | 20 | [Danbooru posture](https://danbooru.donmai.us/wiki_pages/tag_group:posture) |

Reviewed against public JSON endpoints on 2026-09-14. These are small, manually selected vocabulary lists, not complete site exports or periodically synchronized catalogs. Only short tag names are included; no images, post metadata, wiki prose or account data are distributed. Descriptions and grouping are authored for Latent.

Bundled names are trimmed, lowercased and converted from underscores to spaces for prompt text. The active e621 [bunny to rabbit alias](https://e621.net/tag_aliases.json?search%5Bantecedent_name%5D=bunny&search%5Bstatus%5D=active&limit=5) is applied before deduplication. No other official alias mapping is claimed.

## Preserving user edits

Adding a pack stages an ordinary editable list; saving is explicit. An occupied name receives a numeric suffix. Re-adding an unchanged copy selects that copy, while edited copies and user-authored lists remain untouched. In particular, duplicate user entries are preserved because they may be intentional weighting. Existing saved generation recipes retain their frozen wildcard snapshots. Installing the update does not automatically insert lists or change prompts.

The packs work offline and require no site account, API key, images or model download.
