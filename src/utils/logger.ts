import pino from 'pino';

export function createLogger(service: string): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger = createLogger(process.env.SERVICE_NAME ?? 'payment-api');

export type Logger = pino.Logger;
