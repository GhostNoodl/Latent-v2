import { z } from 'zod';
import { assistantConversationSchema, conversationKey } from '../../shared/assistant-conversation';
import { CLOUD_PROVIDER_IDS, LOCAL_ASSISTANT_MODEL_IDS } from '../../shared/assistant-catalog';
import type { CloudProviderId, LocalAssistantModelId } from '../../shared/assistant-types';
import type { HandlerContext, StudioMethods } from '../main';

const provider = z.enum(CLOUD_PROVIDER_IDS as [CloudProviderId, ...CloudProviderId[]]);
const localModel = z.enum(LOCAL_ASSISTANT_MODEL_IDS as [LocalAssistantModelId, ...LocalAssistantModelId[]]);
const target = z.enum(['image', 'video']);

/** The prompt assistant in Create and Video, and its settings. */
export function assistantHandlers(ctx: HandlerContext) {
  return {
    assistantSuggest: async request => ctx.assistant.suggest(request),
    assistantCancel: async () => ctx.assistant.cancel(),
    assistantSaveSettings: async patch => ctx.assistant.saveSettings(z.record(z.string(), z.unknown()).parse(patch)),
    assistantSetKey: async (name, key) =>
      ctx.assistant.setKey(provider.parse(name), key === null ? null : z.string().max(4096).parse(key)),
    assistantListModels: async name => ctx.assistant.listModels(provider.parse(name)),
    assistantInstallLocal: async model => ctx.assistant.installLocal(localModel.optional().parse(model)),
    assistantCancelInstall: async () => ctx.assistant.local.cancelInstall(),
    assistantRemoveLocal: async model => ctx.assistant.local.remove(localModel.parse(model)),
    assistantStopLocal: async () => ctx.assistant.local.stop(),
    getAssistantConversation: async scope => {
      const saved = ctx.store.getState(conversationKey(target.parse(scope)), null);
      const parsed = assistantConversationSchema.safeParse(saved);
      return parsed.success ? parsed.data : null;
    },
    saveAssistantConversation: async (value, scope) => {
      ctx.store.setState(conversationKey(target.parse(scope)), assistantConversationSchema.parse(value));
    },
  } satisfies Partial<StudioMethods>;
}
