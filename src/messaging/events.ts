import { randomUUID } from 'crypto';
import type { Payment, PaymentStatus } from '../models/payment.schema';

export const EVENT_TYPES = {
  CREATED: 'payment.created',
  PROCESSING: 'payment.processing',
  COMPLETED: 'payment.completed',
  FAILED: 'payment.failed',
} as const;

export type PaymentEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface DomainEvent<T> {
  eventId: string;
  eventType: string;
  occurredAt: string;
  requestId: string;
  payload: T;
}

export interface PaymentCreatedPayload {
  paymentId: string;
  amount: number;
  currency: string;
  customerId: string;
}

export interface PaymentStatusPayload {
  paymentId: string;
  previousStatus: PaymentStatus;
  currentStatus: PaymentStatus;
}

export type PaymentCreatedEvent = DomainEvent<PaymentCreatedPayload>;
export type PaymentStatusEvent = DomainEvent<PaymentStatusPayload>;
export type PaymentDomainEvent = PaymentCreatedEvent | PaymentStatusEvent;

export function createDomainEvent<T>(
  eventType: string,
  requestId: string,
  payload: T,
): DomainEvent<T> {
  return {
    eventId: randomUUID(),
    eventType,
    occurredAt: new Date().toISOString(),
    requestId,
    payload,
  };
}

export function paymentCreatedEvent(payment: Payment): PaymentCreatedEvent {
  return createDomainEvent(EVENT_TYPES.CREATED, payment.requestId, {
    paymentId: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    customerId: payment.customerId,
  });
}

export function paymentStatusEvent(
  eventType: typeof EVENT_TYPES.PROCESSING | typeof EVENT_TYPES.COMPLETED | typeof EVENT_TYPES.FAILED,
  requestId: string,
  paymentId: string,
  previousStatus: PaymentStatus,
  currentStatus: PaymentStatus,
): PaymentStatusEvent {
  return createDomainEvent(eventType, requestId, {
    paymentId,
    previousStatus,
    currentStatus,
  });
}
