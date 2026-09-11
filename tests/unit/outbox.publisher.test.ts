import path from 'path';
import { FailingEventBus, InMemoryEventBus } from '../../src/messaging/inMemoryEventBus';
import { OutboxPublisher } from '../../src/messaging/outbox.publisher';
import { OutboxRepository, toOutboxEvent } from '../../src/repositories/outbox.repository';
import { paymentCreatedEvent } from '../../src/messaging/events';
import { logger } from '../../src/utils/logger';
import { createTempDir } from '../helpers/app';
import { randomUUID } from 'crypto';
import type { Payment } from '../../src/models/payment.schema';

function payment(overrides: Partial<Payment> = {}): Payment {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    amount: 25,
    currency: 'USD',
    customerId: 'cus_outbox',
    status: 'pending',
    requestId: 'req-outbox',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

describe('OutboxPublisher', () => {
  it('marks a pending record published after a successful publish', async () => {
    const dir = await createTempDir();
    const outbox = new OutboxRepository(path.join(dir, 'outbox.json'));
    const eventBus = new InMemoryEventBus();
    const publisher = new OutboxPublisher({ outbox, eventBus, logger });
    await outbox.append(toOutboxEvent(paymentCreatedEvent(payment())));

    await publisher.publishPending();

    await expect(outbox.findPending()).resolves.toHaveLength(0);
    expect(eventBus.published).toHaveLength(1);
    expect(eventBus.published[0].eventType).toBe('payment.created');
  });

  it('leaves the record pending when publish fails', async () => {
    const dir = await createTempDir();
    const outbox = new OutboxRepository(path.join(dir, 'outbox.json'));
    const publisher = new OutboxPublisher({
      outbox,
      eventBus: new FailingEventBus(),
      logger,
    });
    await outbox.append(toOutboxEvent(paymentCreatedEvent(payment())));

    await publisher.publishPending();

    const pending = await outbox.findPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('pending');
  });

  it('republishes pending records on startup', async () => {
    const dir = await createTempDir();
    const outbox = new OutboxRepository(path.join(dir, 'outbox.json'));
    const eventBus = new InMemoryEventBus();
    await outbox.append(toOutboxEvent(paymentCreatedEvent(payment())));

    const publisher = new OutboxPublisher({ outbox, eventBus, logger, intervalMs: 10_000 });
    await publisher.start();

    await expect(outbox.findPending()).resolves.toHaveLength(0);
    expect(eventBus.published).toHaveLength(1);
    await publisher.stop();
  });
});
