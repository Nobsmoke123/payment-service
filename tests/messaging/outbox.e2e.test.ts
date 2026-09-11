import { randomUUID } from 'crypto';
import http from 'http';
import request from 'supertest';
import { RabbitMQEventBus } from '../../src/messaging/rabbitmqEventBus';
import { validPaymentPayload } from '../fixtures/payments';
import { createTestContext } from '../helpers/app';
import { describeIfBroker } from '../helpers/broker';

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';

async function waitForStatus(app: http.Server, paymentId: string, status: string, timeoutMs = 10_000) {
  const started = Date.now();
  let lastStatus = 'unknown';
  while (Date.now() - started < timeoutMs) {
    const response = await request(app).get(`/payments/${paymentId}`);
    lastStatus = String(response.body?.data?.status ?? response.status);
    if (response.body?.data?.status === status) {
      return response;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`Timed out waiting for status ${status}; last=${lastStatus}`);
}

describeIfBroker('transactional outbox e2e', () => {
  it('publishes through the outbox, the worker completes, and correlation is preserved', async () => {
    const bus = new RabbitMQEventBus({
      url: RABBITMQ_URL,
      exchange: `payments.events.e2e.${process.pid}.${randomUUID()}`,
      paymentCreatedQueue: `payment.created.e2e.${process.pid}.${randomUUID()}`,
      maxConnectAttempts: 1,
    });
    await bus.connect();

    const { app, outbox, publisher } = await createTestContext({
      eventBus: bus,
      enableWorker: true,
      enablePublisher: true,
      paymentDelayMs: 0,
      decideOutcome: () => 'completed',
    });

    const created = await request(app)
      .post('/payments')
      .set('X-Request-ID', 'corr-outbox-e2e')
      .send(validPaymentPayload);

    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('pending');

    const completed = await waitForStatus(app, created.body.data.id, 'completed');
    expect(completed.body.data.requestId).toBe('corr-outbox-e2e');

    await publisher?.publishPending();
    await expect(outbox.findPending()).resolves.toHaveLength(0);
    await bus.close();
  }, 20_000);
});
