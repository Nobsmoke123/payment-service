import { randomUUID } from 'crypto';
import type { DomainEvent } from '../messaging/events';
import { assertPublishableEvent } from '../messaging/event.schemas';
import { JsonStore } from './json.store';

export type OutboxStatus = 'pending' | 'published';

export interface OutboxEvent {
  id: string;
  eventType: string;
  routingKey: string;
  payload: DomainEvent<unknown>;
  status: OutboxStatus;
  createdAt: string;
  publishedAt?: string;
}

export function toOutboxEvent(event: DomainEvent<unknown>): OutboxEvent {
  assertPublishableEvent(event);
  return {
    id: randomUUID(),
    eventType: event.eventType,
    routingKey: event.eventType,
    payload: event,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

export class OutboxRepository {
  readonly store: JsonStore<OutboxEvent[]>;

  constructor(filePath: string) {
    this.store = new JsonStore<OutboxEvent[]>(filePath, []);
  }

  async findPending(): Promise<OutboxEvent[]> {
    const records = await this.store.read();
    return records.filter((record) => record.status === 'pending');
  }

  async findAll(): Promise<OutboxEvent[]> {
    return this.store.read();
  }

  async append(event: OutboxEvent): Promise<OutboxEvent> {
    return this.store.runExclusive(async (records) => {
      const next = [...records, event];
      return { result: event, next };
    });
  }

  async markPublished(id: string): Promise<OutboxEvent | null> {
    return this.store.runExclusive(async (records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) {
        return { result: null };
      }
      const updated: OutboxEvent = {
        ...records[index],
        status: 'published',
        publishedAt: new Date().toISOString(),
      };
      const next = [...records];
      next[index] = updated;
      return { result: updated, next };
    });
  }

  hasCreatedEvent(records: OutboxEvent[], paymentId: string): boolean {
    return records.some(
      (record) =>
        record.eventType === 'payment.created' &&
        record.payload?.payload &&
        typeof record.payload.payload === 'object' &&
        'paymentId' in record.payload.payload &&
        record.payload.payload.paymentId === paymentId,
    );
  }
}
