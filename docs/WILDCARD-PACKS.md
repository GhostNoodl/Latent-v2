# Starter wildcard packs

Open Create > Wildcards > Starter packs. Preview a category and choose Add, edit its copied list, then Save wildcard lists. Enable Prompt variations and use names such as:

```
__starter_species__, __starter_locations__, __starter_outfits__, __starter_poses__
```

Each wildcard chooses independently. Add anthro/feral, character details and composition yourself. Model training affects how tags are understood; these lists do not guarantee a coherent outfit or pose. Background styles are separate from physical locations.

## Bundled vocabulary, version 2

817 choices across 13 independently selectable packs, expanded from 106 choices in five packs. Search by category or an individual choice (for example, red panda). Long previews scroll within their cards.

| List | Choices | Reference |
| --- | ---: | --- |
| starter_species | 121 | [e621 species tags](https://e621.net/tags?search%5Bcategory%5D=5&search%5Border%5D=count) |
| starter_locations | 113 | [Danbooru locations](https://danbooru.donmai.us/wiki_pages/tag_group:locations) |
| starter_backgrounds | 65 | [Danbooru backgrounds](https://danbooru.donmai.us/wiki_pages/tag_group:backgrounds) |
| starter_outfits | 97 | [Danbooru attire](https://danbooru.donmai.us/wiki_pages/tag_group:attire) |
| starter_poses | 58 | [Danbooru posture](https://danbooru.donmai.us/wiki_pages/tag_group:posture) |
| starter_lighting | 46 | [Danbooru lighting](https://danbooru.donmai.us/wiki_pages/tag_group:lighting) |
| starter_time_sky | 16 | [Danbooru lighting](https://danbooru.donmai.us/wiki_pages/tag_group:lighting) |
| starter_expressions | 66 | [Danbooru face tags](https://danbooru.donmai.us/wiki_pages/tag_group:face_tags) |
| starter_gestures | 71 | [Danbooru gestures](https://danbooru.donmai.us/wiki_pages/tag_group:gestures) |
| starter_hair_colors | 24 | [Danbooru hair color](https://danbooru.donmai.us/wiki_pages/tag_group:hair_color) |
| starter_headwear | 50 | [Danbooru headwear](https://danbooru.donmai.us/wiki_pages/tag_group:headwear) |
| starter_accessories | 59 | [Danbooru accessories](https://danbooru.donmai.us/wiki_pages/tag_group:accessories) |
| starter_framing | 31 | [Danbooru image composition](https://danbooru.donmai.us/wiki_pages/tag_group:image_composition) |

Reviewed against public JSON endpoints on 2026-09-14. These are manually selected vocabulary lists, not complete site exports or periodically synchronized catalogs. Only short tag names are included; no images, post metadata, wiki prose or account data are distributed. Descriptions and grouping are authored for Latent.

Bundled names are trimmed, lowercased and converted from underscores to spaces for prompt text. The previously verified e621 [bunny to rabbit alias](https://e621.net/tag_aliases.json?search%5Bantecedent_name%5D=bunny&search%5Bstatus%5D=active&limit=5) is represented by the canonical rabbit entry. No other official alias mapping is claimed. Expanded entries were selected from the fetched reference lists; proposed names absent from those references were omitted.

## Preserving user edits

Adding a pack stages an ordinary editable list; saving is explicit. An occupied name receives a numeric suffix. Re-adding an unchanged copy selects that copy, while edited copies and user-authored lists remain untouched. In particular, duplicate user entries are preserved because they may be intentional weighting. Existing saved generation recipes retain their frozen wildcard snapshots. Installing the update does not automatically insert lists or change prompts.

The packs work offline and require no site account, API key, images or model download.

All packs together use 817 of the existing 1,024-choice dictionary budget. Your own lists and older copies also count toward that limit. An addition that would exceed it is refused with an actionable message and no changed entries. The limit and generation resolver are unchanged.

Expanded packs do not silently replace older copies: adding an updated pack alongside an older list creates a suffixed list, which can be reviewed before switching prompt references or removing the old one. Saved generation recipes remain frozen.
