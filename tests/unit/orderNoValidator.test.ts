import { validateOrderNo, generateOrderNo, ORDER_NO_REGEX } from '../../src/utils/orderNoValidator';
import { BadRequestError } from '../../src/domain/errors';

describe('orderNoValidator', () => {
  it('should accept valid order numbers in ORD-<digits>-<digits> format', () => {
    expect(validateOrderNo('ORD-2587965432159-458')).toBe('ORD-2587965432159-458');
    expect(validateOrderNo('ORD-1-2')).toBe('ORD-1-2');
  });

  it('should reject invalid formats and throw BadRequestError', () => {
    expect(() => validateOrderNo('12345')).toThrow(BadRequestError);
    expect(() => validateOrderNo('ORD-abc-123')).toThrow(BadRequestError);
    expect(() => validateOrderNo('ORDER-1234-567')).toThrow(BadRequestError);
    expect(() => validateOrderNo('')).toThrow(BadRequestError);
    expect(() => validateOrderNo('ORD-123')).toThrow(BadRequestError);
  });

  it('should generate valid order numbers matching regex', () => {
    for (let i = 0; i < 10; i++) {
      const generated = generateOrderNo();
      expect(ORDER_NO_REGEX.test(generated)).toBe(true);
      expect(() => validateOrderNo(generated)).not.toThrow();
    }
  });
});
