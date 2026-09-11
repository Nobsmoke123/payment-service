import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { PaymentController } from './controllers/payment.controller';
import { errorMiddleware, notFoundMiddleware } from './middleware/error.middleware';
import { requestLoggerMiddleware } from './middleware/requestLogger.middleware';
import type { EventBus } from './messaging/eventBus.interface';
import { InMemoryEventBus, NoopEventBus } from './messaging/inMemoryEventBus';
import { OutboxPublisher } from './messaging/outbox.publisher';
import { createPaymentRouter } from './routes/payment.routes';
import { IdempotencyRepository } from './repositories/idempotency.repository';
import { OutboxRepository } from './repositories/outbox.repository';
import { PaymentCreationRepository, type PaymentCreationHooks } from './repositories/paymentCreation.repository';
import { PaymentRepository } from './repositories/payment.repository';
import { PaymentService } from './services/payment.service';
import { loadConfig } from './utils/config';
import { logger as defaultLogger, type Logger } from './utils/logger';
import { requestIdMiddleware } from './utils/requestId';
import { PaymentWorker, type PaymentOutcome } from './workers/payment.worker';

export interface CreateAppOptions {
  paymentsFilePath?: string;
  idempotencyFilePath?: string;
  outboxFilePath?: string;
  paymentDelayMs?: number;
  corsOrigin?: string;
  eventBus?: EventBus;
  enableWorker?: boolean;
  enablePublisher?: boolean;
  outboxPollIntervalMs?: number;
  decideOutcome?: () => PaymentOutcome;
  paymentCreationHooks?: PaymentCreationHooks;
  logger?: Logger;
}

export interface AppContext {
  app: Express;
  paymentService: PaymentService;
  eventBus: EventBus;
  outbox: OutboxRepository;
  publisher?: OutboxPublisher;
  worker?: PaymentWorker;
  ready: Promise<void>;
  shutdown: () => Promise<void>;
}

export function createApp(options: CreateAppOptions = {}): AppContext {
  const config = loadConfig();
  const log = options.logger ?? defaultLogger;
  const paymentsFilePath = options.paymentsFilePath ?? config.paymentsFilePath;
  const idempotencyFilePath = options.idempotencyFilePath ?? config.idempotencyFilePath;
  const outboxFilePath = options.outboxFilePath ?? config.outboxFilePath;
  const paymentDelayMs = options.paymentDelayMs ?? config.paymentDelayMs;
  const corsOrigin = options.corsOrigin ?? config.corsOrigin;

  const paymentRepository = new PaymentRepository(paymentsFilePath);
  const idempotencyRepository = new IdempotencyRepository(idempotencyFilePath);
  const outboxRepository = new OutboxRepository(outboxFilePath);
  const paymentCreationRepository = new PaymentCreationRepository(
    paymentRepository,
    idempotencyRepository,
    outboxRepository,
    options.paymentCreationHooks,
  );

  const startWorker = options.enableWorker === true || options.decideOutcome !== undefined;
  const startPublisher = options.enablePublisher ?? true;
  const eventBus: EventBus =
    options.eventBus ?? (startWorker ? new InMemoryEventBus() : new NoopEventBus());

  const publisher = startPublisher
    ? new OutboxPublisher({
        outbox: outboxRepository,
        eventBus,
        logger: log,
        intervalMs: options.outboxPollIntervalMs ?? config.outboxPollIntervalMs,
      })
    : undefined;

  const paymentService = new PaymentService(
    paymentRepository,
    paymentCreationRepository,
    outboxRepository,
    publisher ?? { notify() {} },
    log,
  );

  let worker: PaymentWorker | undefined;
  const startups: Promise<void>[] = [];
  if (startWorker) {
    worker = new PaymentWorker({
      eventBus,
      getService: () => paymentService,
      delayMs: paymentDelayMs,
      logger: log,
      decideOutcome: options.decideOutcome,
    });
    startups.push(worker.start());
  }
  if (publisher) {
    startups.push(publisher.start());
  }

  const controller = new PaymentController(paymentService);
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((value) => value.trim()),
    }),
  );
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(requestLoggerMiddleware);
  app.use(createPaymentRouter(controller));
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return {
    app,
    paymentService,
    eventBus,
    outbox: outboxRepository,
    publisher,
    worker,
    ready: Promise.all(startups).then(() => undefined),
    shutdown: async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (publisher) {
          await publisher.publishPending();
        }
        if (eventBus.drain) {
          await eventBus.drain();
        }
        if (worker) {
          await worker.drain();
        }
        const pending = await outboxRepository.findPending();
        if (pending.length === 0) {
          break;
        }
      }
      if (publisher) {
        await publisher.stop();
      }
      if (worker) {
        await worker.stop();
      }
    },
  };
}
