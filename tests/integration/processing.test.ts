import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { InMemoryEventBus } from '../../src/messaging/inMemoryEventBus';
import { validPaymentPayload } from '../fixtures/payments';
import { createTestContext } from '../helpers/app';

describe('background processing', () => {
  it('returns 201 immediately then completes asynchronously', async () => {
    const { app, shutdown, eventBus, outbox } = await createTestContext({
      paymentDelayMs: 5,
      decideOutcome: () => 'completed',
    });

    const created = await request(app).post('/payments').send(validPaymentPayload);
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('pending');

    await shutdown();

    expect(eventBus).toBeInstanceOf(InMemoryEventBus);
    expect(
      (eventBus as InMemoryEventBus).published.some((event) => event.eventType === 'payment.created'),
    ).toBe(true);
    await expect(outbox.findPending()).resolves.toHaveLength(0);
    const records = await outbox.findAll();
    expect(records.some((record) => record.eventType === 'payment.created' && record.status === 'published')).toBe(
      true,
    );

    const response = await request(app).get(`/payments/${created.body.data.id}`);
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('completed');
    expect(response.body.data.requestId).toBe(created.body.data.requestId);
  });

  it('persists the processed payment in the repository file', async () => {
    const { app, shutdown, dataDir } = await createTestContext({
      paymentDelayMs: 0,
      decideOutcome: () => 'failed',
    });

    const created = await request(app).post('/payments').send(validPaymentPayload);
    await shutdown();

    const raw = await fs.readFile(path.join(dataDir, 'payments.json'), 'utf8');
    const stored = JSON.parse(raw) as Array<{ id: string; status: string }>;
    const payment = stored.find((item) => item.id === created.body.data.id);

    expect(payment).toBeDefined();
    expect(payment?.status).toBe('failed');
  });

  it('does not reprocess a payment that is already terminal', async () => {
    const { app, shutdown, worker } = await createTestContext({
      paymentDelayMs: 0,
      decideOutcome: () => 'completed',
    });

    const created = await request(app).post('/payments').send(validPaymentPayload);
    await shutdown();

    await worker?.handleCreated({
      eventId: created.body.data.id,
      eventType: 'payment.created',
      occurredAt: new Date().toISOString(),
      requestId: created.body.data.requestId,
      payload: {
        paymentId: created.body.data.id,
        amount: created.body.data.amount,
        currency: created.body.data.currency,
        customerId: created.body.data.customerId,
      },
    });
    await worker?.drain();

    const response = await request(app).get(`/payments/${created.body.data.id}`);
    expect(response.body.data.status).toBe('completed');
  });
});

describe('unknown routes', () => {
  it('returns a 404 envelope for an unknown endpoint', async () => {
    const { app } = await createTestContext();

    const response = await request(app).get('/unknown');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
      },
    });
  });
});
