import fs from 'fs/promises';
import path from 'path';
import lockfile from 'proper-lockfile';

/**
 * In-process mutex that serializes async work onto a promise chain.
 * Combined with OS-level locks so API and worker containers can share JSON files.
 */
export class Mutex {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.queue;
    this.queue = previous.then(() => next).catch(() => next);
    await previous.catch(() => undefined);

    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tempPath, contents, 'utf8');
  await fs.rename(tempPath, filePath);
}

export async function readFileOrDefault(filePath: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function ensureFileExists(filePath: string, fallback: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, fallback, { flag: 'wx' });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') {
      throw error;
    }
  }
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  await ensureFileExists(filePath, '');
  const release = await lockfile.lock(filePath, {
    retries: {
      retries: 30,
      factor: 1.4,
      minTimeout: 15,
      maxTimeout: 500,
    },
    realpath: false,
    stale: 15_000,
  });

  try {
    return await fn();
  } finally {
    await release();
  }
}
