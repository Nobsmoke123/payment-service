import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { createApp, type AppContext, type CreateAppOptions } from '../../src/app';

type TestAppContext = Omit<AppContext, 'app'> & {
  app: http.Server;
  dataDir: string;
};

const servers = new Set<http.Server>();
const contexts = new Set<AppContext>();

afterEach(async () => {
  await Promise.all([...contexts].map((context) => context.shutdown()));
  contexts.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

export async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'payment-service-'));
}

export async function createTestContext(
  overrides: CreateAppOptions = {},
): Promise<TestAppContext> {
  const dataDir = await createTempDir();
  const context = createApp({
    paymentsFilePath: path.join(dataDir, 'payments.json'),
    idempotencyFilePath: path.join(dataDir, 'idempotency.json'),
    outboxFilePath: path.join(dataDir, 'outbox.json'),
    paymentDelayMs: 0,
    outboxPollIntervalMs: 20,
    ...overrides,
  });
  await context.ready;
  contexts.add(context);

  const server = await new Promise<http.Server>((resolve, reject) => {
    const listener = context.app.listen(0, () => resolve(listener));
    listener.once('error', reject);
  });
  servers.add(server);

  return { ...context, app: server, dataDir };
}
