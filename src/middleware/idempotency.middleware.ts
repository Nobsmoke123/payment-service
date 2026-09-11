import type { NextFunction, Request, Response } from 'express';

const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export function idempotencyMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const value = req.header(IDEMPOTENCY_HEADER);
  if (value && value.trim().length > 0) {
    req.idempotencyKey = value.trim();
  }
  next();
}
