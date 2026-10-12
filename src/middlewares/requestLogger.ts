import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const correlationId = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();
  req.headers['x-correlation-id'] = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);

  const orderNo = req.params.orderNo || req.body?.orderNo || req.query.orderNo;
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`, {
      correlationId,
      orderNo: orderNo ? String(orderNo) : undefined,
      statusCode: res.statusCode,
      duration,
    });
  });

  next();
}
