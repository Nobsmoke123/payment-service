import { Router } from 'express';
import type { PaymentController } from '../controllers/payment.controller';
import { idempotencyMiddleware } from '../middleware/idempotency.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  createPaymentSchema,
  paymentIdParamsSchema,
  updatePaymentStatusSchema,
} from '../models/payment.schema';

export function createPaymentRouter(controller: PaymentController): Router {
  const router = Router();

  router.post(
    '/payments',
    idempotencyMiddleware,
    validate(createPaymentSchema),
    controller.create,
  );

  router.get(
    '/payments/:paymentId',
    validate(paymentIdParamsSchema, 'params'),
    controller.getById,
  );

  router.patch(
    '/payments/:paymentId/status',
    validate(paymentIdParamsSchema, 'params'),
    validate(updatePaymentStatusSchema),
    controller.updateStatus,
  );

  return router;
}
