import request from 'supertest';
import { randomUUID } from 'crypto';
import { validPaymentPayload } from '../fixtures/payments';
import { createTestContext } from '../helpers/app';

describe('POST /payments', () => {
  it('creates a pending payment with a UUID v4 id', async () => {
    const { app } = await createTestContext();

    const response = await request(app).post('/payments').send(validPaymentPayload);

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      amount: validPaymentPayload.amount,
      currency: validPaymentPayload.currency,
      customerId: validPaymentPayload.customerId,
      status: 'pending',
    });
    expect(response.body.data.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.body.data.createdAt).toEqual(response.body.data.updatedAt);
    expect(response.body.data.requestId).toBe(response.headers['x-request-id']);
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('honors an incoming X-Request-ID', async () => {
    const { app } = await createTestContext();
    const requestId = randomUUID();

    const response = await request(app)
      .post('/payments')
      .set('X-Request-ID', requestId)
      .send(validPaymentPayload);

    expect(response.status).toBe(201);
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body.data.requestId).toBe(requestId);
  });

  it('writes a pending outbox record and returns immediately', async () => {
    const { app, outbox } = await createTestContext({ enablePublisher: false });

    const response = await request(app).post('/payments').send(validPaymentPayload);

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('pending');
    const pending = await outbox.findPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].eventType).toBe('payment.created');
    expect(pending[0].status).toBe('pending');
  });

  it('rejects an invalid payload', async () => {
    const { app } = await createTestContext();

    const response = await request(app).post('/payments').send({
      amount: 'ten',
      currency: 'US',
      customerId: '',
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
  });

  it('rejects a negative amount', async () => {
    const { app } = await createTestContext();

    const response = await request(app).post('/payments').send({
      ...validPaymentPayload,
      amount: -5,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Amount must be greater than zero');
  });

  it('rejects a missing currency', async () => {
    const { app } = await createTestContext();

    const response = await request(app).post('/payments').send({
      amount: 10,
      customerId: 'cus_1',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a missing customerId', async () => {
    const { app } = await createTestContext();

    const response = await request(app).post('/payments').send({
      amount: 10,
      currency: 'USD',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns the original payment for a duplicate idempotency key', async () => {
    const { app } = await createTestContext();
    const key = randomUUID();

    const first = await request(app)
      .post('/payments')
      .set('Idempotency-Key', key)
      .send(validPaymentPayload);

    const second = await request(app)
      .post('/payments')
      .set('Idempotency-Key', key)
      .send(validPaymentPayload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it('rejects a reused idempotency key with a different payload', async () => {
    const { app } = await createTestContext();
    const key = randomUUID();

    await request(app).post('/payments').set('Idempotency-Key', key).send(validPaymentPayload);

    const response = await request(app)
      .post('/payments')
      .set('Idempotency-Key', key)
      .send({ ...validPaymentPayload, amount: 99 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('creates distinct payments when idempotency keys differ', async () => {
    const { app } = await createTestContext();

    const first = await request(app)
      .post('/payments')
      .set('Idempotency-Key', randomUUID())
      .send(validPaymentPayload);
    const second = await request(app)
      .post('/payments')
      .set('Idempotency-Key', randomUUID())
      .send(validPaymentPayload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.data.id).not.toBe(second.body.data.id);
  });

  it('does not create a duplicate payment after a persistence failure', async () => {
    let failOnce = true;
    const { app } = await createTestContext({
      paymentCreationHooks: {
        afterPaymentWrite: () => {
          if (failOnce) {
            failOnce = false;
            throw new Error('simulated persistence failure');
          }
        },
      },
    });
    const key = randomUUID();

    const failed = await request(app)
      .post('/payments')
      .set('Idempotency-Key', key)
      .send(validPaymentPayload);

    expect(failed.status).toBe(500);

    const retried = await request(app)
      .post('/payments')
      .set('Idempotency-Key', key)
      .send(validPaymentPayload);

    expect(retried.status).toBe(201);
    expect(retried.body.data.status).toBe('pending');

    const again = await request(app)
      .post('/payments')
      .set('Idempotency-Key', key)
      .send(validPaymentPayload);

    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(retried.body.data.id);
  });

  it('creates a single payment for concurrent requests with the same idempotency key', async () => {
    const { app } = await createTestContext();
    const key = randomUUID();

    const [first, second] = await Promise.all([
      request(app).post('/payments').set('Idempotency-Key', key).send(validPaymentPayload),
      request(app).post('/payments').set('Idempotency-Key', key).send(validPaymentPayload),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(first.body.data.id).toBe(second.body.data.id);
  });
});
