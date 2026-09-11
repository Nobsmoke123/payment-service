import { createLogger } from '../utils/logger';
import type { EventBus, EventHandler } from './eventBus.interface';
import type { DomainEvent } from './events';
import { assertPublishableEvent, parseIncomingEvent } from './event.schemas';
import { DEAD_LETTER_REASONS } from './message.validation';
import { QUEUES } from './exchanges';
import { RabbitMQClient } from './rabbitmq.client';

const logger = createLogger('event-bus');

export interface RabbitMQEventBusOptions {
  url: string;
  exchange: string;
  paymentCreatedQueue: string;
  maxConnectAttempts?: number;
}

export class RabbitMQEventBus implements EventBus {
  private readonly client: RabbitMQClient;

  constructor(private readonly options: RabbitMQEventBusOptions) {
    this.client = new RabbitMQClient({
      url: options.url,
      exchange: options.exchange,
      maxConnectAttempts: options.maxConnectAttempts,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    assertPublishableEvent(event);
    const paymentId =
      event.payload && typeof event.payload === 'object' && 'paymentId' in event.payload
        ? String((event.payload as { paymentId: string }).paymentId)
        : undefined;

    logger.info({
      service: 'event-bus',
      eventType: event.eventType,
      eventId: event.eventId,
      requestId: event.requestId,
      paymentId,
    });

    await this.client.publish(event.eventType, event, {
      messageId: event.eventId,
      correlationId: event.requestId,
    });
  }

  async subscribe<T>(eventType: string, handler: EventHandler<T>): Promise<void> {
    await this.client.subscribe(eventType, this.queueFor(eventType), async (content, message) => {
      const messageId = message.properties.messageId;
      const parsed = parseIncomingEvent(content);
      if (!parsed.success) {
        this.logDeadLettered({
          reason: DEAD_LETTER_REASONS.INVALID_SCHEMA,
          routingKey: eventType,
          messageId,
          requestId: null,
        });
        await this.client.publishDeadLetter(content, {
          reason: DEAD_LETTER_REASONS.INVALID_SCHEMA,
          routingKey: eventType,
          messageId,
        });
        return;
      }

      if (parsed.data.eventType !== eventType) {
        this.logDeadLettered({
          reason: DEAD_LETTER_REASONS.EVENT_TYPE_MISMATCH,
          routingKey: eventType,
          messageId,
          requestId: parsed.data.requestId,
        });
        await this.client.publishDeadLetter(content, {
          reason: DEAD_LETTER_REASONS.EVENT_TYPE_MISMATCH,
          routingKey: eventType,
          messageId,
        });
        return;
      }

      await handler(parsed.data as DomainEvent<T>);
    });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private logDeadLettered(fields: {
    reason: string;
    routingKey: string;
    messageId?: string;
    requestId: string | null;
  }): void {
    logger.warn({
      service: 'payment-worker',
      event: 'message.dead_lettered',
      reason: fields.reason,
      routingKey: fields.routingKey,
      messageId: fields.messageId,
      requestId: fields.requestId,
    });
  }

  private queueFor(eventType: string): string {
    if (eventType === 'payment.created') {
      return this.options.paymentCreatedQueue;
    }
    if (eventType === 'payment.processing') {
      return QUEUES.PAYMENT_PROCESSING;
    }
    if (eventType === 'payment.completed') {
      return QUEUES.PAYMENT_COMPLETED;
    }
    if (eventType === 'payment.failed') {
      return QUEUES.PAYMENT_FAILED;
    }
    return eventType;
  }
}
