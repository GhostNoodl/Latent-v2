import { z } from 'zod';
import type { AssistantAction, AssistantOption, AssistantRequest } from '../../shared/assistant-types';
import { IMAGE_MODELS } from '../../shared/image-models';

/** A message in a provider-neutral shape. Images only ever ride on the last user message. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  image?: { mediaType: 'image/jpeg' | 'image/png'; base64: string };
}

/** The reply we ask every provider for. */
export const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    prompts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { prompt: { type: 'string' }, negativePrompt: { type: 'string' } },
        required: ['prompt', 'negativePrompt'],
      },
    },
  },
  required: ['message', 'prompts'],
} as const;

const replySchema = z.object({
  message: z.string().trim().max(4000).default(''),
  prompts: z
    .array(z.object({ prompt: z.string().trim().max(8000), negativePrompt: z.string().max(8000).default('') }))
    .max(6)
    .default([]),
});

const BASE = `You are the prompt assistant inside Latent, a desktop app that makes pictures and video clips with local AI models. You are an experienced, practical prompt writer. Your job is to help the person get the picture in their head, written the way the current model understands best.

How to answer
- Reply with one JSON object and nothing else: {"message": "...", "prompts": [{"prompt": "...", "negativePrompt": "..."}]}.
- message: one to three short, friendly sentences in plain words. Say what you changed and why, or answer their question. No lists, no headings, no hype.
- prompts: complete prompts that replace the current ones, ready to use as they are. Never write instructions, diffs or placeholders in them.
- Give exactly one option, unless you are asked for variations.
- If the person only asks a question and changing the prompt would not help, return the current prompts unchanged as the one option and answer in message.

Ground rules
- Keep the person's subject, characters, style and intent. Add detail that serves their idea; never swap it for a different idea.
- The person is an adult making art on their own PC. Keep the rating they asked for. Do not add or remove nudity, gore or violence on your own.
- You can't change settings like size, steps, seed, sampler or model. If one of them really matters, mention it briefly in message.`;

const SYNTAX = `Prompt syntax, always follow it
- Copy every item in keepExactly into the prompt unchanged: LoRA trigger words, __wildcard__ names and {a|b} choice groups. Never reword, split, translate or expand them.
- (words:1.2) is a weight. Keep weights unless asked to change emphasis, and keep the (text:number) format.
- Keep BREAK and embedding:name tokens.
- loras lists the LoRA files in use. Never put their file names in the prompt.`;

const FAMILY_STYLE = {
  illustrious:
    'The model is an Illustrious (anime) checkpoint. Write comma-separated Danbooru tags with spaces instead of underscores, most important first: quality tags if the person uses them, count (1girl, 2boys), character and series, then appearance, outfit, pose, expression, setting, lighting, composition. No full sentences. A short plain-English phrase is fine where no tag exists.',
  sdxl: 'The model is an SDXL checkpoint. Write short descriptive phrases separated by commas, most important first: subject, then action, setting, lighting, colour, style and camera. Be concrete and visual. Avoid anime tag lists unless the person already writes that way.',
} as const;

const VIDEO = `You are writing for MiniMax H3, a video model. Write one clear paragraph of natural language that covers the subject, the scene, what moves and how it changes over time, and how the camera moves (static, slow push in, pan left, handheld, orbit and so on). Keep the action doable in the clip length you are given. Describe sound or speech only when audio is on and the person asks for it. H3 has no negative prompt, so negativePrompt is always an empty string. Do not use image tag lists or quality tags.
- Copy every item in keepExactly into the prompt unchanged.`;

const EDIT = `You are writing an edit instruction for Qwen Image Edit. It changes an existing picture by following a short instruction, so the instruction says what to do to the picture, not what the whole picture looks like.
- Write one to three short, plain sentences in the imperative: name exactly what to change (the object, its colour, material, shape, position, the light or the style) and say what must stay the same (the person's face and identity, pose, framing, background, style), unless the person wants those changed.
- If extra pictures are in use, call them picture 2 and picture 3, for example "Put the jacket from picture 2 on her."
- If only a painted part of the picture is being edited, write about that part only.
- No tag lists, no quality words like masterpiece, no weights.
- negativePrompt is always an empty string.
- If a picture is attached, it is the picture being edited. Use it to name what is really there.`;

const EDIT_TASKS: Partial<Record<AssistantAction, string>> = {
  improve:
    "Rewrite the edit instruction so the edit model gets it right first time: clear, specific, and saying what to keep. Keep the person's intent and every detail they asked for.",
  describe: 'Look at the attached picture and suggest one useful edit instruction for it.',
};

const ACTIONS: Record<AssistantAction, { image: string; video: string; label: string }> = {
  chat: { label: 'Chat', image: '', video: '' },
  improve: {
    label: 'Improve',
    image:
      'Make the current prompt work better for this model: a clear subject, strong composition, and specific lighting, colour and style. Fix order and wording, drop filler and repeats. Keep it about as long as it is, a little longer is fine.',
    video:
      'Make the current prompt work better for H3: a clear subject, a readable action that fits the clip, and a specific camera move. Drop filler and repeats.',
  },
  expand: {
    label: 'More detail',
    image:
      'Add rich, specific detail that fits the idea: setting, lighting, mood, materials, colours, framing and lens. Roughly double the detail. Keep the main subject first.',
    video:
      'Add specific detail: what the scene looks like, how the motion unfolds beat by beat, the light and mood, and the camera move. Keep it to what fits the clip length.',
  },
  shorten: {
    label: 'Shorter',
    image:
      'Cut the prompt down to what matters. Remove repeats, filler and conflicting words. Keep the most important parts first.',
    video: 'Cut the prompt down to what matters: subject, main action and camera. Remove repeats and filler.',
  },
  tags: {
    label: 'As tags',
    image: 'Rewrite the prompt as comma-separated Danbooru-style tags (spaces, not underscores). Keep the meaning.',
    video: 'Rewrite the prompt as one clear paragraph. Video prompts work best as sentences, not tags.',
  },
  sentences: {
    label: 'As sentences',
    image: 'Rewrite the prompt as clear, natural sentences. Keep every detail that matters.',
    video: 'Rewrite the prompt as one clear paragraph in natural sentences.',
  },
  variations: {
    label: 'Variations',
    image:
      'Give exactly 3 options. Each keeps the core idea but changes one or two big things, for example setting, lighting, camera angle, mood or outfit. Make them really different from each other. In message, say in a few words what each one changes.',
    video:
      'Give exactly 3 options. Each keeps the core idea but changes the action, the camera move or the mood. Make them really different from each other. In message, say in a few words what each one changes.',
  },
  describe: {
    label: 'From picture',
    image:
      'Look at the attached picture and write a prompt that would recreate it with this model: subject, look, clothing, pose, expression, setting, lighting, colours, style and framing. Keep any keepExactly items from the current prompt. If the picture is unclear, say so in message.',
    video:
      'The attached picture is the first frame of the clip. Write a video prompt that starts from it: name what is in the frame in a few words, then describe the motion and the camera move. If the person typed what should happen, build on that.',
  },
  motion: {
    label: 'Motion and camera',
    image: 'Improve the composition and the camera angle. Keep the subject and style.',
    video:
      'Improve the movement and the camera work: make the motion specific and natural, give it a clear start and end, and pick one fitting camera move. Keep the subject and style.',
  },
};

export function actionLabel(action: AssistantAction) {
  return ACTIONS[action].label;
}

/** At CFG 1 (or with models that zero it out) the negative prompt has no effect. */
export function negativeIgnored(draft: AssistantRequest['draft']) {
  const model = draft.imageModel ? IMAGE_MODELS[draft.imageModel] : undefined;
  return model?.negative === 'zero' || (Number.isFinite(draft.cfg) && draft.cfg <= 1);
}

function imageModelGuide(request: AssistantRequest): string {
  const draft = request.draft;
  const model = draft.imageModel ? IMAGE_MODELS[draft.imageModel] : undefined;
  if (!model) {
    const family = FAMILY_STYLE[draft.family] ?? FAMILY_STYLE.sdxl;
    const ignored = negativeIgnored(draft)
      ? '\nCFG is 1, so the negative prompt does nothing. Return it unchanged.'
      : '';
    return `Writing for this model\n${family}${request.checkpointName ? `\nCheckpoint: ${request.checkpointName}.` : ''}${ignored}`;
  }
  const lines = [`The model is ${model.name} by ${model.guide.maker}. ${model.blurb}`, ...model.guide.tips];
  if (model.guide.qualityTags) lines.push(`Its house look starts with: ${model.guide.qualityTags}`);
  if (negativeIgnored(draft))
    lines.push(
      'With these settings the model ignores the negative prompt, so return the current negative prompt unchanged.',
    );
  return `Writing for this model\n${lines.map(line => `- ${line}`).join('\n')}`;
}

export function systemPrompt(request: AssistantRequest): string {
  if (request.target === 'video') return `${BASE}\n\n${VIDEO}`;
  if (request.target === 'edit') return `${BASE}\n\n${EDIT}`;
  return `${BASE}\n\n${imageModelGuide(request)}\n\n${SYNTAX}`;
}

const WILDCARD = /__[A-Za-z0-9_\-/. ]+?__/g;

/** Pulls out top-level {a|b} groups, allowing nested braces inside them. */
export function choiceGroups(text: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '{') {
      if (depth++ === 0) start = index;
    } else if (text[index] === '}' && depth > 0 && --depth === 0) {
      const group = text.slice(start, index + 1);
      if (group.includes('|')) groups.push(group);
    }
  }
  return groups;
}

/** Text the assistant must copy unchanged: trigger words in the prompt, wildcards and choice groups. */
export function protectedParts(request: Pick<AssistantRequest, 'draft'>): string[] {
  const prompt = request.draft.prompt;
  const triggers = request.draft.loras.flatMap(lora => request.draft.triggerWords?.[lora.modelId] ?? []);
  const spans = (request.draft.promptTriggerSpans ?? []).map(span => span.word);
  const groups = choiceGroups(prompt);
  const wildcards = (prompt.match(WILDCARD) ?? []).filter(name => !groups.some(group => group.includes(name)));
  const present = [...triggers, ...spans].filter(word => word.trim() && prompt.includes(word));
  return [...new Set([...present, ...groups, ...wildcards])].slice(0, 60);
}

export function missingProtectedParts(request: Pick<AssistantRequest, 'draft'>, proposal: string): string[] {
  return protectedParts(request).filter(part => !proposal.includes(part));
}

/** The person's turn: what to do, then the current state as JSON. */
export function userTurn(request: AssistantRequest): string {
  const task =
    request.action === 'chat'
      ? ''
      : request.target === 'edit'
        ? (EDIT_TASKS[request.action] ?? ACTIONS[request.action].image)
        : ACTIONS[request.action][request.target];
  const typed = request.instruction?.trim();
  const ask = [task, typed && (task ? `The person adds: ${typed}` : typed)].filter(Boolean).join('\n');
  const context =
    request.target === 'edit'
      ? { currentInstruction: request.draft.prompt }
      : request.target === 'video'
        ? {
            mode: request.videoContext?.mode === 'img2vid' ? 'picture to video' : 'text to video',
            clipSeconds: request.videoContext?.requestedDurationSeconds,
            audio: request.videoContext?.audio === 'stereo-candidate' ? 'on' : 'off',
            currentPrompt: request.draft.prompt,
            keepExactly: protectedParts(request),
          }
        : {
            loras: request.loraNames ?? [],
            currentPrompt: request.draft.prompt,
            currentNegativePrompt: request.draft.negativePrompt,
            keepExactly: protectedParts(request),
          };
  return `${ask || (request.target === 'edit' ? 'Improve the edit instruction.' : 'Improve the current prompt.')}\n\nCurrent state:\n${JSON.stringify(context, null, 1)}`;
}

/** Builds the conversation, trimming old turns to stay under a rough character budget. */
export function buildConversation(request: AssistantRequest, characterBudget: number): ChatMessage[] {
  const current: ChatMessage = { role: 'user', text: userTurn(request) };
  const history = [...(request.history ?? [])].slice(-12);
  const fits = () =>
    systemPrompt(request).length + current.text.length + history.reduce((n, turn) => n + turn.content.length, 0) <=
    characterBudget;
  while (history.length && !fits()) history.shift();
  // Conversations must start with the person.
  while (history[0]?.role === 'assistant') history.shift();
  return [...history.map(turn => ({ role: turn.role, text: turn.content })), current];
}

function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

/** Reads the finished reply. Tolerates code fences, thinking tags and chatter around the JSON. */
export function parseReply(text: string): { message: string; prompts: Array<Omit<AssistantOption, 'dropped'>> } {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  for (const candidate of [cleaned, firstJsonObject(cleaned)]) {
    if (!candidate) continue;
    try {
      const parsed = replySchema.parse(JSON.parse(candidate));
      return { message: parsed.message, prompts: parsed.prompts.filter(option => option.prompt) };
    } catch {
      /* Try the next shape. */
    }
  }
  throw new Error('The assistant sent a reply Latent could not read. Try again.');
}

/** Reads a string field out of JSON that is still being written. */
function partialString(text: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!match) return undefined;
  let value = '';
  for (let index = match.index + match[0].length; index < text.length; index++) {
    const char = text[index];
    if (char === '"') return value;
    if (char !== '\\') {
      value += char;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) return value;
    if (next === 'u') {
      const hex = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return value;
      value += String.fromCharCode(parseInt(hex, 16));
      index += 5;
    } else {
      value += ({ n: '\n', t: '\t', r: '', b: '', f: '' } as Record<string, string>)[next] ?? next;
      index += 1;
    }
  }
  return value;
}

/** What to show while the reply streams in. */
export function partialReply(text: string): { message?: string; prompt?: string } {
  const message = partialString(text, 'message');
  const prompt = partialString(text, 'prompt');
  return { ...(message !== undefined ? { message } : {}), ...(prompt !== undefined ? { prompt } : {}) };
}
