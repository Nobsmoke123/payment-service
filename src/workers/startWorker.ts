import { createApp } from '../app';
import { RabbitMQEventBus } from '../messaging/rabbitmqEventBus';
import { loadConfig } from '../utils/config';
import { createLogger } from '../utils/logger';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('payment-worker');
  const eventBus = new RabbitMQEventBus({
    url: config.rabbitmqUrl,
    exchange: config.rabbitmqExchange,
    paymentCreatedQueue: config.paymentQueue,
  });

  await eventBus.connect();

  const { ready, shutdown } = createApp({
    eventBus,
    enableWorker: true,
    enablePublisher: false,
    logger,
  });
  await ready;

  logger.info(
    { exchange: config.rabbitmqExchange, queue: config.paymentQueue },
    'Payment worker listening',
  );

  let shuttingDown = false;
  const onSignal = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Received shutdown signal');
    try {
      await shutdown();
      await eventBus.close();
      logger.flush();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => {
    void onSignal('SIGINT');
  });
  process.on('SIGTERM', () => {
    void onSignal('SIGTERM');
  });
}

void main().catch((error: unknown) => {
  const logger = createLogger('payment-worker');
  logger.error({ err: error }, 'Worker failed to start');
  process.exit(1);
});
