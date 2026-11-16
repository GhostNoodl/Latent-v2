import type { VideoWorkflowContract } from './video-types';
export interface VideoOutputCandidate {
  nodeId: '15';
  filename: string;
  subfolder: '';
  type: 'output';
}
/** Picks this job's MP4 out of the engine's reply; the caller still checks the file on disk. */
export function videoOutputCandidates(outputs: unknown, contract: VideoWorkflowContract): VideoOutputCandidate[] {
  if (!/^Latent_[a-f0-9]{32}_video$/.test(contract.output.filenamePrefix) || contract.output.nodeId !== '15')
    throw new Error('The video output settings are invalid.');
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs))
    throw new Error('The engine sent back an unexpected result.');
  const output = (outputs as Record<string, unknown>)[contract.output.nodeId];
  if (output === undefined) return [];
  if (!output || typeof output !== 'object' || Array.isArray(output))
    throw new Error('The engine sent back an unexpected video result.');
  const value = output as { images?: unknown };
  if (!Array.isArray(value.images) || value.images.length > 1)
    throw new Error('The engine sent back more than one video.');
  const pattern = new RegExp(`^${contract.output.filenamePrefix}_[0-9]{5,10}_\\.mp4$`);
  return value.images.map(candidate => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof candidate.filename !== 'string' ||
      !pattern.test(candidate.filename) ||
      candidate.subfolder !== '' ||
      candidate.type !== 'output'
    )
      throw new Error('The engine sent back a video that isn’t this job’s.');
    return { nodeId: '15', filename: candidate.filename, subfolder: '', type: 'output' };
  });
}
