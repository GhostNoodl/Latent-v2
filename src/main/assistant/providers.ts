import Anthropic from '@anthropic-ai/sdk';
import type { AssistantModelOption, CloudProviderId } from '../../shared/assistant-types';
import { REPLY_SCHEMA, type ChatMessage } from './prompts';

export interface StreamArgs {
  system: string;
  messages: ChatMessage[];
  signal: AbortSignal;
  /** Called with the whole text so far each time more arrives. */
  onText: (text: string) => void;
}

/** Turns a provider's error into something a person can act on. Never includes the key. */
export class AssistantProviderError extends Error {}

const keyHint = (name: string) => `${name} didn't accept the key. Check it in Settings, Assistant.`;

/** Claude through the official SDK. */
export async function streamClaude(key: string, model: string, args: StreamArgs): Promise<string> {
  const client = new Anthropic({ apiKey: key, maxRetries: 1 });
  // Fallback models take over when a safety check declines; Haiku has no server-side fallback.
  const fallback = /^claude-(opus|sonnet)-5-5$/.test(model);
  try {
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 16000,
        system: args.system,
        messages: args.messages.map(message => ({
          role: message.role,
          content: message.image
            ? [
                {
                  type: 'image' as const,
                  source: { type: 'base64' as const, media_type: message.image.mediaType, data: message.image.base64 },
                },
                { type: 'text' as const, text: message.text },
              ]
            : message.text,
        })),
        output_config: { effort: 'low', format: { type: 'json_schema', schema: { ...REPLY_SCHEMA } } },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { signal: args.signal },
    );
    stream.on('text', (_delta, snapshot) => args.onText(snapshot));
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal')
      throw new AssistantProviderError(
        'Claude declined this one. Try rewording it, or switch to another assistant in Settings for this kind of prompt.',
      );
    if (final.stop_reason === 'max_tokens')
      throw new AssistantProviderError('The reply ran too long and was cut off. Try asking for less.');
    return final.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
  } catch (error) {
    args.signal.throwIfAborted();
    if (error instanceof AssistantProviderError) throw error;
    if (error instanceof Anthropic.AuthenticationError) throw new AssistantProviderError(keyHint('Claude'));
    if (error instanceof Anthropic.PermissionDeniedError)
      throw new AssistantProviderError('Your Claude key is not allowed to use this model.');
    if (error instanceof Anthropic.NotFoundError)
      throw new AssistantProviderError(`Claude doesn't know the model "${model}". Pick another in Settings.`);
    if (error instanceof Anthropic.RateLimitError)
      throw new AssistantProviderError('Claude says slow down (rate limit). Wait a moment and try again.');
    if (error instanceof Anthropic.BadRequestError)
      throw new AssistantProviderError(`Claude couldn't take that request: ${error.message.slice(0, 300)}`);
    if (error instanceof Anthropic.APIConnectionError)
      throw new AssistantProviderError("Couldn't reach Claude. Check your internet connection.");
    if (error instanceof Anthropic.APIError)
      throw new AssistantProviderError(`Claude had a problem (${error.status ?? 'no status'}). Try again in a moment.`);
    throw error;
  }
}

export interface OpenAIStyleTarget {
  name: string;
  baseUrl: string;
  key?: string;
  model: string;
  headers?: Record<string, string>;
  /** Extra fields for the request, used by the local server. */
  extraBody?: Record<string, unknown>;
  /** Some servers don't do JSON schemas; start lower for them. */
  format?: 'schema' | 'object' | 'none';
}

function openAIMessages(system: string, messages: ChatMessage[]) {
  return [
    { role: 'system', content: system },
    ...messages.map(message => ({
      role: message.role,
      content: message.image
        ? [
            { type: 'text', text: message.text },
            {
              type: 'image_url',
              image_url: { url: `data:${message.image.mediaType};base64,${message.image.base64}` },
            },
          ]
        : message.text,
    })),
  ];
}

const responseFormats = {
  schema: { type: 'json_schema', json_schema: { name: 'prompt_reply', strict: true, schema: REPLY_SCHEMA } },
  object: { type: 'json_object' },
  none: undefined,
} as const;

function trimUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

async function errorText(response: Response) {
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body);
      const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
      if (typeof message === 'string') return message.slice(0, 300);
    } catch {
      /* Plain text body. */
    }
    return body.slice(0, 300);
  } catch {
    return '';
  }
}

function statusError(target: OpenAIStyleTarget, status: number, detail: string) {
  if (status === 401 || status === 403) return new AssistantProviderError(keyHint(target.name));
  if (status === 402)
    return new AssistantProviderError(`${target.name} says the account is out of credit. Top it up and try again.`);
  if (status === 404)
    return new AssistantProviderError(
      `${target.name} doesn't know the model "${target.model}". Pick another in Settings.`,
    );
  if (status === 429)
    return new AssistantProviderError(`${target.name} says slow down (rate limit). Wait a moment and try again.`);
  return new AssistantProviderError(
    `${target.name} had a problem (HTTP ${status})${detail ? `: ${detail}` : ''}. Try again in a moment.`,
  );
}

/** OpenAI-style chat streaming: OpenAI, Gemini, OpenRouter, LM Studio, Ollama and the local llama.cpp server. */
export async function streamOpenAIStyle(target: OpenAIStyleTarget, args: StreamArgs): Promise<string> {
  const formats: Array<keyof typeof responseFormats> =
    target.format === 'none'
      ? ['none']
      : target.format === 'object'
        ? ['object', 'none']
        : ['schema', 'object', 'none'];
  for (let attempt = 0; ; attempt++) {
    const format = formats[attempt];
    let response: Response;
    try {
      response = await fetch(`${trimUrl(target.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}),
          ...target.headers,
        },
        body: JSON.stringify({
          model: target.model,
          messages: openAIMessages(args.system, args.messages),
          stream: true,
          ...(responseFormats[format] ? { response_format: responseFormats[format] } : {}),
          ...target.extraBody,
        }),
        signal: args.signal,
      });
    } catch (error) {
      args.signal.throwIfAborted();
      throw new AssistantProviderError(`Couldn't reach ${target.name}. Check the connection or the address.`, {
        cause: error,
      });
    }
    if (!response.ok) {
      const detail = await errorText(response);
      // Servers that can't do structured replies say so with a 400 or 422; ask more simply.
      if ((response.status === 400 || response.status === 422) && attempt < formats.length - 1) continue;
      throw statusError(target, response.status, detail);
    }
    return readEventStream(target, response, args);
  }
}

async function readEventStream(target: OpenAIStyleTarget, response: Response, args: StreamArgs) {
  if (!response.body) throw new AssistantProviderError(`${target.name} sent an empty reply.`);
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finish: string | undefined;
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error)
      throw new AssistantProviderError(`${target.name} hit an error: ${String(chunk.error.message ?? 'unknown')}`);
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
      content += choice.delta.content;
      args.onText(content);
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
  };
  try {
    for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(piece, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
      }
    }
    handle(buffer.trim());
  } catch (error) {
    args.signal.throwIfAborted();
    if (error instanceof AssistantProviderError) throw error;
    throw new AssistantProviderError(`Lost the connection to ${target.name}. Try again.`, { cause: error });
  }
  if (finish === 'length')
    throw new AssistantProviderError('The reply ran too long and was cut off. Try asking for less.');
  if (finish === 'content_filter')
    throw new AssistantProviderError(
      `${target.name} declined this one. Try rewording it, or switch to another assistant in Settings.`,
    );
  return content;
}

const NOT_CHAT =
  /embed|tts|whisper|dall-e|davinci|babbage|moderation|audio|realtime|transcribe|imagen|veo|image-generation|-image|search|computer-use|aqa|live|learnlm|native-audio/i;

/** Asks an OpenAI-style server which models it has. */
export async function listOpenAIStyleModels(
  provider: CloudProviderId,
  target: Pick<OpenAIStyleTarget, 'name' | 'baseUrl' | 'key' | 'headers'>,
  signal: AbortSignal,
): Promise<AssistantModelOption[]> {
  let response: Response;
  try {
    response = await fetch(`${trimUrl(target.baseUrl)}/models`, {
      headers: { ...(target.key ? { Authorization: `Bearer ${target.key}` } : {}), ...target.headers },
      signal,
    });
  } catch (error) {
    signal.throwIfAborted();
    throw new AssistantProviderError(`Couldn't reach ${target.name}. Check the connection or the address.`, {
      cause: error,
    });
  }
  if (!response.ok)
    throw statusError({ ...target, model: '' }, response.status, await errorText(response).catch(() => ''));
  const body: any = await response.json().catch(() => ({}));
  const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  const options = rows
    .map(row => {
      const id = String(row?.id ?? row?.name ?? '').replace(/^models\//, '');
      if (!id || id.length > 300) return undefined;
      const modalities: unknown = row?.architecture?.input_modalities;
      const vision = Array.isArray(modalities)
        ? modalities.includes('image')
        : provider === 'gemini' || (provider === 'openai' && /^(gpt-4o|gpt-4\.1|gpt-5|o\d)/.test(id))
          ? true
          : undefined;
      const name = typeof row?.name === 'string' && provider === 'openrouter' ? row.name : id;
      return { id, name, ...(vision !== undefined ? { vision } : {}) } satisfies AssistantModelOption;
    })
    .filter((option): option is AssistantModelOption => Boolean(option))
    .filter(option => provider === 'custom' || provider === 'openrouter' || !NOT_CHAT.test(option.id))
    .filter(option => provider !== 'gemini' || /gemini|gemma/.test(option.id));
  return options.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).slice(0, 1000);
}
