import type { InputHTMLAttributes, KeyboardEvent } from 'react';

/** Rounds away float noise from repeated nudges (2.75 + 0.25 stays 3, not 3.0000000004). */
const tidy = (value: number) => Math.round(value * 100) / 100;

/**
 * Props for a CFG number box that takes any decimal, like 2.75 or 3.33.
 * step="any" keeps the browser from calling 2.75 invalid (and blocking Generate);
 * arrow keys still nudge by 0.25, or by 1 with Shift.
 */
export function cfgInputProps(
  value: number,
  onChange: (value: number) => void,
  { min = 0, max = 30 }: { min?: number; max?: number } = {},
): InputHTMLAttributes<HTMLInputElement> {
  return {
    type: 'number',
    min,
    max,
    step: 'any',
    inputMode: 'decimal',
    value,
    onChange: event => onChange(Number(event.target.value)),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const by = (event.shiftKey ? 1 : 0.25) * (event.key === 'ArrowUp' ? 1 : -1);
      onChange(Math.min(max, Math.max(min, tidy((Number.isFinite(value) ? value : 0) + by))));
    },
  };
}
