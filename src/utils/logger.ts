import winston from 'winston';

const { combine, timestamp, printf, colorize, json } = winston.format;

const logFormat = printf(({ level, message, timestamp, orderNo, ...meta }) => {
  const orderPrefix = orderNo ? `[Order: ${orderNo}] ` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}] ${orderPrefix}${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    process.env.NODE_ENV === 'production' ? json() : combine(colorize(), logFormat)
  ),
  transports: [new winston.transports.Console()],
});

export const createOrderLogger = (orderNo: string) => {
  return {
    info: (msg: string, meta?: Record<string, unknown>) => logger.info(msg, { orderNo, ...meta }),
    warn: (msg: string, meta?: Record<string, unknown>) => logger.warn(msg, { orderNo, ...meta }),
    error: (msg: string, meta?: Record<string, unknown>) => logger.error(msg, { orderNo, ...meta }),
    debug: (msg: string, meta?: Record<string, unknown>) => logger.debug(msg, { orderNo, ...meta }),
  };
};
