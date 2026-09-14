/** Full process output is already retained in backend.log. Keep the UI actionable. */
export class RuntimeCommandFailure extends Error {
  readonly retryableLauncherFailure: boolean;
  constructor(executableName: string, code: number | null, output: string) {
    super(runtimeCommandError(executableName, code, output));
    this.name = 'RuntimeCommandFailure';
    this.retryableLauncherFailure = /^uv(?:\.exe)?$/i.test(executableName)
      && ((/Failed to update Windows PE resources/i.test(output) && /os error -2147024786/.test(output))
        || (/Failed to update Windows PE resources:[^\r\n]*uv-trampoline-\d+\.exe/i.test(output)
          && /Access is denied\. \(os error (?:-2147024891|5)\)/i.test(output))
        || /failed to remove file[^\r\n]*uv-trampoline-\d+\.exe[^\r\n]*Access is denied\. \(os error 5\)/i.test(output));
  }
}

export function runtimeCommandError(executableName: string, code: number | null, output: string): string {
  const text = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n').trim();
  const errors = [...text.matchAll(/^\s*error:/gim)];
  const detail = (errors.length ? text.slice(errors.at(-1)!.index) : text.split('\n').filter(line => line.trim()).slice(-3).join('\n')).trim();
  if (/Failed to update Windows PE resources/i.test(detail)) {
    return 'Windows could not finish creating a Python package launcher. Use Repair / finish setup to retry with cached downloads. Full details are in Backend logs.';
  }
  const bounded = detail.length > 600 ? `${detail.slice(0, 597)}…` : detail;
  return `${executableName} exited with code ${code ?? 'unknown'}.${bounded ? ` ${bounded}` : ''} Use Repair / finish setup to retry. Full details are in Backend logs.`;
}
