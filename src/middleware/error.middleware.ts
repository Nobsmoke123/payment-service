import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/appError';
import { logger } from '../utils/logger';

export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({
        requestId,
        errorCode: err.code,
        message: err.message,
        stack: err.stack,
      });
    } else {
      logger.warn({
        requestId,
        errorCode: err.code,
        message: err.message,
      });
    }

    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  if (err instanceof SyntaxError) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON payload',
      },
    });
    return;
  }

  const error = err instanceof Error ? err : new Error('Unknown error');
  logger.error({
    requestId,
    errorCode: 'INTERNAL_ERROR',
    message: error.message,
    stack: error.stack,
  });

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}

export function notFoundMiddleware(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`Cannot ${req.method} ${req.path}`));
}
