import { videoConversationSchema, type VideoConversation, type VideoEditorSession } from '../shared/video-conversation';
import type { VideoDraft } from '../shared/video-types';

function targetSession(conversation: VideoConversation, create: () => VideoEditorSession) {
  videoConversationSchema.parse(conversation);
  const existing = conversation.sessions.find(item => item.id === conversation.activeSessionId) ?? conversation.sessions[0];
  if (existing) return { session: existing, sessions: conversation.sessions };
  if (conversation.sessions.length >= 50) throw new Error('All 50 video draft slots are in use. Choose a saved draft first.');
  const session = create();
  return { session, sessions: [...conversation.sessions, session] };
}

export function selectVideoHistory(conversation: VideoConversation, recordId: string, create: () => VideoEditorSession): VideoConversation {
  const { session, sessions } = targetSession(conversation, create);
  return videoConversationSchema.parse({ ...conversation, activeSessionId: session.id, sessions: sessions.map(item => item.id === session.id ? { ...item, selectedRecordId: recordId, updatedAt: new Date().toISOString() } : item) });
}

export function applyVideoHistoryRestore(conversation: VideoConversation, draft: VideoDraft, recordId: string, requestedRevision: number, currentRevision: number, create: () => VideoEditorSession) {
  if (requestedRevision !== currentRevision) throw new Error('Your video draft or selection changed while loading the saved recipe. Reuse it again when ready.');
  const { session, sessions } = targetSession(conversation, create);
  const previous = { id: session.id, draft: structuredClone(session.draft) };
  const value = videoConversationSchema.parse({ ...conversation, activeSessionId: session.id, sessions: sessions.map(item => item.id === session.id ? { ...item, draft: structuredClone(draft), selectedRecordId: recordId, updatedAt: new Date().toISOString() } : item) });
  return { conversation: value, previous };
}
