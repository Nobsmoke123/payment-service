import type { DomainEvent } from './events';
import type { EventBus, EventHandler } from './eventBus.interface';
import { parseIncomingEvent } from './event.schemas';
import { DEAD_LETTER_REASONS, decodeAmqpContent } from './message.validation';

export interface DeadLetter {
  reason: string;
  payload: unknown;
  routingKey?: string;
  messageId?: string;
  timestamp?: string;
}

export class InMemoryEventBus implements EventBus {
  readonly published: DomainEvent<unknown>[] = [];
  readonly deadLetters: DeadLetter[] = [];
  private readonly handlers = new Map<string, EventHandler[]>();
  private readonly inFlight = new Set<Promise<void>>();

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    this.published.push(event);
    await this.dispatch(event.eventType, event);
  }

  async deliverRaw(raw: unknown, routingKey?: string): Promise<void> {
    let decoded: unknown = raw;
    if (typeof raw === 'string' || Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
      const buffer = Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(raw);
      const result = decodeAmqpContent(buffer);
      if (!result.ok) {
        this.recordDeadLetter(result.reason, result.payload, routingKey);
        return;
      }
      decoded = result.value;
    }

    const parsed = parseIncomingEvent(decoded);
    if (!parsed.success) {
      this.recordDeadLetter(DEAD_LETTER_REASONS.INVALID_SCHEMA, decoded, routingKey);
      return;
    }

    const subscribedKey = routingKey ?? parsed.data.eventType;
    if (parsed.data.eventType !== subscribedKey) {
      this.recordDeadLetter(DEAD_LETTER_REASONS.EVENT_TYPE_MISMATCH, decoded, subscribedKey);
      return;
    }

    await this.dispatch(subscribedKey, parsed.data);
  }

  async subscribe<T>(eventType: string, handler: EventHandler<T>): Promise<void> {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler as EventHandler);
    this.handlers.set(eventType, existing);
  }

  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async close(): Promise<void> {
    await this.drain();
    this.handlers.clear();
  }

  private recordDeadLetter(reason: string, payload: unknown, routingKey?: string): void {
    this.deadLetters.push({
      reason,
      payload,
      routingKey,
      timestamp: new Date().toISOString(),
    });
  }

  private async dispatch(eventType: string, event: DomainEvent<unknown>): Promise<void> {
    const listeners = this.handlers.get(eventType) ?? [];
    const work = Promise.all(
      listeners.map(async (handler) => {
        await handler(event);
      }),
    ).then(() => undefined);

    this.inFlight.add(work);
    void work.finally(() => {
      this.inFlight.delete(work);
    });
  }
}

export class NoopEventBus implements EventBus {
  async publish(): Promise<void> {
    // Tests that only exercise HTTP/service behavior skip background work.
  }

  async subscribe(): Promise<void> {
    // No-op
  }

  async drain(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    // No-op
  }
}

export class FailingEventBus implements EventBus {
  async publish(): Promise<void> {
    throw new Error('broker unavailable');
  }

  async subscribe(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    // No-op
  }
}
