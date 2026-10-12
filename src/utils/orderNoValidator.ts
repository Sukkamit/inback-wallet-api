import { BadRequestError } from '../domain/errors';

// Regex pattern: ORD-<digits>-<digits> e.g. ORD-2587965432159-458
export const ORDER_NO_REGEX = /^ORD-\d+-\d+$/;

export function validateOrderNo(orderNo: string): string {
  if (!orderNo || typeof orderNo !== 'string' || !ORDER_NO_REGEX.test(orderNo)) {
    throw new BadRequestError(
      `Invalid order number format: '${orderNo}'. Expected format: ORD-<digits>-<digits> (e.g. ORD-2587965432159-458)`,
      orderNo
    );
  }
  return orderNo;
}

export function generateOrderNo(): string {
  const timestamp = Date.now();
  const randomSuffix = Math.floor(100 + Math.random() * 900); // 3 digits
  return `ORD-${timestamp}-${randomSuffix}`;
}
