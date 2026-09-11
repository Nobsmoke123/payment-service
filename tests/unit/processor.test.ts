import path from 'path';
import { InMemoryEventBus } from '../../src/messaging/inMemoryEventBus';
import { EVENT_TYPES, paymentCreatedEvent } from '../../src/messaging/events';
import { OutboxPublisher } from '../../src/messaging/outbox.publisher';
import { PaymentService } from '../../src/services/payment.service';
import { PaymentRepository } from '../../src/repositories/payment.repository';
import { IdempotencyRepository } from '../../src/repositories/idempotency.repository';
import { OutboxRepository } from '../../src/repositories/outbox.repository';
import { PaymentCreationRepository } from '../../src/repositories/paymentCreation.repository';
import { logger } from '../../src/utils/logger';
import { PaymentWorker } from '../../src/workers/payment.worker';
import { createTempDir } from '../helpers/app';
import { validPaymentPayload } from '../fixtures/payments';

async function createModule(
  dir: string,
  decideOutcome?: () => 'completed' | 'failed',
): Promise<{
  service: PaymentService;
  worker: PaymentWorker;
  eventBus: InMemoryEventBus;
  publisher: OutboxPublisher;
}> {
  const payments = new PaymentRepository(path.join(dir, 'payments.json'));
  const idempotency = new IdempotencyRepository(path.join(dir, 'idempotency.json'));
  const outbox = new OutboxRepository(path.join(dir, 'outbox.json'));
  const creation = new PaymentCreationRepository(payments, idempotency, outbox);
  const eventBus = new InMemoryEventBus();
  const publisher = new OutboxPublisher({ outbox, eventBus, logger, intervalMs: 20 });
  const service = new PaymentService(payments, creation, outbox, publisher, logger);
  const worker = new PaymentWorker({
    eventBus,
    getService: () => service,
    delayMs: 0,
    logger,
    decideOutcome,
  });
  await worker.start();
  await publisher.start();
  return { service, worker, eventBus, publisher };
}

async function flush(publisher: OutboxPublisher, eventBus: InMemoryEventBus, worker?: PaymentWorker) {
  for (let i = 0; i < 8; i += 1) {
    await publisher.publishPending();
    await eventBus.drain();
    if (worker) {
      await worker.drain();
    }
  }
}

describe('PaymentWorker', () => {
  it('skips payments that are no longer pending', async () => {
    const dir = await createTempDir();
    const payments = new PaymentRepository(path.join(dir, 'payments.json'));
    const idempotency = new IdempotencyRepository(path.join(dir, 'idempotency.json'));
    const outbox = new OutboxRepository(path.join(dir, 'outbox.json'));
    const creation = new PaymentCreationRepository(payments, idempotency, outbox);
    const eventBus = new InMemoryEventBus();
    const service = new PaymentService(payments, creation, outbox, { notify() {} }, logger);
    const worker = new PaymentWorker({
      eventBus,
      getService: () => service,
      delayMs: 0,
      logger,
      decideOutcome: () => 'completed',
    });

    const created = await service.createPayment(validPaymentPayload, { requestId: 'req-1' });
    await service.updateStatus(created.payment.id, 'processing', 'req-1');
    await service.updateStatus(created.payment.id, 'completed', 'req-1');

    await worker.handleCreated(paymentCreatedEvent(created.payment));
    await worker.drain();

    const latest = await service.getPayment(created.payment.id);
    expect(latest.status).toBe('completed');
  });

  it('is safe to process the same payment twice', async () => {
    const dir = await createTempDir();
    const { service, worker, eventBus, publisher } = await createModule(dir, () => 'failed');

    const created = await service.createPayment(validPaymentPayload, { requestId: 'req-2' });
    await flush(publisher, eventBus, worker);

    await worker.handleCreated(paymentCreatedEvent(created.payment));
    await flush(publisher, eventBus, worker);

    const latest = await service.getPayment(created.payment.id);
    expect(latest.status).toBe('failed');
    await publisher.stop();
  });

  it('reuses the originating request ID in background status logs', async () => {
    const dir = await createTempDir();
    const info = jest.spyOn(logger, 'info');
    const { service, eventBus, publisher, worker } = await createModule(dir, () => 'completed');

    const created = await service.createPayment(validPaymentPayload, { requestId: 'origin-req-9' });
    await flush(publisher, eventBus, worker);

    const statusLogs = info.mock.calls
      .map((args) => args[0] as Record<string, unknown>)
      .filter((entry) => entry.event === 'payment.status.changed');

    expect(statusLogs.length).toBeGreaterThanOrEqual(2);
    for (const entry of statusLogs) {
      expect(entry.requestId).toBe('origin-req-9');
      expect(entry.paymentId).toBe(created.payment.id);
    }

    const lifecycleLogs = info.mock.calls
      .map((args) => args[0] as Record<string, unknown>)
      .filter((entry) => entry.eventType === EVENT_TYPES.COMPLETED);
    expect(lifecycleLogs.some((entry) => entry.requestId === 'origin-req-9')).toBe(true);

    info.mockRestore();
    await publisher.stop();
  });
});
