declare global {
  namespace Express {
    interface Request {
      requestId: string;
      idempotencyKey?: string;
    }
  }
}

export {};
