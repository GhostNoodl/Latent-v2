export interface WildcardPack {
 id: string; name: string; description: string; entries: readonly string[];
 source: { label: string; url: string }; reviewed: string;
}
/** Normalize bundled vocabulary only. Never rewrite or deduplicate authored lists, where repetition may be intentional weighting. */
export function cleanPackEntries(values: readonly string[], aliases: Readonly<Record<string,string>> = {}): string[] {
 const result=new Set<string>();
 for(const value of values){let tag=value.trim().toLowerCase().replace(/\s+/g,'_');tag=aliases[tag]??tag;const text=tag.replace(/_/g,' ').trim();if(text)result.add(text);}
 return [...result];
}
const make=(id:string,name:string,description:string,values:string,source:WildcardPack['source'],aliases:Record<string,string>={}):WildcardPack=>({id,name,description,entries:cleanPackEntries(values.split('|'),aliases),source,reviewed:'2026-09-14'});
export const WILDCARD_PACKS:readonly WildcardPack[]=[
 make('species','Species','Animals and fantasy species. Add anthro or feral separately to choose body style.','fox|wolf|domestic_dog|domestic_cat|rabbit|bunny|horse|bear|deer|tiger|lion|goat|pony|bird|fish|dragon|unicorn|demon|alien|robot|hybrid',{label:'e621 species tags',url:'https://e621.net/tags?search%5Bcategory%5D=5&search%5Border%5D=count'},{bunny:'rabbit'}),
 make('locations','Locations','Indoor and outdoor settings for your scene.','bedroom|ballroom|classroom|conservatory|kitchen|library|living_room|workshop|beach|canyon|cave|desert|forest|jungle|meadow|mountain|park|lake|river|waterfall|city|village|garden|amusement_park',{label:'Danbooru location tags',url:'https://danbooru.donmai.us/wiki_pages/tag_group:locations'}),
 make('backgrounds','Background styles','Simple colors and patterns, separate from scene locations.','simple_background|white_background|black_background|blue_background|green_background|pink_background|purple_background|grey_background|gradient_background|colorful_background|rainbow_background|checkered_background|dotted_background|striped_background|floral_background|abstract_background|blurry_background|dark_background|bright_background|cloud_background',{label:'Danbooru background tags',url:'https://danbooru.donmai.us/wiki_pages/tag_group:backgrounds'}),
 make('outfits','Clothing','Clothing pieces to combine with your own outfit details.','blouse|cardigan|coat|duffel_coat|long_coat|raincoat|trench_coat|winter_coat|dress|hoodie|jacket|blazer|letterman_jacket|nightgown|poncho|robe|shirt|dress_shirt|t-shirt|sweater|turtleneck_sweater|sweater_dress',{label:'Danbooru attire tags',url:'https://danbooru.donmai.us/wiki_pages/tag_group:attire'}),
 make('poses','Poses','Postures and actions. Results depend on the selected model.','standing|sitting|kneeling|on_one_knee|lying|on_back|on_side|on_stomach|crossed_legs|reclining|standing_on_one_leg|crawling|floating|flying|jumping|running|walking|squatting|stretching|fighting_stance',{label:'Danbooru posture tags',url:'https://danbooru.donmai.us/wiki_pages/tag_group:posture'}),
];
/** Re-adding an unchanged pack reuses its list; occupied names and edited copies are preserved. */
export function stageWildcardPack(entries:Record<string,string[]>,id:string):{entries:Record<string,string[]>;name:string;added:boolean} {
 const pack=WILDCARD_PACKS.find(p=>p.id===id);if(!pack)throw Error('Choose an available starter pack.');
 const prefix=`starter_${pack.id}`;
 for(const [name,values] of Object.entries(entries))if((name===prefix||name.startsWith(prefix+'_'))&&JSON.stringify(values)===JSON.stringify(pack.entries))return {entries:structuredClone(entries),name,added:false};
 let name=prefix,index=2;while(Object.hasOwn(entries,name))name=`${prefix}_${index++}`;
 return {entries:{...structuredClone(entries),[name]:[...pack.entries]},name,added:true};
}
