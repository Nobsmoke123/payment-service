export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'PAYMENT_NOT_FOUND'
  | 'INVALID_STATE_TRANSITION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL_ERROR'
  | 'NOT_FOUND';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static validation(message: string): AppError {
    return new AppError(400, 'VALIDATION_ERROR', message);
  }

  static paymentNotFound(paymentId: string): AppError {
    return new AppError(404, 'PAYMENT_NOT_FOUND', `Payment ${paymentId} was not found.`);
  }

  static invalidTransition(from: string, to: string): AppError {
    return new AppError(
      409,
      'INVALID_STATE_TRANSITION',
      `Cannot transition from ${from} to ${to}.`,
    );
  }

  static idempotencyConflict(): AppError {
    return new AppError(
      409,
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key was reused with a different request payload.',
    );
  }

  static notFound(message = 'Route not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static internal(message = 'An unexpected error occurred'): AppError {
    return new AppError(500, 'INTERNAL_ERROR', message);
  }
}
