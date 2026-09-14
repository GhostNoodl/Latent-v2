import type { VideoWorkflowContract } from './video-types';
export interface VideoOutputCandidate { nodeId: '15'; filename: string; subfolder: ''; type: 'output'; }
/** Own the declared SaveVideo node and prefix only; caller separately checks backend completion and disk identity. */
export function videoOutputCandidates(outputs: unknown, contract: VideoWorkflowContract): VideoOutputCandidate[] {
  if (!/^Latent_[a-f0-9]{32}_video$/.test(contract.output.filenamePrefix) || contract.output.nodeId !== '15' || contract.output.expectedCount !== 1 || contract.output.extension !== '.mp4') throw new Error('The video output contract is invalid.');
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) throw new Error('The video history outputs are malformed.');
  const output = (outputs as Record<string, unknown>)[contract.output.nodeId]; if (output === undefined) return [];
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new Error('The declared video output node returned malformed data.');
  const value = output as { images?: unknown; animated?: unknown };
  if (!Array.isArray(value.images) || value.images.length > 1 || value.animated !== undefined && (!Array.isArray(value.animated) || value.animated.length !== 1 || value.animated[0] !== true)) throw new Error('The declared video output count or animation metadata is invalid.');
  const pattern = new RegExp(`^${contract.output.filenamePrefix}_[0-9]{5,10}_\\.mp4$`);
  return value.images.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.filename !== 'string' || !pattern.test(candidate.filename) || candidate.subfolder !== '' || candidate.type !== 'output') throw new Error('The backend returned an unowned or unsupported video output.');
    return { nodeId: '15', filename: candidate.filename, subfolder: '', type: 'output' };
  });
}
