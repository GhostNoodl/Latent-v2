import { z } from 'zod';

export const SHOT_LIMIT = 40;
export const TAKE_LIMIT = 24;
const id = z.string().regex(/^[a-f0-9]{32}$/);

export const shotSchema = z
  .object({
    id: z.string().regex(/^shot-[a-z0-9]{6,24}$/),
    title: z.string().max(80),
    prompt: z.string().max(4000),
    /** Video jobs made for this shot; their saved clips are the takes. */
    jobIds: z.array(id).max(TAKE_LIMIT),
    keeperJobId: id.optional(),
  })
  .strict();
export const shotBoardSchema = z
  .object({ schema: z.literal(1), shots: z.array(shotSchema).max(SHOT_LIMIT) })
  .strict()
  .refine(board => new Set(board.shots.map(shot => shot.id)).size === board.shots.length, 'Shot ids must be unique.');

export type Shot = z.infer<typeof shotSchema>;
export type ShotBoard = z.infer<typeof shotBoardSchema>;
export const EMPTY_SHOT_BOARD: ShotBoard = { schema: 1, shots: [] };

export function newShot(prompt = '', title = ''): Shot {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => (byte % 36).toString(36)).join('');
  return { id: `shot-${random}`, title, prompt, jobIds: [] };
}

/** Add a take to a shot. A clip belongs to one shot, so it leaves any other shot first. */
export function addTake(board: ShotBoard, shotId: string, jobId: string): ShotBoard {
  const shots = board.shots.map(shot => {
    if (shot.id === shotId) {
      if (shot.jobIds.includes(jobId)) return shot;
      if (shot.jobIds.length >= TAKE_LIMIT)
        throw new Error(`A shot holds up to ${TAKE_LIMIT} takes. Remove one first.`);
      return { ...shot, jobIds: [...shot.jobIds, jobId] };
    }
    return shot.jobIds.includes(jobId) ? removeFromShot(shot, jobId) : shot;
  });
  return { ...board, shots };
}

function removeFromShot(shot: Shot, jobId: string): Shot {
  return {
    ...shot,
    jobIds: shot.jobIds.filter(item => item !== jobId),
    keeperJobId: shot.keeperJobId === jobId ? undefined : shot.keeperJobId,
  };
}

export function removeTake(board: ShotBoard, shotId: string, jobId: string): ShotBoard {
  return { ...board, shots: board.shots.map(shot => (shot.id === shotId ? removeFromShot(shot, jobId) : shot)) };
}

/** Star a take, or clear the star when it is already the keeper. */
export function toggleKeeper(board: ShotBoard, shotId: string, jobId: string): ShotBoard {
  return {
    ...board,
    shots: board.shots.map(shot =>
      shot.id === shotId && shot.jobIds.includes(jobId)
        ? { ...shot, keeperJobId: shot.keeperJobId === jobId ? undefined : jobId }
        : shot,
    ),
  };
}

export function moveShot(board: ShotBoard, shotId: string, by: -1 | 1): ShotBoard {
  const index = board.shots.findIndex(shot => shot.id === shotId);
  const target = index + by;
  if (index < 0 || target < 0 || target >= board.shots.length) return board;
  const shots = [...board.shots];
  [shots[index], shots[target]] = [shots[target], shots[index]];
  return { ...board, shots };
}

/** The clip to play for each shot, in board order: the keeper, else the newest finished take. */
export function playlist<T extends { jobId: string }>(board: ShotBoard, clips: T[]): Array<{ shot: Shot; clip: T }> {
  const byJob = new Map(clips.map(clip => [clip.jobId, clip]));
  return board.shots.flatMap(shot => {
    const keeper = shot.keeperJobId && byJob.get(shot.keeperJobId);
    const fallback = [...shot.jobIds].reverse().find(job => byJob.has(job));
    const clip = keeper || (fallback ? byJob.get(fallback) : undefined);
    return clip ? [{ shot, clip }] : [];
  });
}
