import { expect, it } from 'vitest';
import { nodeAllocator } from '../src/shared/graph-builder';
import { historyOutcome } from '../src/main/comfy-history';
import type { ComfyWorkflow } from '../src/shared/types';

const node = (class_type: string) => ({ class_type, inputs: {} });

it('appends after the highest numeric id and respects the floor', () => {
  const graph: ComfyWorkflow = { '1': node('A'), '3': node('B') };
  expect(nodeAllocator(graph)('C', {})).toBe('4');
  expect(nodeAllocator({ '1': node('A') }, 7)('C', {})).toBe('8');
  expect(nodeAllocator({}, 0)('C', {})).toBe('1');
});

it('ignores non-numeric ids and never overwrites an existing node', () => {
  const graph: ComfyWorkflow = { '2': node('A'), output: node('Save') };
  const add = nodeAllocator(graph);
  const first = add('B', {});
  graph['4'] = node('Taken');
  expect(add('C', {})).toBe('5');
  expect(first).toBe('3');
  expect(graph.output.class_type).toBe('Save');
  expect(graph['4'].class_type).toBe('Taken');
});

it('reads ComfyUI history outcomes and names the failing node', () => {
  expect(historyOutcome({ status: { completed: false, messages: [] } }).finished).toBe(false);
  expect(historyOutcome({ status: { completed: true, status_str: 'success' } })).toMatchObject({
    finished: true,
    failed: false,
  });
  const failed = historyOutcome({
    status: {
      status_str: 'error',
      messages: [
        ['execution_error', { exception_message: 'CUDA out of memory', node_id: '12', node_type: 'KSampler' }],
      ],
    },
  });
  expect(failed).toMatchObject({ finished: true, failed: true, interrupted: false });
  expect(failed.error).toBe('CUDA out of memory (in KSampler node 12)');
  expect(historyOutcome({ status: { messages: [['execution_interrupted', {}]] } })).toMatchObject({
    finished: true,
    interrupted: true,
    error: undefined,
  });
});
