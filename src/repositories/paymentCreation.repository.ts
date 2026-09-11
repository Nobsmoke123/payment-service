import type { Payment } from '../models/payment.schema';
import type { DomainEvent } from '../messaging/events';
import type { IdempotencyRecord, IdempotencyRepository } from './idempotency.repository';
import { toOutboxEvent, type OutboxEvent, type OutboxRepository } from './outbox.repository';
import type { PaymentRepository } from './payment.repository';

export interface PaymentCreationHooks {
  afterPaymentWrite?: () => Promise<void> | void;
}

export type CreateCommitResult =
  | { kind: 'created'; payment: Payment }
  | { kind: 'replayed'; payment: Payment }
  | { kind: 'conflict' };

/**
 * Coordinates payment, idempotency, and outbox JSON files as one transaction.
 * Lock order is always payments → idempotency → outbox to avoid deadlocks.
 */
export class PaymentCreationRepository {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly idempotency: IdempotencyRepository,
    private readonly outbox: OutboxRepository,
    private readonly hooks: PaymentCreationHooks = {},
  ) {}

  async commitCreate(params: {
    payment: Payment;
    idempotencyKey?: string;
    requestHash: string;
    outboxEvent: OutboxEvent;
  }): Promise<CreateCommitResult> {
    const paymentStore = this.payments.store;
    const idempotencyStore = this.idempotency.store;
    const outboxStore = this.outbox.store;

    return paymentStore.withLock(() =>
      idempotencyStore.withLock(() =>
        outboxStore.withLock(async () => {
          const payments = await paymentStore.readUnlocked();
          const records = await idempotencyStore.readUnlocked();
          const outbox = await outboxStore.readUnlocked();

          if (params.idempotencyKey) {
            const existing = records[params.idempotencyKey];
            if (existing) {
              if (existing.requestHash !== params.requestHash) {
                return { kind: 'conflict' };
              }
              const original = payments.find((payment) => payment.id === existing.paymentId);
              if (!original) {
                throw new Error(
                  `Idempotency key ${params.idempotencyKey} points to missing payment ${existing.paymentId}`,
                );
              }
              return { kind: 'replayed', payment: original };
            }
          }

          const nextPayments = [...payments, params.payment];
          const nextRecords: Record<string, IdempotencyRecord> = params.idempotencyKey
            ? {
                ...records,
                [params.idempotencyKey]: {
                  paymentId: params.payment.id,
                  requestHash: params.requestHash,
                },
              }
            : records;
          const nextOutbox = [...outbox, params.outboxEvent];

          try {
            await paymentStore.writeUnlocked(nextPayments);
            await this.hooks.afterPaymentWrite?.();
            if (params.idempotencyKey) {
              await idempotencyStore.writeUnlocked(nextRecords);
            }
            await outboxStore.writeUnlocked(nextOutbox);
          } catch (error) {
            await paymentStore.writeUnlocked(payments);
            await idempotencyStore.writeUnlocked(records);
            await outboxStore.writeUnlocked(outbox);
            throw error;
          }

          return { kind: 'created', payment: params.payment };
        }),
      ),
    );
  }

  async commitTransition(params: {
    paymentId: string;
    mutate: (payment: Payment) => Payment | null;
    buildEvent: (payment: Payment, previousStatus: Payment['status']) => DomainEvent<unknown>;
  }): Promise<{ payment: Payment; previousStatus: Payment['status'] } | null> {
    const paymentStore = this.payments.store;
    const outboxStore = this.outbox.store;

    return paymentStore.withLock(() =>
      outboxStore.withLock(async () => {
        const payments = await paymentStore.readUnlocked();
        const outbox = await outboxStore.readUnlocked();
        const index = payments.findIndex((payment) => payment.id === params.paymentId);
        if (index === -1) {
          return null;
        }

        const current = payments[index];
        const mutated = params.mutate(current);
        if (!mutated) {
          return null;
        }

        const previousStatus = current.status;
        const updated: Payment = {
          ...mutated,
          id: current.id,
          createdAt: current.createdAt,
        };
        const nextPayments = [...payments];
        nextPayments[index] = updated;
        const event = toOutboxEvent(params.buildEvent(updated, previousStatus));
        const nextOutbox = [...outbox, event];

        try {
          await paymentStore.writeUnlocked(nextPayments);
          await outboxStore.writeUnlocked(nextOutbox);
        } catch (error) {
          await paymentStore.writeUnlocked(payments);
          await outboxStore.writeUnlocked(outbox);
          throw error;
        }

        return { payment: updated, previousStatus };
      }),
    );
  }
}
