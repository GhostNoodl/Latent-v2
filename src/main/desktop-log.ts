import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Append-only diagnostic log with size-based rotation (desktop.log → desktop.1.log …).
 * Writes are serialized and never reject: a logging failure must not break the caller.
 */
export function createDesktopLog(directory: string, { maxBytes = 5 * 1024 * 1024, keep = 3, name = 'desktop' } = {}) {
  const file = path.join(directory, `${name}.log`);
  const rotated = (index: number) => path.join(directory, `${name}.${index}.log`);
  let queue: Promise<void> = Promise.resolve();
  const rotate = async () => {
    const size = await fs.stat(file).then(
      stat => stat.size,
      () => 0,
    );
    if (size < maxBytes) return;
    await fs.rm(rotated(keep), { force: true });
    for (let index = keep - 1; index >= 1; index--) await fs.rename(rotated(index), rotated(index + 1)).catch(() => {});
    await fs.rename(file, rotated(1));
  };
  const write = (message: string) => {
    const line = `${new Date().toISOString()} ${message.replace(/[\r\n]+/g, ' ').slice(0, 4000)}\n`;
    queue = queue
      .then(async () => {
        await fs.mkdir(directory, { recursive: true });
        await rotate();
        await fs.appendFile(file, line, 'utf8');
      })
      .catch(() => undefined);
    return queue;
  };
  return write;
}
