import type { Payment } from '../models/payment.schema';
import { Mutex } from '../utils/fileLock';
import { JsonStore } from './json.store';

export class PaymentRepository {
  readonly store: JsonStore<Payment[]>;

  constructor(filePath: string, mutex?: Mutex) {
    this.store = new JsonStore<Payment[]>(filePath, [], mutex);
  }

  async create(payment: Payment): Promise<Payment> {
    return this.store.runExclusive(async (payments) => {
      const next = [...payments, payment];
      return { result: payment, next };
    });
  }

  async findById(id: string): Promise<Payment | null> {
    const payments = await this.store.read();
    return payments.find((payment) => payment.id === id) ?? null;
  }

  async findAll(): Promise<Payment[]> {
    return this.store.read();
  }

  async update(id: string, partial: Partial<Omit<Payment, 'id' | 'createdAt'>>): Promise<Payment | null> {
    return this.store.runExclusive(async (payments) => {
      const index = payments.findIndex((payment) => payment.id === id);
      if (index === -1) {
        return { result: null };
      }

      const current = payments[index];
      const updated: Payment = {
        ...current,
        ...partial,
        id: current.id,
        createdAt: current.createdAt,
      };
      const next = [...payments];
      next[index] = updated;
      return { result: updated, next };
    });
  }

  /**
   * Atomically apply a mutation. Returns null if the payment does not exist.
   * Used by the service to enforce FSM checks under the repository lock.
   */
  async mutate(id: string, mutator: (payment: Payment) => Payment): Promise<Payment | null> {
    return this.store.runExclusive(async (payments) => {
      const index = payments.findIndex((payment) => payment.id === id);
      if (index === -1) {
        return { result: null };
      }

      const current = payments[index];
      const updated = mutator(current);
      const next = [...payments];
      next[index] = {
        ...updated,
        id: current.id,
        createdAt: current.createdAt,
      };
      return { result: next[index], next };
    });
  }
}
