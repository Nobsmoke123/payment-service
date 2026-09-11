import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Payment } from '../../src/models/payment.schema';
import { PaymentRepository } from '../../src/repositories/payment.repository';
import { IdempotencyRepository } from '../../src/repositories/idempotency.repository';
import { createTempDir } from '../helpers/app';

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

describe('PaymentRepository', () => {
  let filePath: string;
  let repository: PaymentRepository;

  beforeEach(async () => {
    const dir = await createTempDir();
    filePath = path.join(dir, 'payments.json');
    repository = new PaymentRepository(filePath);
  });

  it('creates and finds a payment', async () => {
    const payment = buildPayment();
    await repository.create(payment);
    await expect(repository.findById(payment.id)).resolves.toEqual(payment);
  });

  it('returns null for an unknown payment', async () => {
    await expect(repository.findById(randomUUID())).resolves.toBeNull();
  });

  it('updates a payment without changing id or createdAt', async () => {
    const payment = buildPayment();
    await repository.create(payment);
    const updatedAt = new Date().toISOString();
    const updated = await repository.update(payment.id, {
      status: 'processing',
      updatedAt,
    });

    expect(updated).toMatchObject({
      id: payment.id,
      createdAt: payment.createdAt,
      status: 'processing',
      updatedAt,
    });
  });

  it('persists concurrent creates without corrupting the file', async () => {
    const payments = Array.from({ length: 20 }, () => buildPayment());
    await Promise.all(payments.map((payment) => repository.create(payment)));

    const stored = await repository.findAll();
    expect(stored).toHaveLength(20);
    const raw = await fs.readFile(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toHaveLength(20);
  });

  it('applies concurrent mutations under the file lock', async () => {
    const payment = buildPayment();
    await repository.create(payment);

    await Promise.all([
      repository.update(payment.id, { status: 'processing' }),
      repository.mutate(payment.id, (current) => ({
        ...current,
        customerId: 'cus_mutated',
      })),
    ]);

    const stored = await repository.findById(payment.id);
    expect(stored).not.toBeNull();
    const raw = await fs.readFile(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it('coordinates two repository instances on the same file', async () => {
    const payment = buildPayment();
    await repository.create(payment);
    const other = new PaymentRepository(filePath);

    await Promise.all([
      repository.update(payment.id, { status: 'processing' }),
      other.update(payment.id, { customerId: 'cus_other' }),
    ]);

    const stored = await repository.findById(payment.id);
    expect(stored).not.toBeNull();
    const raw = await fs.readFile(filePath, 'utf8');
    expect(JSON.parse(raw)).toHaveLength(1);
    expect(JSON.parse(raw)[0].id).toBe(payment.id);
  });
});

describe('IdempotencyRepository', () => {
  it('stores and returns a mapping', async () => {
    const dir = await createTempDir();
    const repository = new IdempotencyRepository(path.join(dir, 'idempotency.json'));
    const paymentId = randomUUID();

    await repository.create('key-1', paymentId, 'hash-a');
    await expect(repository.find('key-1')).resolves.toEqual({
      paymentId,
      requestHash: 'hash-a',
    });
  });

  it('does not overwrite an existing key', async () => {
    const dir = await createTempDir();
    const repository = new IdempotencyRepository(path.join(dir, 'idempotency.json'));
    const originalId = randomUUID();

    await repository.create('key-1', originalId, 'hash-a');
    const result = await repository.create('key-1', randomUUID(), 'hash-b');

    expect(result).toEqual({ paymentId: originalId, requestHash: 'hash-a' });
  });
});
