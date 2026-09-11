import type { Request, Response } from 'express';
import type { CreatePaymentInput, UpdatePaymentStatusInput } from '../models/payment.schema';
import type { PaymentService } from '../services/payment.service';
import { asyncHandler } from '../utils/asyncHandler';

export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  create = asyncHandler(async (req: Request, res: Response) => {
    const result = await this.paymentService.createPayment(req.body as CreatePaymentInput, {
      idempotencyKey: req.idempotencyKey,
      requestId: req.requestId,
    });

    res.status(result.replayed ? 200 : 201).json({
      success: true,
      data: result.payment,
    });
  });

  getById = asyncHandler(async (req: Request, res: Response) => {
    const payment = await this.paymentService.getPayment(req.params.paymentId);
    res.status(200).json({
      success: true,
      data: payment,
    });
  });

  updateStatus = asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as UpdatePaymentStatusInput;
    const payment = await this.paymentService.updateStatus(
      req.params.paymentId,
      body.status,
      req.requestId,
    );

    res.status(200).json({
      success: true,
      data: payment,
    });
  });
}
