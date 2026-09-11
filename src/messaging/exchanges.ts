export const PAYMENTS_EXCHANGE = 'payments.events';
export const PAYMENTS_EXCHANGE_TYPE = 'topic' as const;
export const PAYMENTS_DLX = 'payments.dlx';
export const PAYMENTS_DLQ = 'payments.dlq';

export const QUEUES = {
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_PROCESSING: 'payment.processing',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
} as const;
