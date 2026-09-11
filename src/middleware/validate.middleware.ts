import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';
import { AppError } from '../utils/appError';

function formatZodError(error: ZodError): string {
  const first = error.issues[0];
  if (!first) {
    return 'Request validation failed';
  }
  return first.message;
}

export function validate(schema: ZodTypeAny, source: 'body' | 'params' = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(AppError.validation(formatZodError(result.error)));
      return;
    }
    req[source] = result.data;
    next();
  };
}
