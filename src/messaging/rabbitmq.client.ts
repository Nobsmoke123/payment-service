import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { createLogger } from '../utils/logger';
import {
  PAYMENTS_DLQ,
  PAYMENTS_DLX,
  PAYMENTS_EXCHANGE,
  PAYMENTS_EXCHANGE_TYPE,
} from './exchanges';
import { createDeadLetterRecord, decodeAmqpContent, type DeadLetterRecord } from './message.validation';

const logger = createLogger('event-bus');

export type MessageHandler = (content: unknown, message: ConsumeMessage) => Promise<void>;

export interface DeadLetterMeta {
  reason: string;
  routingKey: string;
  messageId?: string;
}

interface Subscription {
  routingKey: string;
  queue: string;
  handler: MessageHandler;
}

export interface RabbitMQClientOptions {
  url: string;
  exchange?: string;
  maxConnectAttempts?: number;
}

export class RabbitMQClient {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private closing = false;
  private connecting: Promise<void> | null = null;
  private readonly subscriptions: Subscription[] = [];
  private readonly exchange: string;

  constructor(private readonly options: RabbitMQClientOptions) {
    this.exchange = options.exchange ?? PAYMENTS_EXCHANGE;
  }

  async connect(): Promise<void> {
    this.closing = false;
    await this.ensureConnected();
  }

  async publish(routingKey: string, payload: unknown, extras?: { messageId?: string; correlationId?: string }): Promise<void> {
    const channel = await this.ensureChannel();
    const buffer = Buffer.from(JSON.stringify(payload));

    await new Promise<void>((resolve, reject) => {
      channel.publish(
        this.exchange,
        routingKey,
        buffer,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: extras?.messageId,
          correlationId: extras?.correlationId,
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
  }

  async publishDeadLetter(payload: unknown, meta: DeadLetterMeta): Promise<DeadLetterRecord> {
    const record = createDeadLetterRecord(payload, meta);
    const channel = await this.ensureChannel();
    const buffer = Buffer.from(JSON.stringify(record));
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        PAYMENTS_DLX,
        PAYMENTS_DLQ,
        buffer,
        {
          persistent: true,
          contentType: 'application/json',
          headers: { reason: meta.reason },
          messageId: meta.messageId,
        },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
    return record;
  }

  async subscribe(routingKey: string, queue: string, handler: MessageHandler): Promise<void> {
    this.subscriptions.push({ routingKey, queue, handler });
    await this.bindAndConsume({ routingKey, queue, handler });
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.channel?.close();
    } catch {
      // Channel may already be closed.
    }
    try {
      await this.connection?.close();
    } catch {
      // Connection may already be closed.
    }
    this.channel = null;
    this.connection = null;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection && this.channel) {
      return;
    }
    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.connectWithRetry();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async ensureChannel(): Promise<ConfirmChannel> {
    await this.ensureConnected();
    if (!this.channel) {
      throw new Error('RabbitMQ channel is not available');
    }
    return this.channel;
  }

  private async connectWithRetry(attempt = 1): Promise<void> {
    try {
      const connection = await amqp.connect(this.options.url);
      const channel = await connection.createConfirmChannel();
      await channel.assertExchange(this.exchange, PAYMENTS_EXCHANGE_TYPE, { durable: true });
      await channel.assertExchange(PAYMENTS_DLX, 'direct', { durable: true });
      await channel.assertQueue(PAYMENTS_DLQ, { durable: true });
      await channel.bindQueue(PAYMENTS_DLQ, PAYMENTS_DLX, PAYMENTS_DLQ);
      await channel.prefetch(1);

      connection.on('error', (error) => {
        logger.error({ err: error }, 'RabbitMQ connection error');
      });
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
        if (!this.closing) {
          logger.warn('RabbitMQ connection closed; reconnecting');
          void this.reconnect();
        }
      });

      this.connection = connection;
      this.channel = channel;
      logger.info({ exchange: this.exchange }, 'Connected to RabbitMQ');

      for (const subscription of this.subscriptions) {
        await this.bindAndConsume(subscription);
      }
    } catch (error) {
      const maxAttempts = this.options.maxConnectAttempts ?? Number.POSITIVE_INFINITY;
      if (attempt >= maxAttempts) {
        throw error;
      }
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      logger.warn({ attempt, delayMs, err: error }, 'RabbitMQ connect failed; retrying');
      await sleep(delayMs);
      await this.connectWithRetry(attempt + 1);
    }
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connectWithRetry();
    } catch (error) {
      logger.error({ err: error }, 'RabbitMQ reconnect failed');
    }
  }

  private async bindAndConsume(subscription: Subscription): Promise<void> {
    const channel = await this.ensureChannel();
    await channel.assertQueue(subscription.queue, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': PAYMENTS_DLX,
        'x-dead-letter-routing-key': PAYMENTS_DLQ,
      },
    });
    await channel.bindQueue(subscription.queue, this.exchange, subscription.routingKey);

    await channel.consume(subscription.queue, (message) => {
      if (!message) {
        return;
      }

      void (async () => {
        try {
          const decoded = decodeAmqpContent(message.content);
          if (!decoded.ok) {
            this.logDeadLettered({
              reason: decoded.reason,
              routingKey: subscription.routingKey,
              messageId: message.properties.messageId,
              requestId: null,
            });
            await this.publishDeadLetter(decoded.payload, {
              reason: decoded.reason,
              routingKey: subscription.routingKey,
              messageId: message.properties.messageId,
            });
            channel.ack(message);
            return;
          }

          await subscription.handler(decoded.value, message);
          channel.ack(message);
        } catch (error) {
          logger.error({
            err: error,
            routingKey: subscription.routingKey,
            queue: subscription.queue,
          }, 'Failed to handle RabbitMQ message; requeueing');
          channel.nack(message, false, true);
        }
      })();
    });
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
