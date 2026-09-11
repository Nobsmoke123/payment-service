import { execFileSync } from 'child_process';
import path from 'path';

const DEFAULT_URL = 'amqp://guest:guest@localhost:5672';

export function probeRabbitMq(url = process.env.RABBITMQ_URL ?? DEFAULT_URL): boolean {
  const script = `
    const amqp = require('amqplib');
    const timeout = setTimeout(() => process.exit(1), 500);
    amqp.connect(${JSON.stringify(url)})
      .then((connection) => connection.close())
      .then(() => {
        clearTimeout(timeout);
        process.exit(0);
      })
      .catch(() => process.exit(1));
  `;

  try {
    execFileSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '../..'),
      env: process.env,
      stdio: 'ignore',
      timeout: 1500,
    });
    return true;
  } catch {
    return false;
  }
}

export function describeIfBroker(name: string, fn: () => void): void {
  const block = process.env.JEST_RABBITMQ_AVAILABLE === '1' ? describe : describe.skip;
  block(name, fn);
}
