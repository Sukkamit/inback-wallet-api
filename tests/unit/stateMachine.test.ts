import { OrderStateMachine } from '../../src/domain/stateMachine';
import { OrderStatus } from '../../src/domain/types';
import { InvalidStateTransitionError } from '../../src/domain/errors';

describe('OrderStateMachine', () => {
  it('should allow valid normal flow transitions', () => {
    expect(OrderStateMachine.canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.QUEUED)).toBe(true);
    expect(OrderStateMachine.canTransition(OrderStatus.QUEUED, OrderStatus.IN_PROGRESS)).toBe(true);
    expect(OrderStateMachine.canTransition(OrderStatus.IN_PROGRESS, OrderStatus.COMPLETED)).toBe(true);
  });

  it('should allow problem state transitions', () => {
    // Payment expiry
    expect(OrderStateMachine.canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.EXPIRED)).toBe(true);
    // Queue SLA breach or report issue
    expect(OrderStateMachine.canTransition(OrderStatus.QUEUED, OrderStatus.DELAYED)).toBe(true);
    // Bot retry
    expect(OrderStateMachine.canTransition(OrderStatus.IN_PROGRESS, OrderStatus.QUEUED)).toBe(true);
    // Permanent failure
    expect(OrderStateMachine.canTransition(OrderStatus.IN_PROGRESS, OrderStatus.FAILED)).toBe(true);
    // Retrying after failure (UID update)
    expect(OrderStateMachine.canTransition(OrderStatus.FAILED, OrderStatus.QUEUED)).toBe(true);
    // Refund
    expect(OrderStateMachine.canTransition(OrderStatus.FAILED, OrderStatus.REFUNDED)).toBe(true);
    expect(OrderStateMachine.canTransition(OrderStatus.DELAYED, OrderStatus.REFUNDED)).toBe(true);
  });

  it('should disallow invalid transitions', () => {
    // Cannot jump from PENDING_PAYMENT to COMPLETED directly
    expect(OrderStateMachine.canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.COMPLETED)).toBe(false);
    // Cannot transition out of COMPLETED
    expect(OrderStateMachine.canTransition(OrderStatus.COMPLETED, OrderStatus.QUEUED)).toBe(false);
    expect(OrderStateMachine.canTransition(OrderStatus.COMPLETED, OrderStatus.REFUNDED)).toBe(false);
    // Cannot transition out of REFUNDED
    expect(OrderStateMachine.canTransition(OrderStatus.REFUNDED, OrderStatus.IN_PROGRESS)).toBe(false);

    expect(() => {
      OrderStateMachine.assertTransition(OrderStatus.COMPLETED, OrderStatus.IN_PROGRESS, 'ORD-123-456');
    }).toThrow(InvalidStateTransitionError);
  });

  it('should correctly filter current vs history tabs', () => {
    expect(OrderStateMachine.isCurrentTab(OrderStatus.PENDING_PAYMENT)).toBe(true);
    expect(OrderStateMachine.isCurrentTab(OrderStatus.QUEUED)).toBe(true);
    expect(OrderStateMachine.isCurrentTab(OrderStatus.IN_PROGRESS)).toBe(true);
    expect(OrderStateMachine.isCurrentTab(OrderStatus.DELAYED)).toBe(true);

    expect(OrderStateMachine.isCurrentTab(OrderStatus.COMPLETED)).toBe(false);
    expect(OrderStateMachine.isCurrentTab(OrderStatus.FAILED)).toBe(false);

    expect(OrderStateMachine.isHistoryTab(OrderStatus.COMPLETED)).toBe(true);
    expect(OrderStateMachine.isHistoryTab(OrderStatus.FAILED)).toBe(true);
    expect(OrderStateMachine.isHistoryTab(OrderStatus.EXPIRED)).toBe(true);
    expect(OrderStateMachine.isHistoryTab(OrderStatus.REFUNDED)).toBe(true);
  });
});
