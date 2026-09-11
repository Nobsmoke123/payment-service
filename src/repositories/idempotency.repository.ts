import { Mutex } from '../utils/fileLock';
import { JsonStore } from './json.store';

export interface IdempotencyRecord {
  paymentId: string;
  requestHash: string;
}

export class IdempotencyRepository {
  readonly store: JsonStore<Record<string, IdempotencyRecord>>;

  constructor(filePath: string, mutex?: Mutex) {
    this.store = new JsonStore<Record<string, IdempotencyRecord>>(filePath, {}, mutex);
  }

  async find(key: string): Promise<IdempotencyRecord | null> {
    const records = await this.store.read();
    return records[key] ?? null;
  }

  async create(key: string, paymentId: string, requestHash: string): Promise<IdempotencyRecord> {
    return this.store.runExclusive(async (records) => {
      const existing = records[key];
      if (existing) {
        return { result: existing };
      }

      const record: IdempotencyRecord = { paymentId, requestHash };
      return {
        result: record,
        next: {
          ...records,
          [key]: record,
        },
      };
    });
  }
}
