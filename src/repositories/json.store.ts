import { Mutex, atomicWriteFile, readFileOrDefault, withFileLock } from '../utils/fileLock';

export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly fallback: T,
    private readonly mutex: Mutex = new Mutex(),
  ) {}

  async read(): Promise<T> {
    return this.withLock(() => this.readUnlocked());
  }

  async write(data: T): Promise<void> {
    await this.withLock(async () => {
      await this.writeUnlocked(data);
    });
  }

  async runExclusive<R>(fn: (current: T) => Promise<{ result: R; next?: T }>): Promise<R> {
    return this.withLock(async () => {
      const current = await this.readUnlocked();
      const { result, next } = await fn(current);
      if (next !== undefined) {
        await this.writeUnlocked(next);
      }
      return result;
    });
  }

  withLock<R>(fn: () => Promise<R>): Promise<R> {
    return this.mutex.runExclusive(() => withFileLock(this.filePath, fn));
  }

  async readUnlocked(): Promise<T> {
    const raw = await readFileOrDefault(this.filePath, JSON.stringify(this.fallback));
    if (raw.trim().length === 0) {
      return this.fallback;
    }
    return JSON.parse(raw) as T;
  }

  async writeUnlocked(data: T): Promise<void> {
    await atomicWriteFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}
