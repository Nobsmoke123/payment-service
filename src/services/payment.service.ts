import { createHash, randomUUID } from 'crypto';
import { paymentCreatedEvent, paymentStatusEvent, EVENT_TYPES } from '../messaging/events';
import type { CreatePaymentInput, Payment, PaymentStatus } from '../models/payment.schema';
import type { PaymentCreationRepository } from '../repositories/paymentCreation.repository';
import { toOutboxEvent, type OutboxRepository } from '../repositories/outbox.repository';
import type { PaymentRepository } from '../repositories/payment.repository';
import { AppError } from '../utils/appError';
import type { Logger } from '../utils/logger';

const VALID_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  pending: ['processing'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export interface OutboxDispatcher {
  notify(): void;
}

export interface CreatePaymentOptions {
  idempotencyKey?: string;
  requestId: string;
}

export interface CreatePaymentResult {
  payment: Payment;
  replayed: boolean;
}

export class PaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly creation: PaymentCreationRepository,
    private readonly outbox: OutboxRepository,
    private readonly dispatcher: OutboxDispatcher,
    private readonly logger: Logger,
  ) {}

  async createPayment(
    input: CreatePaymentInput,
    options: CreatePaymentOptions,
  ): Promise<CreatePaymentResult> {
    const requestHash = hashPayload(input);
    const timestamp = now();
    const payment: Payment = {
      id: randomUUID(),
      amount: input.amount,
      currency: input.currency,
      customerId: input.customerId,
      status: 'pending',
      requestId: options.requestId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const result = await this.creation.commitCreate({
      payment,
      idempotencyKey: options.idempotencyKey,
      requestHash,
      outboxEvent: toOutboxEvent(paymentCreatedEvent(payment)),
    });

    if (result.kind === 'conflict') {
      throw AppError.idempotencyConflict();
    }

    if (result.kind === 'replayed') {
      this.logger.info({
        event: 'payment.idempotent_replay',
        paymentId: result.payment.id,
        requestId: options.requestId,
        idempotencyKey: options.idempotencyKey,
      });
      this.dispatcher.notify();
      return { payment: result.payment, replayed: true };
    }

    this.logger.info({
      event: 'payment.created',
      eventType: 'payment.created',
      paymentId: result.payment.id,
      requestId: options.requestId,
      status: result.payment.status,
    });

    this.dispatcher.notify();
    return { payment: result.payment, replayed: false };
  }

  async getPayment(paymentId: string): Promise<Payment> {
    const payment = await this.findPayment(paymentId);
    if (!payment) {
      throw AppError.paymentNotFound(paymentId);
    }
    return payment;
  }

  async findPayment(paymentId: string): Promise<Payment | null> {
    return this.payments.findById(paymentId);
  }

  async updateStatus(
    paymentId: string,
    nextStatus: PaymentStatus,
    requestId: string,
  ): Promise<Payment> {
    const committed = await this.creation.commitTransition({
      paymentId,
      mutate: (payment) => {
        assertTransition(payment.status, nextStatus);
        return {
          ...payment,
          status: nextStatus,
          updatedAt: now(),
        };
      },
      buildEvent: (payment, previousStatus) =>
        lifecycleEvent(previousStatus, payment.status, payment.requestId, payment.id),
    });

    if (!committed) {
      throw AppError.paymentNotFound(paymentId);
    }

    this.logStatusChanged(paymentId, committed.previousStatus, nextStatus, committed.payment.requestId, requestId);
    this.dispatcher.notify();
    return committed.payment;
  }

  async transitionIf(
    paymentId: string,
    expectedFrom: PaymentStatus,
    nextStatus: PaymentStatus,
    requestId: string,
  ): Promise<Payment | null> {
    const committed = await this.creation.commitTransition({
      paymentId,
      mutate: (payment) => {
        if (payment.status !== expectedFrom) {
          return null;
        }
        assertTransition(payment.status, nextStatus);
        return {
          ...payment,
          status: nextStatus,
          updatedAt: now(),
        };
      },
      buildEvent: (payment, previousStatus) =>
        lifecycleEvent(previousStatus, payment.status, payment.requestId, payment.id),
    });

    if (!committed) {
      return null;
    }

    this.logStatusChanged(
      paymentId,
      committed.previousStatus,
      nextStatus,
      committed.payment.requestId,
      requestId,
    );
    this.dispatcher.notify();
    return committed.payment;
  }

  private logStatusChanged(
    paymentId: string,
    from: PaymentStatus,
    to: PaymentStatus,
    requestId: string,
    httpRequestId?: string,
  ): void {
    this.logger.info({
      event: 'payment.status.changed',
      paymentId,
      from,
      previousStatus: from,
      to,
      newStatus: to,
      requestId,
      httpRequestId,
      timestamp: now(),
    });
  }
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (from === to || !VALID_TRANSITIONS[from].includes(to)) {
    throw AppError.invalidTransition(from, to);
  }
}

function lifecycleEvent(
  from: PaymentStatus,
  to: PaymentStatus,
  requestId: string,
  paymentId: string,
) {
  if (to === 'processing') {
    return paymentStatusEvent(EVENT_TYPES.PROCESSING, requestId, paymentId, from, to);
  }
  if (to === 'completed') {
    return paymentStatusEvent(EVENT_TYPES.COMPLETED, requestId, paymentId, from, to);
  }
  return paymentStatusEvent(EVENT_TYPES.FAILED, requestId, paymentId, from, to);
}

function now(): string {
  return new Date().toISOString();
}

function hashPayload(input: CreatePaymentInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        customerId: input.customerId,
      }),
    )
    .digest('hex');
}
