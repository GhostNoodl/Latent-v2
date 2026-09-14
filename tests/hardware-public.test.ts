import { describe, it, expect } from 'vitest';
import { environmentReasons } from '../src/main/hardware-profiles';
import { PROFILE_MACHINE, PROFILE_RUNTIME, LOCAL_HARDWARE_PROFILES } from '../src/main/hardware-profile-evidence';
import type { HardwareInventory } from '../src/shared/hardware-profile-types';
const profile = LOCAL_HARDWARE_PROFILES[0];
const inventory = (uuid: string): HardwareInventory => ({ ...PROFILE_MACHINE, observedAt: new Date().toISOString(), detection: 'nvidia', activeDevice: { type: 'cuda', name: 'fixture' }, gpus: [], messages: [], fingerprint: 'fixture', selectedGpu: { index: 0, uuid, name: PROFILE_MACHINE.gpuName, vramMiB: PROFILE_MACHINE.vramMiB, driver: PROFILE_MACHINE.driver }, runtimeIdentity: { sha256: profile.evidence?.runtimeIdentitySha256 ?? PROFILE_RUNTIME } as HardwareInventory['runtimeIdentity'] });
describe('anonymous benchmark configuration', () => {
  it('contains no unique device identifier and compares configurations independently of UUID', () => {
    expect(PROFILE_MACHINE).not.toHaveProperty('gpuUuid');
    expect(environmentReasons(inventory('synthetic-device-one'), profile)).toEqual([]);
    expect(environmentReasons(inventory('synthetic-device-two'), profile)).toEqual([]);
  });
  it('still rejects unmatched memory and runtime configurations', () => {
    const value = inventory('synthetic-device'); value.ramBytes = 8 * 1024 ** 3;
    expect(environmentReasons(value, profile).join(' ')).toContain('recorded configuration');
    value.runtimeIdentity = undefined;
    expect(environmentReasons(value, profile).join(' ')).toContain('runtime/dependency');
  });
});
