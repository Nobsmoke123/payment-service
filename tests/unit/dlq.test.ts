import { randomUUID } from 'crypto';
import { InMemoryEventBus } from '../../src/messaging/inMemoryEventBus';
import { EVENT_TYPES, createDomainEvent } from '../../src/messaging/events';
import { DEAD_LETTER_REASONS } from '../../src/messaging/message.validation';

function validCreated(paymentId = randomUUID()) {
  return {
    eventId: randomUUID(),
    eventType: EVENT_TYPES.CREATED,
    occurredAt: new Date().toISOString(),
    requestId: 'req-1',
    payload: {
      paymentId,
      amount: 10,
      currency: 'USD',
      customerId: 'cus_1',
    },
  };
}

describe('consumer event validation', () => {
  it('routes a malformed event to the DLQ and continues', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];

    await bus.subscribe(EVENT_TYPES.CREATED, async (event) => {
      received.push(String((event.payload as { paymentId: string }).paymentId));
    });

    await bus.deliverRaw({ not: 'an-event' }, EVENT_TYPES.CREATED);
    const paymentId = randomUUID();
    await bus.deliverRaw(validCreated(paymentId), EVENT_TYPES.CREATED);
    await bus.drain();

    expect(bus.deadLetters).toHaveLength(1);
    expect(bus.deadLetters[0]).toMatchObject({
      reason: DEAD_LETTER_REASONS.INVALID_SCHEMA,
      payload: { not: 'an-event' },
    });
    expect(received).toEqual([paymentId]);
  });

  it('ACKs a malformed event so the next message can be consumed', async () => {
    const bus = new InMemoryEventBus();
    const received: number[] = [];

    await bus.subscribe(EVENT_TYPES.CREATED, async () => {
      received.push(received.length + 1);
    });

    await expect(bus.deliverRaw({ broken: true }, EVENT_TYPES.CREATED)).resolves.toBeUndefined();
    await bus.deliverRaw(validCreated(), EVENT_TYPES.CREATED);
    await bus.drain();

    expect(bus.deadLetters).toHaveLength(1);
    expect(received).toEqual([1]);
  });

  it('dead-letters invalid JSON without invoking the handler', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];
    await bus.subscribe(EVENT_TYPES.CREATED, async (event) => {
      received.push(event.eventType);
    });

    await bus.deliverRaw('{not-json', EVENT_TYPES.CREATED);

    expect(bus.deadLetters[0]?.reason).toBe(DEAD_LETTER_REASONS.INVALID_JSON);
    expect(bus.deadLetters[0]?.payload).toBe('{not-json');
    expect(received).toEqual([]);
  });

  it('dead-letters an event whose type does not match the routing key', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];
    await bus.subscribe(EVENT_TYPES.CREATED, async (event) => {
      received.push(event.eventType);
    });

    const completed = createDomainEvent(EVENT_TYPES.COMPLETED, 'req-mismatch', {
      paymentId: randomUUID(),
      previousStatus: 'processing',
      currentStatus: 'completed',
    });
    await bus.deliverRaw(completed, EVENT_TYPES.CREATED);

    expect(bus.deadLetters[0]?.reason).toBe(DEAD_LETTER_REASONS.EVENT_TYPE_MISMATCH);
    expect(received).toEqual([]);
  });
});
