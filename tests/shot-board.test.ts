import { describe, expect, it } from 'vitest';
import {
  addTake,
  EMPTY_SHOT_BOARD,
  moveShot,
  newShot,
  playlist,
  removeTake,
  shotBoardSchema,
  TAKE_LIMIT,
  toggleKeeper,
  type ShotBoard,
} from '../src/shared/shot-board';

const job = (n: number) => n.toString(16).padStart(32, '0');
const board = (): ShotBoard => ({
  schema: 1,
  shots: [
    { ...newShot('a fox runs', 'Opening'), id: 'shot-aaaaaa' },
    { ...newShot('the fox sleeps'), id: 'shot-bbbbbb' },
  ],
});

describe('shot board', () => {
  it('keeps takes on one shot and stars a keeper', () => {
    let value = addTake(board(), 'shot-aaaaaa', job(1));
    value = addTake(value, 'shot-aaaaaa', job(2));
    value = toggleKeeper(value, 'shot-aaaaaa', job(1));
    expect(value.shots[0]).toMatchObject({ jobIds: [job(1), job(2)], keeperJobId: job(1) });
    // Moving a clip to another shot takes it (and its star) off the first.
    value = addTake(value, 'shot-bbbbbb', job(1));
    expect(value.shots[0]).toMatchObject({ jobIds: [job(2)], keeperJobId: undefined });
    expect(value.shots[1].jobIds).toEqual([job(1)]);
    expect(toggleKeeper(value, 'shot-bbbbbb', job(9))).toEqual(value);
    expect(toggleKeeper(toggleKeeper(value, 'shot-bbbbbb', job(1)), 'shot-bbbbbb', job(1)).shots[1].keeperJobId).toBe(
      undefined,
    );
    expect(removeTake(value, 'shot-bbbbbb', job(1)).shots[1].jobIds).toEqual([]);
    expect(shotBoardSchema.parse(value)).toEqual(value);
  });

  it('plays the keeper, else the newest finished take, in board order', () => {
    let value = addTake(addTake(board(), 'shot-aaaaaa', job(1)), 'shot-aaaaaa', job(2));
    value = addTake(value, 'shot-bbbbbb', job(3));
    const clips = [{ jobId: job(1) }, { jobId: job(3) }];
    expect(playlist(value, clips).map(item => item.clip.jobId)).toEqual([job(1), job(3)]);
    value = moveShot(value, 'shot-bbbbbb', -1);
    expect(playlist(value, clips).map(item => item.clip.jobId)).toEqual([job(3), job(1)]);
    expect(moveShot(value, 'shot-bbbbbb', -1)).toBe(value);
    value = toggleKeeper(value, 'shot-aaaaaa', job(2));
    expect(playlist(value, [...clips, { jobId: job(2) }]).map(item => item.clip.jobId)).toEqual([job(3), job(2)]);
  });

  it('caps takes and refuses bad boards', () => {
    let value = board();
    for (let i = 0; i < TAKE_LIMIT; i++) value = addTake(value, 'shot-aaaaaa', job(i + 1));
    expect(() => addTake(value, 'shot-aaaaaa', job(99))).toThrow(/up to/);
    expect(() => shotBoardSchema.parse({ ...EMPTY_SHOT_BOARD, shots: [board().shots[0], board().shots[0]] })).toThrow();
    expect(() => shotBoardSchema.parse({ schema: 1, shots: [{ ...board().shots[0], jobIds: ['nope'] }] })).toThrow();
    expect(newShot().id).toMatch(/^shot-[a-z0-9]{8}$/);
  });
});
