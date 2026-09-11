import http from 'http';
import { createApp } from './app';
import { RabbitMQEventBus } from './messaging/rabbitmqEventBus';
import { loadConfig } from './utils/config';
import { createLogger } from './utils/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('payment-api');
  const eventBus = new RabbitMQEventBus({
    url: config.rabbitmqUrl,
    exchange: config.rabbitmqExchange,
    paymentCreatedQueue: config.paymentQueue,
  });

  await eventBus.connect();

  const { app, shutdown, ready } = createApp({
    eventBus,
    enableWorker: false,
    enablePublisher: true,
    logger,
  });
  await ready;

  const server = http.createServer(app);

  server.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, 'Payment API listening');
  });

  let shuttingDown = false;

  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Received shutdown signal');

    server.close((closeError) => {
      void (async () => {
        try {
          await shutdown();
          await eventBus.close();
          if (closeError) {
            logger.error({ err: closeError }, 'Error while closing HTTP server');
          } else {
            logger.info('HTTP server closed');
          }
          logger.flush();
          process.exit(closeError ? 1 : 0);
        } catch (error) {
          logger.error({ err: error }, 'Error during graceful shutdown');
          process.exit(1);
        }
      })();
    });

    setTimeout(() => {
      logger.error('Graceful shutdown timed out');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });
}

void main().catch((error: unknown) => {
  const logger = createLogger('payment-api');
  logger.error({ err: error }, 'API failed to start');
  process.exit(1);
});
