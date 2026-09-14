import { z } from 'zod';
import type { ModelService } from './models';
import type { CivitaiCatalog } from './civitai-catalog';
import { safeModelTransferError } from './model-transfers';
import type { ModelTransferRetryRequest } from '../shared/model-transfer-types';

const retrySchema = z.object({ id: z.uuid(), url: z.url().max(4000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, 'Enter a fresh HTTPS URL without embedded credentials.').optional() }).strict();
interface Dependencies {
  models: Pick<ModelService, 'library' | 'transferRecovery' | 'retryTransfer' | 'cancelDownload' | 'downloads'>;
  civitai: Pick<CivitaiCatalog, 'retryTransfer'>;
  assertReady(): void;
  completed?(name: string): void;
  failed?(message: string): void;
  changed?(): void;
}

/** Desktop handlers own cancellation during source refresh as well as payload transfer. */
export class ModelTransferActions {
  private active = new Map<string, AbortController>();
  constructor(private dependencies: Dependencies) {}
  recovery() { return { ...this.dependencies.models.transferRecovery(), preparing: [...this.active.keys()] }; }
  async retry(input: ModelTransferRetryRequest): Promise<void> {
    const request = retrySchema.parse(input); const { models, civitai } = this.dependencies;
    if (this.active.has(request.id) || models.downloads.some(item => item.id === request.id && ['downloading', 'verifying'].includes(item.state))) throw new Error('This transfer is already active.');
    const saved = models.transferRecovery().transfers.find(item => item.id === request.id);
    if (!saved) throw new Error('The saved transfer is unavailable. Re-select its source to start a new download.');
    if (saved.state === 'completed') throw new Error('This transfer already completed. Refresh the verified model library.');
    if (saved.source.kind === 'refresh-required' && !saved.request.sha256) throw new Error('This expiring transfer has no saved expected checksum. Start a new download to review its replacement source.');
    if (request.url && saved.source.kind !== 'refresh-required') throw new Error('This transfer uses its recorded source. It does not accept a replacement URL.');
    if (!request.url && saved.source.kind === 'refresh-required') throw new Error('Enter a fresh URL for this same model file.');
    const controller = new AbortController(); this.active.set(request.id, controller); this.dependencies.changed?.();
    try {
      await models.library.withShared('retrying a saved model transfer', async () => {
        this.dependencies.assertReady(); controller.signal.throwIfAborted();
        if (saved.source.kind === 'civitai') await civitai.retryTransfer(request.id, controller.signal);
        else await models.retryTransfer(request.id, request.url ? async current => ({ request: { ...current.request, url: request.url! } }) : undefined, controller.signal);
      });
      this.dependencies.completed?.(saved.request.filename);
    } catch (error) {
      const text = controller.signal.aborted ? 'Transfer cancelled. Its saved request and any partial file remain available.' : safeModelTransferError(error, request.url ? { ...saved.request, url: request.url } : undefined);
      if (!controller.signal.aborted) this.dependencies.failed?.(text); throw new Error(text);
    } finally { this.active.delete(request.id); this.dependencies.changed?.(); }
  }
  async cancel(id: string): Promise<void> { z.uuid().parse(id); this.active.get(id)?.abort(); this.dependencies.models.cancelDownload(id); }
  dispose(): void { for (const controller of this.active.values()) controller.abort(); }
}
