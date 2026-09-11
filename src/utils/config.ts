import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';
import { PAYMENTS_EXCHANGE, QUEUES } from '../messaging/exchanges';

dotenv.config();

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const NODE_ENVS = ['development', 'test', 'production'] as const;

function numericEnv(defaultValue: number, min: number, max: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') {
      return defaultValue;
    }
    return value;
  }, z.coerce.number().int().min(min).max(max));
}

function stringEnv(defaultValue: string) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : value),
    z.string().min(1),
  );
}

const envSchema = z.object({
  PORT: numericEnv(3000, 1, 65535),
  PAYMENT_DELAY_MS: numericEnv(2000, 0, 3_600_000),
  LOG_LEVEL: z.preprocess(
    (value) => (value === undefined || value === '' ? 'info' : value),
    z.enum(LOG_LEVELS),
  ),
  CORS_ORIGIN: z.preprocess(
    (value) => (value === undefined || value === '' ? '*' : value),
    z.string().min(1),
  ),
  NODE_ENV: z.preprocess(
    (value) => (value === undefined || value === '' ? 'development' : value),
    z.enum(NODE_ENVS),
  ),
  PAYMENTS_FILE_PATH: z.string().min(1).optional(),
  IDEMPOTENCY_FILE_PATH: z.string().min(1).optional(),
  OUTBOX_FILE_PATH: z.string().min(1).optional(),
  OUTBOX_POLL_INTERVAL_MS: numericEnv(500, 10, 60_000),
  RABBITMQ_URL: stringEnv('amqp://guest:guest@localhost:5672'),
  RABBITMQ_EXCHANGE: stringEnv(PAYMENTS_EXCHANGE),
  PAYMENT_QUEUE: stringEnv(QUEUES.PAYMENT_CREATED),
  SERVICE_NAME: stringEnv('payment-api'),
});

export interface Config {
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
  paymentDelayMs: number;
  corsOrigin: string;
  nodeEnv: (typeof NODE_ENVS)[number];
  paymentsFilePath: string;
  idempotencyFilePath: string;
  outboxFilePath: string;
  outboxPollIntervalMs: number;
  rabbitmqUrl: string;
  rabbitmqExchange: string;
  paymentQueue: string;
  serviceName: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${details}`);
  }

  return {
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    paymentDelayMs: parsed.data.PAYMENT_DELAY_MS,
    corsOrigin: parsed.data.CORS_ORIGIN,
    nodeEnv: parsed.data.NODE_ENV,
    paymentsFilePath:
      parsed.data.PAYMENTS_FILE_PATH ?? path.join(process.cwd(), 'data', 'payments.json'),
    idempotencyFilePath:
      parsed.data.IDEMPOTENCY_FILE_PATH ?? path.join(process.cwd(), 'data', 'idempotency.json'),
    outboxFilePath:
      parsed.data.OUTBOX_FILE_PATH ?? path.join(process.cwd(), 'data', 'outbox.json'),
    outboxPollIntervalMs: parsed.data.OUTBOX_POLL_INTERVAL_MS,
    rabbitmqUrl: parsed.data.RABBITMQ_URL,
    rabbitmqExchange: parsed.data.RABBITMQ_EXCHANGE,
    paymentQueue: parsed.data.PAYMENT_QUEUE,
    serviceName: parsed.data.SERVICE_NAME,
  };
}
