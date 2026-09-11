import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Payment } from '../../src/models/payment.schema';
import { paymentCreatedEvent } from '../../src/messaging/events';
import { PaymentCreationRepository } from '../../src/repositories/paymentCreation.repository';
import { IdempotencyRepository } from '../../src/repositories/idempotency.repository';
import { OutboxRepository, toOutboxEvent } from '../../src/repositories/outbox.repository';
import { PaymentRepository } from '../../src/repositories/payment.repository';
import { PaymentService } from '../../src/services/payment.service';
import { logger } from '../../src/utils/logger';
import { createTempDir } from '../helpers/app';
import { validPaymentPayload } from '../fixtures/payments';

function buildPayment(overrides: Partial<Payment> = {}): Payment {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    amount: 10,
    currency: 'USD',
    customerId: 'cus_1',
    status: 'pending',
    requestId: 'req_test',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function createStack(dir: string, hooks?: ConstructorParameters<typeof PaymentCreationRepository>[3]) {
  const payments = new PaymentRepository(path.join(dir, 'payments.json'));
  const idempotency = new IdempotencyRepository(path.join(dir, 'idempotency.json'));
  const outbox = new OutboxRepository(path.join(dir, 'outbox.json'));
  const creation = new PaymentCreationRepository(payments, idempotency, outbox, hooks);
  return { payments, idempotency, outbox, creation };
}

function createArgs(payment: Payment, key?: string, hash = 'hash-a') {
  return {
    payment,
    idempotencyKey: key,
    requestHash: hash,
    outboxEvent: toOutboxEvent(paymentCreatedEvent(payment)),
  };
}

describe('PaymentCreationRepository', () => {
  it('replays the original payment for the same idempotency key', async () => {
    const dir = await createTempDir();
    const { payments, creation } = createStack(dir);
    const payment = buildPayment();

    const first = await creation.commitCreate(createArgs(payment, 'key-1'));
    const second = await creation.commitCreate(createArgs(buildPayment(), 'key-1'));

    expect(first.kind).toBe('created');
    expect(second).toEqual({ kind: 'replayed', payment });
    await expect(payments.findAll()).resolves.toHaveLength(1);
  });

  it('returns conflict when the same key is reused with a different payload hash', async () => {
    const dir = await createTempDir();
    const { payments, creation } = createStack(dir);

    await creation.commitCreate(createArgs(buildPayment(), 'key-1', 'hash-a'));
    const result = await creation.commitCreate(createArgs(buildPayment(), 'key-1', 'hash-b'));

    expect(result.kind).toBe('conflict');
    await expect(payments.findAll()).resolves.toHaveLength(1);
  });

  it('writes a pending outbox record with the payment', async () => {
    const dir = await createTempDir();
    const { creation, outbox } = createStack(dir);
    const payment = buildPayment();

    await creation.commitCreate(createArgs(payment, 'key-1'));
    const pending = await outbox.findPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].eventType).toBe('payment.created');
    expect(pending[0].status).toBe('pending');
  });

  it('rolls back payment, idempotency, and outbox when persistence fails after the payment write', async () => {
    const dir = await createTempDir();
    const { payments, idempotency, outbox, creation } = createStack(dir, {
      afterPaymentWrite: () => {
        throw new Error('simulated persistence failure');
      },
    });

    await expect(creation.commitCreate(createArgs(buildPayment(), 'key-1'))).rejects.toThrow(
      'simulated persistence failure',
    );

    await expect(payments.findAll()).resolves.toEqual([]);
    await expect(idempotency.find('key-1')).resolves.toBeNull();
    await expect(outbox.findAll()).resolves.toEqual([]);

    const rawPayments = await fs.readFile(path.join(dir, 'payments.json'), 'utf8');
    const rawKeys = await fs.readFile(path.join(dir, 'idempotency.json'), 'utf8');
    expect(JSON.parse(rawPayments)).toEqual([]);
    expect(JSON.parse(rawKeys)).toEqual({});
  });

  it('does not create a duplicate payment when a failed create is retried', async () => {
    const dir = await createTempDir();
    let failOnce = true;
    const { payments, idempotency, outbox, creation } = createStack(dir, {
      afterPaymentWrite: () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated persistence failure');
        }
      },
    });
    const service = new PaymentService(payments, creation, outbox, { notify() {} }, logger);

    await expect(
      service.createPayment(validPaymentPayload, {
        requestId: 'req-fail',
        idempotencyKey: 'key-retry',
      }),
    ).rejects.toThrow('simulated persistence failure');

    const retry = await service.createPayment(validPaymentPayload, {
      requestId: 'req-retry',
      idempotencyKey: 'key-retry',
    });

    expect(retry.replayed).toBe(false);
    await expect(payments.findAll()).resolves.toHaveLength(1);
    await expect(idempotency.find('key-retry')).resolves.toMatchObject({
      paymentId: retry.payment.id,
    });
    await expect(outbox.findPending()).resolves.toHaveLength(1);
  });
});
