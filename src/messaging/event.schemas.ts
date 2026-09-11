import { z } from 'zod';
import { PAYMENT_STATUSES, UUID_V4_REGEX } from '../models/payment.schema';
import { EVENT_TYPES } from './events';

export const uuidValueSchema = z.string().regex(UUID_V4_REGEX, 'must be a valid UUID v4');

export const baseDomainEventSchema = z.object({
  eventId: uuidValueSchema,
  eventType: z.string().min(1),
  occurredAt: z.string().datetime(),
  requestId: z.string().min(1),
  payload: z.unknown(),
});

export const paymentCreatedPayloadSchema = z.object({
  paymentId: uuidValueSchema,
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  customerId: z.string().min(1),
});

export const paymentStatusPayloadSchema = z.object({
  paymentId: uuidValueSchema,
  previousStatus: z.enum(PAYMENT_STATUSES),
  currentStatus: z.enum(PAYMENT_STATUSES),
});

export const paymentCreatedEventSchema = baseDomainEventSchema.extend({
  eventType: z.literal(EVENT_TYPES.CREATED),
  payload: paymentCreatedPayloadSchema,
});

export const paymentProcessingEventSchema = baseDomainEventSchema.extend({
  eventType: z.literal(EVENT_TYPES.PROCESSING),
  payload: paymentStatusPayloadSchema,
});

export const paymentCompletedEventSchema = baseDomainEventSchema.extend({
  eventType: z.literal(EVENT_TYPES.COMPLETED),
  payload: paymentStatusPayloadSchema,
});

export const paymentFailedEventSchema = baseDomainEventSchema.extend({
  eventType: z.literal(EVENT_TYPES.FAILED),
  payload: paymentStatusPayloadSchema,
});

export const domainEventSchema = z.union([
  paymentCreatedEventSchema,
  paymentProcessingEventSchema,
  paymentCompletedEventSchema,
  paymentFailedEventSchema,
]);

export type ParsedDomainEvent = z.infer<typeof domainEventSchema>;

export function parseIncomingEvent(raw: unknown): z.SafeParseReturnType<unknown, ParsedDomainEvent> {
  return domainEventSchema.safeParse(raw);
}

export function assertPublishableEvent<T>(event: T): T {
  const parsed = domainEventSchema.safeParse(event);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid domain event';
    throw new Error(`Cannot publish invalid domain event: ${message}`);
  }
  return event;
}
