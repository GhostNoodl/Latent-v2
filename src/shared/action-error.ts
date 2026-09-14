/** Removes only Electron's known local IPC envelope; preserves the actionable cause. */
export function actionErrorMessage(error: unknown): string {
  let message: string;
  try { message = error instanceof Error ? error.message : String(error); } catch { return 'The action could not finish. Try again.'; }
  for (let depth = 0; depth < 3; depth++) {
    const match = /^Error invoking remote method ['"]latent:[A-Za-z][A-Za-z0-9]*['"]: (?:(?:Error|CivitaiError): )?([\s\S]+)$/.exec(message);
    if (!match) break;
    message = match[1];
  }
  return message.trim() ? message.length > 4000 ? message.slice(0, 4000) + '\n… Message shortened.' : message : 'The action could not finish. Try again.';
}
