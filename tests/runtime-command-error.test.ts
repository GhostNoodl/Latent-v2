import { describe, expect, it } from 'vitest';
import { runtimeCommandError, RuntimeCommandFailure } from '../src/main/runtime-command-error';

describe('runtime setup error presentation', () => {
  it('only identifies the specific uv PE resource open failure as retryable', () => {
    const output = 'Failed to update Windows PE resources: test.exe (os error -2147024786)';
    expect(new RuntimeCommandFailure('uv.exe', 1, output).retryableLauncherFailure).toBe(true);
    expect(new RuntimeCommandFailure('python.exe', 1, output).retryableLauncherFailure).toBe(false);
    expect(new RuntimeCommandFailure('uv.exe', 1, output.replace('-2147024786', '5')).retryableLauncherFailure).toBe(false);
    expect(new RuntimeCommandFailure('uv.exe', 1, '(os error -2147024786)').retryableLauncherFailure).toBe(false);
  });
  it('removes download progress but retains the actual constraint path failure', () => {
    const result = runtimeCommandError('uv.exe', 2, 'Downloading torch (1.8GiB)\rDownloaded torch\n\x1b[31merror: File not found: C:\\Users\\Example User\\Desktop\\Coding\x1b[0m\n');
    expect(result).toContain('File not found: C:\\Users\\Example User\\Desktop\\Coding');
    expect(result).not.toMatch(/Downloading|Downloaded|\x1b/);
    expect(result).toContain('Backend logs');
  });
  it('gives a retry action for the observed Windows PE launcher failure without assigning a cause', () => {
    const result = runtimeCommandError('uv.exe', 1, 'Downloaded pygments\nerror: Failed to install: pygments-2.21.0\n  Caused by: Failed to update Windows PE resources: uv-trampoline.exe\n  Caused by: The system cannot open the device or file specified.');
    expect(result).toContain('Python package launcher');
    expect(result).toContain('cached downloads');
    expect(result).not.toMatch(/antivirus|disable|Downloaded|trampoline/);
  });
  it('bounds long errors and still provides a useful message without output', () => {
    expect(runtimeCommandError('uv.exe', 1, 'error: ' + 'x'.repeat(5000)).length).toBeLessThan(750);
    expect(runtimeCommandError('python.exe', null, '')).toContain('python.exe exited with code unknown.');
  });
});

it('retries access denial only for uv temporary launcher removal', () => {
  const output = 'failed to remove file C:/temp/uv-trampoline-45612.exe: Access is denied. (os error 5)';
  expect(new RuntimeCommandFailure('uv.exe', 2, output).retryableLauncherFailure).toBe(true);
  expect(new RuntimeCommandFailure('uv.exe', 2, output.replace('uv-trampoline-45612.exe', 'user-model.safetensors')).retryableLauncherFailure).toBe(false);
  expect(new RuntimeCommandFailure('python.exe', 2, output).retryableLauncherFailure).toBe(false);
});
