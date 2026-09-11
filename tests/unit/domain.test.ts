import { createPaymentSchema, paymentIdParamsSchema, updatePaymentStatusSchema } from '../../src/models/payment.schema';
import { assertTransition } from '../../src/services/payment.service';
import { AppError } from '../../src/utils/appError';
import { Mutex } from '../../src/utils/fileLock';

describe('createPaymentSchema', () => {
  it('accepts a valid payload', () => {
    const parsed = createPaymentSchema.parse({
      amount: 10,
      currency: 'USD',
      customerId: 'cus_1',
    });
    expect(parsed).toEqual({
      amount: 10,
      currency: 'USD',
      customerId: 'cus_1',
    });
  });

  it('rejects a negative amount', () => {
    const result = createPaymentSchema.safeParse({
      amount: -1,
      currency: 'USD',
      customerId: 'cus_1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Amount must be greater than zero');
    }
  });

  it('rejects a missing currency', () => {
    const result = createPaymentSchema.safeParse({
      amount: 10,
      customerId: 'cus_1',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty customerId', () => {
    const result = createPaymentSchema.safeParse({
      amount: 10,
      currency: 'USD',
      customerId: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a lowercase currency code', () => {
    const result = createPaymentSchema.safeParse({
      amount: 10,
      currency: 'usd',
      customerId: 'cus_1',
    });
    expect(result.success).toBe(false);
  });
});

describe('updatePaymentStatusSchema', () => {
  it('accepts a valid status', () => {
    expect(updatePaymentStatusSchema.parse({ status: 'processing' })).toEqual({
      status: 'processing',
    });
  });

  it('rejects an unknown status', () => {
    const result = updatePaymentStatusSchema.safeParse({ status: 'refunded' });
    expect(result.success).toBe(false);
  });
});

describe('paymentIdParamsSchema', () => {
  it('accepts a UUID v4', () => {
    expect(
      paymentIdParamsSchema.parse({ paymentId: '550e8400-e29b-41d4-a716-446655440000' }),
    ).toEqual({
      paymentId: '550e8400-e29b-41d4-a716-446655440000',
    });
  });

  it('rejects a UUID that is not v4', () => {
    const result = paymentIdParamsSchema.safeParse({
      paymentId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('paymentId must be a valid UUID v4');
    }
  });
});

describe('assertTransition', () => {
  it('allows pending to processing', () => {
    expect(() => assertTransition('pending', 'processing')).not.toThrow();
  });

  it('allows processing to completed or failed', () => {
    expect(() => assertTransition('processing', 'completed')).not.toThrow();
    expect(() => assertTransition('processing', 'failed')).not.toThrow();
  });

  it('rejects completed to pending', () => {
    try {
      assertTransition('completed', 'pending');
      fail('expected AppError');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('rejects failed to completed', () => {
    expect(() => assertTransition('failed', 'completed')).toThrow(AppError);
  });

  it('rejects pending to completed', () => {
    expect(() => assertTransition('pending', 'completed')).toThrow(AppError);
  });
});

describe('Mutex', () => {
  it('serializes exclusive work', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    await Promise.all([
      mutex.runExclusive(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(1);
      }),
      mutex.runExclusive(async () => {
        order.push(2);
      }),
    ]);

    expect(order).toEqual([1, 2]);
  });
});
