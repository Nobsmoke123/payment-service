import { InMemoryEventBus } from '../../src/messaging/inMemoryEventBus';
import { createDomainEvent, EVENT_TYPES } from '../../src/messaging/events';

describe('InMemoryEventBus', () => {
  it('delivers a published event to subscribers', async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];

    await bus.subscribe<{ paymentId: string }>(EVENT_TYPES.CREATED, async (event) => {
      received.push(event.payload.paymentId);
    });

    await bus.publish(
      createDomainEvent(EVENT_TYPES.CREATED, 'req-1', {
        paymentId: '550e8400-e29b-41d4-a716-446655440000',
        amount: 10,
        currency: 'USD',
        customerId: 'cus_1',
      }),
    );
    await bus.drain();

    expect(received).toEqual(['550e8400-e29b-41d4-a716-446655440000']);
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].eventType).toBe(EVENT_TYPES.CREATED);
    expect(bus.published[0].requestId).toBe('req-1');
  });
});
