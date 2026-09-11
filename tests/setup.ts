import { probeRabbitMq } from './helpers/broker';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

const globalState = globalThis as typeof globalThis & { __rabbitMqAvailable?: boolean };
if (globalState.__rabbitMqAvailable === undefined) {
  globalState.__rabbitMqAvailable = probeRabbitMq();
}
process.env.JEST_RABBITMQ_AVAILABLE = globalState.__rabbitMqAvailable ? '1' : '0';
