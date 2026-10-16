/** One `/history/{prompt_id}` entry, as ComfyUI reports it. */
export interface HistoryEntry {
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: Array<
      [string, { exception_message?: string; exception_type?: string; node_id?: string; node_type?: string }]
    >;
  };
}

/** The terminal facts a history entry carries, read the same way for images and video. */
export function historyOutcome(entry: HistoryEntry) {
  const messages = entry.status?.messages ?? [];
  const failure = messages.find(([kind]) => kind === 'execution_error')?.[1];
  const interrupted = messages.some(([kind]) => kind === 'execution_interrupted');
  const failed = entry.status?.status_str === 'error' || Boolean(failure);
  let error = failure?.exception_message?.trim() || undefined;
  // Name the failing node so "CUDA out of memory" or a bad input points at a real step.
  if (error && failure?.node_type)
    error += ` (in ${failure.node_type}${failure.node_id ? ` node ${failure.node_id}` : ''})`;
  return { failed, interrupted, error, finished: Boolean(entry.status?.completed) || failed || interrupted };
}
