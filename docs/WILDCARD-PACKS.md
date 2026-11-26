# Wildcards

Wildcards make each image pick something different. Put `__species__` or `{sunny|misty}` in a prompt and every image rolls its own pick. Open Create > Wildcards to see example rolls, keep a pick, make several images at once, or edit your lists.

## Writing them

| Write | What it does |
| --- | --- |
| `{red\|blue}` | pick one |
| `{3::red\|blue}` | red comes up 3 times as often (weights can be decimals; 0 means never) |
| `{2$$red\|blue\|green}` | pick 2 different ones, joined with ", " |
| `{1-3$$ and $$__colors__}` | pick 1 to 3 lines from a list, joined with " and " |
| `__clothes/*__` | any line from any list in the clothes folder |
| `${hair=!__hair_colors__}` then `${hair}` | pick once and reuse the same pick (`=!` picks right away; `=` re-rolls each time it's used) |
| `${hair:black hair}` | use the variable, or "black hair" if it isn't set |
| `\{` `\}` `\$` | a real brace or dollar sign |

In a list, one choice per line. Blank lines and lines starting with `#` are notes. A line can use choices and other lists.

## Making several

- **Make 4 / 8 / 16** queues that many images, each with new picks. With a fixed image seed only the picks change.
- **All N combinations** walks every combination of the main prompt in order (up to 100 per press). Weights don't apply here, and pick-several groups still roll.
- **Keep** locks a list to the pick shown in the first example. Every other pick lands where it would have.

## Your lists

Wildcards > Lists holds your own lists, with no practical cap (100,000 lines in total, 4 million characters). You can:

- **Import files**: `.txt` (one choice per line, the file name is the list name), Dynamic Prompts style `.yaml` packs (nested keys become `folder/list` names) and `.json`.
- **Import folder**: every wildcard file inside, with subfolders kept as `folder/list` names.
- Drop files or folders straight onto the Lists window.
- **Export** writes every list as a `.txt` file, keeping folders.

Imports land in the window first; nothing is kept until you press Save. A list with the same name is replaced.

## Starter packs

33 packs, 1,445 choices. They work right away by name (`__species__`, `__plain_scenes__` and so on). Add one in Lists only if you want your own copy to edit.

- **Tags** (for SDXL and Illustrious): species, locations, backgrounds, outfits, poses, lighting, time and sky, expressions, gestures, hair colors, headwear, accessories, framing, eye colors, hairstyles, colors, weather, seasons, looking, art styles, color moods, materials. New tag packs were checked against the bundled Danbooru and e621 tag lists; colors are plain color words.
- **Mix and match**: `__full_outfit__`, `__full_look__`, `__full_scene__`, `__full_shot__`. Each line combines other packs, so one pick gives a whole outfit in random colors, or a place with time, weather and light.
- **Plain English** (for the newer models): `__plain_scenes__`, `__plain_lighting__`, `__plain_styles__`, `__plain_moods__`, `__plain_shots__`, `__plain_people__`, `__plain_outfits__`.

The original thirteen tag packs were reviewed against public Danbooru and e621 tag groups on 2026-09-14. Only short tag names are included; no images, post data or wiki text.

## Saved images

Every image keeps exactly what it picked. Small lists are saved with the image in full; lists over 256 lines keep only their size and the lines that image used, so big imports don't bloat your history. Reusing an image's settings replays its exact picks.

Images made before this update keep their old meaning: in those, `{2::a|b}` was a choice between "2::a" and "b", and they still replay that way.
