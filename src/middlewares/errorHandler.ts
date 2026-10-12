import { Request, Response, NextFunction } from 'express';
import { AppError } from '../domain/errors';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const orderNo = (err as AppError).orderNo || req.params.orderNo || (req.body && req.body.orderNo);

  if (err instanceof AppError) {
    logger.warn(`Handled error [${err.code}]: ${err.message}`, {
      code: err.code,
      statusCode: err.statusCode,
      orderNo,
      path: req.originalUrl,
      method: req.method,
    });

    res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      ...(orderNo ? { orderNo } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // Unhandled / Internal Server Error
  logger.error(`Unhandled internal error: ${err.message}`, {
    stack: err.stack,
    orderNo,
    path: req.originalUrl,
    method: req.method,
  });

  res.status(500).json({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected internal server error occurred.',
    ...(orderNo ? { orderNo } : {}),
  });
}
