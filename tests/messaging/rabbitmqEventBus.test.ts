import { randomUUID } from 'crypto';
import { EVENT_TYPES, createDomainEvent } from '../../src/messaging/events';
import { DEAD_LETTER_REASONS } from '../../src/messaging/message.validation';
import { RabbitMQEventBus } from '../../src/messaging/rabbitmqEventBus';
import { describeIfBroker } from '../helpers/broker';
import { publishRaw, waitForDeadLetter } from '../helpers/amqp';

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';

async function connectBus() {
  const exchange = `payments.events.test.${process.pid}.${randomUUID()}`;
  const bus = new RabbitMQEventBus({
    url: RABBITMQ_URL,
    exchange,
    paymentCreatedQueue: `payment.created.test.${process.pid}.${randomUUID()}`,
    maxConnectAttempts: 1,
  });
  await bus.connect();
  return { bus, exchange };
}

function createdEvent(paymentId = randomUUID()) {
  return createDomainEvent(EVENT_TYPES.CREATED, 'req-rabbit', {
    paymentId,
    amount: 10,
    currency: 'USD',
    customerId: 'cus_1',
  });
}

describeIfBroker('RabbitMQEventBus', () => {
  it('connects, declares the exchange, publishes, and delivers a subscribed event', async () => {
    const { bus } = await connectBus();
    const paymentId = randomUUID();
    let resolveReceived!: (value: string) => void;
    const received = new Promise<string>((resolve) => {
      resolveReceived = resolve;
    });

    await bus.subscribe<{ paymentId: string }>(EVENT_TYPES.CREATED, async (event) => {
      resolveReceived(event.payload.paymentId);
    });

    await bus.publish(createdEvent(paymentId));

    await expect(received).resolves.toBe(paymentId);
    await bus.close();
  }, 15_000);

  it('dead-letters invalid JSON, ACKs the original, and continues consuming', async () => {
    const { bus, exchange } = await connectBus();
    const paymentId = randomUUID();
    const poisonId = `poison-json-${randomUUID()}`;
    const received: string[] = [];
    let resolveReceived!: () => void;
    const receivedValid = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });

    await bus.subscribe<{ paymentId: string }>(EVENT_TYPES.CREATED, async (event) => {
      received.push(event.payload.paymentId);
      resolveReceived();
    });

    await publishRaw(RABBITMQ_URL, exchange, EVENT_TYPES.CREATED, `{${poisonId}`, {
      messageId: poisonId,
    });

    const dead = await waitForDeadLetter(
      RABBITMQ_URL,
      (record) => record.reason === DEAD_LETTER_REASONS.INVALID_JSON && record.messageId === poisonId,
    );
    expect(dead.payload).toBe(`{${poisonId}`);
    expect(dead.routingKey).toBe(EVENT_TYPES.CREATED);
    expect(dead.timestamp).toBeDefined();

    await bus.publish(createdEvent(paymentId));
    await receivedValid;

    expect(received).toEqual([paymentId]);
    await bus.close();
  }, 15_000);

  it('dead-letters an invalid schema and does not invoke the handler', async () => {
    const { bus, exchange } = await connectBus();
    const received: string[] = [];
    const schemaId = `schema-${randomUUID()}`;

    await bus.subscribe(EVENT_TYPES.CREATED, async (event) => {
      received.push(event.eventType);
    });

    await publishRaw(
      RABBITMQ_URL,
      exchange,
      EVENT_TYPES.CREATED,
      JSON.stringify({ not: 'an-event', probe: schemaId }),
      { messageId: schemaId },
    );

    const dead = await waitForDeadLetter(
      RABBITMQ_URL,
      (record) => record.reason === DEAD_LETTER_REASONS.INVALID_SCHEMA && record.messageId === schemaId,
    );
    expect(dead.payload).toMatchObject({ probe: schemaId });
    expect(received).toEqual([]);
    await bus.close();
  }, 15_000);

  it('dead-letters an event type that does not match the routing key', async () => {
    const { bus, exchange } = await connectBus();
    const received: string[] = [];
    const mismatchId = randomUUID();
    const completed = createDomainEvent(EVENT_TYPES.COMPLETED, 'req-mismatch', {
      paymentId: mismatchId,
      previousStatus: 'processing',
      currentStatus: 'completed',
    });

    await bus.subscribe(EVENT_TYPES.CREATED, async (event) => {
      received.push(event.eventType);
    });

    await publishRaw(RABBITMQ_URL, exchange, EVENT_TYPES.CREATED, JSON.stringify(completed), {
      messageId: completed.eventId,
    });

    const dead = await waitForDeadLetter(
      RABBITMQ_URL,
      (record) =>
        record.reason === DEAD_LETTER_REASONS.EVENT_TYPE_MISMATCH && record.messageId === completed.eventId,
    );
    expect(dead.routingKey).toBe(EVENT_TYPES.CREATED);
    expect(received).toEqual([]);
    await bus.close();
  }, 15_000);

  it('delivers payment.created only to the created consumer', async () => {
    const { bus } = await connectBus();
    const createdIds: string[] = [];
    const completedIds: string[] = [];
    const paymentId = randomUUID();
    let resolveCreated!: () => void;
    const created = new Promise<void>((resolve) => {
      resolveCreated = resolve;
    });

    await bus.subscribe<{ paymentId: string }>(EVENT_TYPES.CREATED, async (event) => {
      createdIds.push(event.payload.paymentId);
      resolveCreated();
    });
    await bus.subscribe(EVENT_TYPES.COMPLETED, async (event) => {
      completedIds.push(String((event.payload as { paymentId: string }).paymentId));
    });

    await bus.publish(createdEvent(paymentId));
    await created;
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    expect(createdIds).toEqual([paymentId]);
    expect(completedIds).not.toContain(paymentId);
    await bus.close();
  }, 15_000);
});
