import { describe, expect, it } from 'vitest';
import { parseSettingsPatch } from '../src/shared/validation';

describe('settings patches', () => {
  it('keeps only the settings a patch names, so defaults never overwrite saved choices', () => {
    expect(parseSettingsPatch({ theme: 'dark' })).toEqual({ theme: 'dark' });
    expect(parseSettingsPatch({ fastMath: true })).toEqual({ fastMath: true });
  });

  it('still rejects invalid values', () => {
    expect(() => parseSettingsPatch({ fastMath: 'yes' })).toThrow();
    expect(() => parseSettingsPatch({ unknownSetting: true })).toThrow();
  });
});
