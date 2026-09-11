import request from 'supertest';
import { randomUUID } from 'crypto';
import { validPaymentPayload } from '../fixtures/payments';
import { createTestContext } from '../helpers/app';

describe('GET /payments/:paymentId', () => {
  it('returns an existing payment', async () => {
    const { app } = await createTestContext();
    const created = await request(app).post('/payments').send(validPaymentPayload);

    const response = await request(app).get(`/payments/${created.body.data.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: created.body.data,
    });
  });

  it('returns 404 for a missing payment', async () => {
    const { app } = await createTestContext();
    const missingId = randomUUID();

    const response = await request(app).get(`/payments/${missingId}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'PAYMENT_NOT_FOUND',
        message: `Payment ${missingId} was not found.`,
      },
    });
  });

  it('returns 400 for an invalid UUID', async () => {
    const { app } = await createTestContext();

    const response = await request(app).get('/payments/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a non-v4 UUID', async () => {
    const { app } = await createTestContext();

    const response = await request(app).get('/payments/6ba7b810-9dad-11d1-80b4-00c04fd430c8');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('paymentId must be a valid UUID v4');
  });
});
