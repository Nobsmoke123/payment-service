import amqp, { type GetMessage } from 'amqplib';
import { PAYMENTS_DLQ } from '../../src/messaging/exchanges';
import type { DeadLetterRecord } from '../../src/messaging/message.validation';

export async function publishRaw(
  url: string,
  exchange: string,
  routingKey: string,
  body: Buffer | string,
  properties: { messageId?: string; correlationId?: string } = {},
): Promise<void> {
  const connection = await amqp.connect(url);
  try {
    const channel = await connection.createConfirmChannel();
    const buffer = typeof body === 'string' ? Buffer.from(body) : body;
    await new Promise<void>((resolve, reject) => {
      channel.publish(
        exchange,
        routingKey,
        buffer,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: properties.messageId,
          correlationId: properties.correlationId,
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
  } finally {
    await connection.close();
  }
}

export async function waitForDeadLetter(
  url: string,
  match: (record: DeadLetterRecord) => boolean,
  timeoutMs = 8_000,
): Promise<DeadLetterRecord> {
  const connection = await amqp.connect(url);
  try {
    const channel = await connection.createChannel();
    await channel.assertQueue(PAYMENTS_DLQ, { durable: true });
    const held: GetMessage[] = [];
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const message = await channel.get(PAYMENTS_DLQ, { noAck: false });
      if (!message) {
        await sleep(50);
        continue;
      }

      let record: DeadLetterRecord;
      try {
        record = JSON.parse(message.content.toString()) as DeadLetterRecord;
      } catch {
        held.push(message);
        continue;
      }

      if (match(record)) {
        channel.ack(message);
        return record;
      }
      held.push(message);
    }
    throw new Error('Timed out waiting for dead letter');
  } finally {
    await connection.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
