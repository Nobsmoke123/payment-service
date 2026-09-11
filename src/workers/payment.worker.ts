import type { EventBus } from '../messaging/eventBus.interface';
import { EVENT_TYPES, type PaymentCreatedEvent } from '../messaging/events';
import type { PaymentService } from '../services/payment.service';
import type { Logger } from '../utils/logger';

export type PaymentOutcome = 'completed' | 'failed';

export interface PaymentWorkerOptions {
  eventBus: EventBus;
  getService: () => PaymentService;
  delayMs: number;
  logger: Logger;
  decideOutcome?: () => PaymentOutcome;
}

export class PaymentWorker {
  private readonly inFlight = new Set<Promise<void>>();
  private started = false;

  constructor(private readonly options: PaymentWorkerOptions) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    await this.options.eventBus.subscribe<PaymentCreatedEvent['payload']>(
      EVENT_TYPES.CREATED,
      (event) => this.handleCreated(event),
    );

    await this.options.eventBus.subscribe(EVENT_TYPES.PROCESSING, (event) =>
      this.logLifecycle(event.eventType, event.requestId, event.payload),
    );
    await this.options.eventBus.subscribe(EVENT_TYPES.COMPLETED, (event) =>
      this.logLifecycle(event.eventType, event.requestId, event.payload),
    );
    await this.options.eventBus.subscribe(EVENT_TYPES.FAILED, (event) =>
      this.logLifecycle(event.eventType, event.requestId, event.payload),
    );
  }

  async handleCreated(event: PaymentCreatedEvent): Promise<void> {
    const work = this.execute(event).catch((error: unknown) => {
      const err = error instanceof Error ? error : new Error('Unknown worker error');
      this.options.logger.error({
        event: 'payment.worker.failed',
        paymentId: event.payload.paymentId,
        requestId: event.requestId,
        eventType: event.eventType,
        message: err.message,
        stack: err.stack,
      });
      throw error;
    });

    this.inFlight.add(work);
    try {
      await work;
    } finally {
      this.inFlight.delete(work);
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  async stop(): Promise<void> {
    await this.drain();
  }

  private async execute(event: PaymentCreatedEvent): Promise<void> {
    const { paymentId } = event.payload;
    const service = this.options.getService();
    const payment = await service.findPayment(paymentId);

    if (!payment) {
      this.options.logger.info({
        event: 'payment.processor.skipped',
        paymentId,
        requestId: event.requestId,
        eventType: EVENT_TYPES.CREATED,
        reason: 'not_found',
      });
      return;
    }

    const requestId = payment.requestId;

    if (this.options.delayMs > 0) {
      await delay(this.options.delayMs);
    }

    let current = payment;
    if (current.status === 'pending') {
      const processing = await service.transitionIf(paymentId, 'pending', 'processing', requestId);
      if (processing) {
        current = processing;
      } else {
        const latest = await service.findPayment(paymentId);
        if (!latest) {
          return;
        }
        current = latest;
      }
    }

    if (current.status !== 'processing') {
      this.options.logger.info({
        event: 'payment.processor.skipped',
        paymentId,
        requestId,
        eventType: EVENT_TYPES.CREATED,
        reason: 'not_pending',
      });
      return;
    }

    const outcome = this.options.decideOutcome?.() ?? defaultOutcome();
    const updated = await service.transitionIf(paymentId, 'processing', outcome, requestId);
    if (!updated) {
      this.options.logger.info({
        event: 'payment.processor.skipped',
        paymentId,
        requestId,
        eventType: EVENT_TYPES.CREATED,
        reason: 'not_processing',
      });
    }
  }

  private logLifecycle(eventType: string, requestId: string, payload: unknown): void {
    const paymentId =
      payload && typeof payload === 'object' && 'paymentId' in payload
        ? String((payload as { paymentId: string }).paymentId)
        : undefined;

    this.options.logger.info({
      service: 'payment-worker',
      requestId,
      paymentId,
      eventType,
      event: eventType,
    });
  }
}

function defaultOutcome(): PaymentOutcome {
  return Math.random() < 0.5 ? 'completed' : 'failed';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
