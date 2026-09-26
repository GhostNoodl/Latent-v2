import type { GenerationDraft } from './types';
export interface PromptTriggerSpan { start:number; text:string; word:string; }
const key=(word:string)=>word.trim().toLowerCase();
const literal=(word:string,dynamic:boolean)=>dynamic?word.replace(/[\\{}|_]/g,'\\$&'):word;
const valid=(prompt:string,span:PromptTriggerSpan)=>prompt.slice(span.start,span.start+span.text.length)===span.text;
/** One contiguous edit: affected spans become user-owned; unchanged spans shift. */
function rebase(before:string,after:string,spans:PromptTriggerSpan[]):PromptTriggerSpan[] {
 if(before===after)return spans.filter(s=>valid(before,s)).map(s=>({...s}));
 let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
 let end=before.length,nextEnd=after.length;while(end>start&&nextEnd>start&&before[end-1]===after[nextEnd-1]){end--;nextEnd--;}
 return spans.filter(s=>valid(before,s)).flatMap(s=>{
   if(start===end) {
     const inserted=after.slice(start,nextEnd);
     if(start===s.start&&!/[,;\n]\s*$/.test(inserted))return [];
     if(start===s.start+s.text.length&&!s.text.endsWith(', ')&&/^[\p{L}\p{N}\p{M}\p{Pc}]/u.test(inserted))return [];
   }
   if(s.start+s.text.length<=start)return [{...s}];
   if(s.start>=end)return [{...s,start:s.start+after.length-before.length}];
   return [];
 }).filter(s=>valid(after,s));
}
export function reconcileVisibleTriggers(previous:GenerationDraft,next:GenerationDraft):GenerationDraft {
 if(next.triggerResolutionVersion!=='visible@3')return next;
 // Explicit recipe replacements retain their supplied ownership, not the old composer's.
 const spans=rebase(previous.prompt,next.prompt,previous.promptTriggerSpans??[]);
 const chosen=(d:GenerationDraft)=>d.autoTriggers?d.loras.flatMap(l=>d.triggerWords?.[l.modelId]??[]):[];
 const words=[...new Map(chosen(next).map(w=>[key(w),w.trim()])).values()].filter(Boolean);
 const changed=JSON.stringify(chosen(previous))!==JSON.stringify(chosen(next))||!!previous.dynamicPrompts?.enabled!==!!next.dynamicPrompts?.enabled;
 if(!changed)return {...next,promptTriggerSpans:spans};
 let prompt=next.prompt,owned=spans;
 const wanted=new Set(words.map(key));
 for(const span of [...owned].sort((a,b)=>b.start-a.start)) {
   const spelling=literal(span.word,!!next.dynamicPrompts?.enabled);
   if(wanted.has(key(span.word))&&(span.text===spelling||span.text===spelling+', '))continue;
   prompt=prompt.slice(0,span.start)+prompt.slice(span.start+span.text.length);
   owned=owned.filter(s=>s!==span).map(s=>s.start>span.start?{...s,start:s.start-span.text.length}:s);
 }
 // Strip only a delimiter that belongs to an inserted span, never user punctuation.
 const last=owned.find(s=>s.start+s.text.length===prompt.length&&s.text.endsWith(', '));
 if(last){prompt=prompt.slice(0,-2);last.text=last.text.slice(0,-2);}
 for(const word of [...words].reverse()) {
   if(owned.some(s=>key(s.word)===key(word)))continue;
   const text=literal(word,!!next.dynamicPrompts?.enabled);
   const escaped=text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
   if(new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}\\p{Pc}])${escaped}(?=$|[^\\p{L}\\p{N}\\p{M}\\p{Pc}])`,'iu').test(prompt))continue;
   // Existing/manual text is never claimed. New selections alone insert text.
   if(chosen(previous).some(w=>key(w)===key(word))&&!owned.some(s=>key(s.word)===key(word))&&!!previous.dynamicPrompts?.enabled===!!next.dynamicPrompts?.enabled)continue;
   const insertion=text+(prompt?', ':'');
   if(prompt.length+insertion.length>16000)throw new Error('There is not enough room in the prompt for these triggers. Shorten the prompt or select fewer words.');
   owned=owned.map(s=>({...s,start:s.start+insertion.length}));owned.push({start:0,text:insertion,word});prompt=insertion+prompt;
 }
 return {...next,prompt,promptTriggerSpans:owned.sort((a,b)=>a.start-b.start)};
}
