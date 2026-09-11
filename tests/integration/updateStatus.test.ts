import request from 'supertest';
import { validPaymentPayload } from '../fixtures/payments';
import { createTestContext } from '../helpers/app';
import { InMemoryEventBus } from '../../src/messaging/inMemoryEventBus';

describe('PATCH /payments/:paymentId/status', () => {
  it('allows a valid pending to processing transition', async () => {
    const { app } = await createTestContext();
    const created = await request(app).post('/payments').send(validPaymentPayload);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const response = await request(app)
      .patch(`/payments/${created.body.data.id}/status`)
      .send({ status: 'processing' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('processing');
    expect(response.body.data.createdAt).toBe(created.body.data.createdAt);
    expect(response.body.data.updatedAt).not.toBe(created.body.data.updatedAt);
  });

  it('rejects an invalid transition from pending to completed', async () => {
    const { app } = await createTestContext();
    const created = await request(app).post('/payments').send(validPaymentPayload);

    const response = await request(app)
      .patch(`/payments/${created.body.data.id}/status`)
      .send({ status: 'completed' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_STATE_TRANSITION',
        message: 'Cannot transition from pending to completed.',
      },
    });
  });

  it('rejects an invalid status value', async () => {
    const { app } = await createTestContext();
    const created = await request(app).post('/payments').send(validPaymentPayload);

    const response = await request(app)
      .patch(`/payments/${created.body.data.id}/status`)
      .send({ status: 'refunded' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not allow a completed payment to change', async () => {
    const { app } = await createTestContext();
    const created = await request(app).post('/payments').send(validPaymentPayload);
    const paymentId = created.body.data.id;

    await request(app).patch(`/payments/${paymentId}/status`).send({ status: 'processing' });
    const completed = await request(app)
      .patch(`/payments/${paymentId}/status`)
      .send({ status: 'completed' });

    expect(completed.status).toBe(200);

    const response = await request(app)
      .patch(`/payments/${paymentId}/status`)
      .send({ status: 'failed' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(response.body.error.message).toBe('Cannot transition from completed to failed.');
  });

  it('publishes a completed lifecycle event with the original requestId', async () => {
    const { app, eventBus, publisher } = await createTestContext({
      eventBus: new InMemoryEventBus(),
    });
    const created = await request(app)
      .post('/payments')
      .set('X-Request-ID', 'origin-req-patch')
      .send(validPaymentPayload);

    await request(app)
      .patch(`/payments/${created.body.data.id}/status`)
      .send({ status: 'processing' });
    const completed = await request(app)
      .patch(`/payments/${created.body.data.id}/status`)
      .send({ status: 'completed' });

    expect(completed.status).toBe(200);
    await publisher?.publishPending();
    await eventBus.drain?.();

    const memory = eventBus as InMemoryEventBus;
    const completedEvent = memory.published.find((event) => event.eventType === 'payment.completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.requestId).toBe('origin-req-patch');
    expect((completedEvent?.payload as { currentStatus: string }).currentStatus).toBe('completed');
  });

  it('publishes a failed lifecycle event with the original requestId', async () => {
    const { app, eventBus, publisher } = await createTestContext({
      eventBus: new InMemoryEventBus(),
    });
    const created = await request(app)
      .post('/payments')
      .set('X-Request-ID', 'origin-req-fail')
      .send(validPaymentPayload);

    await request(app)
      .patch(`/payments/${created.body.data.id}/status`)
      .send({ status: 'processing' });
    await request(app)
      .patch(`/payments/${created.body.data.id}/status`)
      .send({ status: 'failed' });

    await publisher?.publishPending();
    await eventBus.drain?.();

    const memory = eventBus as InMemoryEventBus;
    const failedEvent = memory.published.find((event) => event.eventType === 'payment.failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.requestId).toBe('origin-req-fail');
  });

  it('returns 400 for a non-v4 UUID', async () => {
    const { app } = await createTestContext();

    const response = await request(app)
      .patch('/payments/6ba7b810-9dad-11d1-80b4-00c04fd430c8/status')
      .send({ status: 'processing' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('paymentId must be a valid UUID v4');
  });
});
