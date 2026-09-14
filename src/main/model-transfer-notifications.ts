import { CivitaiError } from './civitai';
import { ModelTransferCancelledError } from './model-transfers';

/** Cancellation is a user action; HTTP, validation and storage failures still need attention. */
export function modelTransferNeedsAttention(error: unknown): boolean {
  return !(error instanceof ModelTransferCancelledError || (error instanceof CivitaiError && error.code === 'cancelled'));
}
