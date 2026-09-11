import { z } from 'zod';

export const PAYMENT_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuidV4Schema = z
  .string()
  .regex(UUID_V4_REGEX, 'paymentId must be a valid UUID v4');

export const createPaymentSchema = z.object({
  amount: z
    .number({
      required_error: 'amount is required',
      invalid_type_error: 'amount must be a number',
    })
    .positive({ message: 'Amount must be greater than zero' }),
  currency: z
    .string({
      required_error: 'currency is required',
      invalid_type_error: 'currency must be a string',
    })
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code'),
  customerId: z
    .string({
      required_error: 'customerId is required',
      invalid_type_error: 'customerId must be a string',
    })
    .trim()
    .min(1, 'customerId is required'),
});

export const updatePaymentStatusSchema = z.object({
  status: z.enum(PAYMENT_STATUSES, {
    errorMap: () => ({
      message: 'status must be one of pending, processing, completed, failed',
    }),
  }),
});

export const paymentIdParamsSchema = z.object({
  paymentId: uuidV4Schema,
});

export const paymentSchema = z.object({
  id: uuidV4Schema,
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  customerId: z.string().min(1),
  status: z.enum(PAYMENT_STATUSES),
  requestId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentStatusInput = z.infer<typeof updatePaymentStatusSchema>;
export type Payment = z.infer<typeof paymentSchema>;
