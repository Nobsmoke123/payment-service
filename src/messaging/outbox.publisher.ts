import { Mutex } from '../utils/fileLock';
import { createLogger, type Logger } from '../utils/logger';
import type { EventBus } from './eventBus.interface';
import type { DomainEvent } from './events';
import { parseIncomingEvent } from './event.schemas';
import type { OutboxRepository } from '../repositories/outbox.repository';

export interface OutboxPublisherOptions {
  outbox: OutboxRepository;
  eventBus: EventBus;
  logger?: Logger;
  intervalMs?: number;
}

export class OutboxPublisher {
  private readonly lock = new Mutex();
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: OutboxPublisherOptions) {
    this.logger = options.logger ?? createLogger('outbox-publisher');
  }

  notify(): void {
    void this.publishPending();
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.publishPending();
    const intervalMs = this.options.intervalMs ?? 500;
    this.timer = setInterval(() => {
      void this.publishPending();
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.publishPending();
  }

  async publishPending(): Promise<void> {
    await this.lock.runExclusive(async () => {
      const pending = await this.options.outbox.findPending();
      for (const record of pending) {
        const parsed = parseIncomingEvent(record.payload);
        if (!parsed.success) {
          this.logger.error({
            service: 'outbox-publisher',
            outboxId: record.id,
            status: 'invalid',
            eventType: record.eventType,
          });
          continue;
        }

        try {
          await this.options.eventBus.publish(parsed.data as DomainEvent<unknown>);
          await this.options.outbox.markPublished(record.id);
          this.logger.info({
            service: 'outbox-publisher',
            outboxId: record.id,
            status: 'published',
            eventType: record.eventType,
            requestId: parsed.data.requestId,
            paymentId:
              parsed.data.payload && typeof parsed.data.payload === 'object' && 'paymentId' in parsed.data.payload
                ? parsed.data.payload.paymentId
                : undefined,
          });
        } catch (error) {
          this.logger.warn({
            service: 'outbox-publisher',
            outboxId: record.id,
            status: 'pending',
            eventType: record.eventType,
            err: error,
          });
        }
      }
    });
  }
}
