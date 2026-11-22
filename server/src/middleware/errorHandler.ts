import { Request, Response, NextFunction } from 'express';

export interface ApiError {
  error: string;
  code?: string;
  details?: unknown;
}

export function errorHandler(
  err: Error & { status?: number; code?: string; details?: unknown },
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const name = err.name ?? 'Error';

  if (name === 'InvalidTransitionError') {
    res.status(409).json({ error: err.message, code: 'INVALID_TRANSITION' });
    return;
  }

  if (name === 'ZodError') {
    res.status(400).json({ error: 'Validation error', details: err });
    return;
  }

  const status = err.status ?? 500;
  const message = status < 500 ? err.message : 'Internal server error';

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({
    error: message,
    ...(err.code ? { code: err.code } : {}),
  });
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ error: 'Not found' });
}
