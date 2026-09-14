import type { BackendStatus, StudioJob } from '../shared/types';
import type { ModelLibraryLease } from './model-library-lease';

/** Use the same library lease as engine start, enqueue and compatible-set updates. */
export async function activateIPAdapterWhenIdle(
  library: ModelLibraryLease,
  backend: { status(): BackendStatus },
  jobs: { jobs(): StudioJob[] },
  service: { activate(): Promise<unknown> },
  assertAllowed?: () => void,
): Promise<void> {
  await library.withExclusive('activating reference tools', async () => {
    assertAllowed?.();
    if (backend.status().state !== 'stopped') throw new Error('Stop the image engine before activating reference tools.');
    if (jobs.jobs().some(job => ['queued', 'running'].includes(job.status))) throw new Error('Finish or cancel queued and running jobs before activating reference tools.');
    await service.activate();
  });
}
