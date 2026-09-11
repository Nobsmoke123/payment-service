import { ConfigError, loadConfig } from '../../src/utils/config';

describe('loadConfig', () => {
  it('loads valid environment values', () => {
    const config = loadConfig({
      PORT: '4000',
      PAYMENT_DELAY_MS: '250',
      LOG_LEVEL: 'debug',
      CORS_ORIGIN: 'https://example.com',
      NODE_ENV: 'production',
      PAYMENTS_FILE_PATH: '/tmp/payments.json',
      IDEMPOTENCY_FILE_PATH: '/tmp/idempotency.json',
      OUTBOX_FILE_PATH: '/tmp/outbox.json',
    });

    expect(config).toMatchObject({
      port: 4000,
      paymentDelayMs: 250,
      logLevel: 'debug',
      corsOrigin: 'https://example.com',
      nodeEnv: 'production',
      paymentsFilePath: '/tmp/payments.json',
      idempotencyFilePath: '/tmp/idempotency.json',
      outboxFilePath: '/tmp/outbox.json',
      rabbitmqUrl: 'amqp://guest:guest@localhost:5672',
      rabbitmqExchange: 'payments.events',
      paymentQueue: 'payment.created',
    });
  });

  it('applies defaults when optional values are omitted', () => {
    const config = loadConfig({});

    expect(config.port).toBe(3000);
    expect(config.paymentDelayMs).toBe(2000);
    expect(config.logLevel).toBe('info');
    expect(config.corsOrigin).toBe('*');
    expect(config.nodeEnv).toBe('development');
    expect(config.rabbitmqUrl).toBe('amqp://guest:guest@localhost:5672');
    expect(config.rabbitmqExchange).toBe('payments.events');
    expect(config.paymentQueue).toBe('payment.created');
    expect(config.outboxPollIntervalMs).toBe(500);
    expect(Number.isNaN(config.port)).toBe(false);
    expect(Number.isNaN(config.paymentDelayMs)).toBe(false);
  });

  it('fails fast for a non-numeric PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid environment configuration/);
  });

  it('fails fast for an invalid PAYMENT_DELAY_MS', () => {
    expect(() => loadConfig({ PAYMENT_DELAY_MS: 'fast' })).toThrow(ConfigError);
  });

  it('fails fast for an invalid LOG_LEVEL', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('fails fast for an invalid NODE_ENV', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(ConfigError);
  });
});
