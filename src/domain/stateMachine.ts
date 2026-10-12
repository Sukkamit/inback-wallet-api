import { OrderStatus } from './types';
import { InvalidStateTransitionError } from './errors';

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.PENDING_PAYMENT]: [
    OrderStatus.QUEUED,
    OrderStatus.EXPIRED,
    OrderStatus.DELAYED,
  ],
  [OrderStatus.QUEUED]: [
    OrderStatus.IN_PROGRESS,
    OrderStatus.DELAYED,
  ],
  [OrderStatus.IN_PROGRESS]: [
    OrderStatus.COMPLETED,
    OrderStatus.QUEUED,      // Retry on transient failure or lease timeout
    OrderStatus.DELAYED,     // Retries exhausted or issue reported
    OrderStatus.FAILED,      // Permanent failure (e.g. invalid UID)
  ],
  [OrderStatus.DELAYED]: [
    OrderStatus.QUEUED,      // Manual retry or fixed UID
    OrderStatus.FAILED,      // Mark permanently failed
    OrderStatus.REFUNDED,    // Refund customer
  ],
  [OrderStatus.FAILED]: [
    OrderStatus.QUEUED,      // Customer corrected UID and retries
    OrderStatus.REFUNDED,    // Refund customer
  ],
  [OrderStatus.EXPIRED]: [
    OrderStatus.REFUNDED,    // Late payment arrived after expiration
  ],
  [OrderStatus.COMPLETED]: [], // Terminal state
  [OrderStatus.REFUNDED]: [],  // Terminal state
};

export class OrderStateMachine {
  public static canTransition(currentStatus: OrderStatus, nextStatus: OrderStatus): boolean {
    if (currentStatus === nextStatus) return true;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    return allowed.includes(nextStatus);
  }

  public static assertTransition(currentStatus: OrderStatus, nextStatus: OrderStatus, orderNo?: string): void {
    if (!this.canTransition(currentStatus, nextStatus)) {
      throw new InvalidStateTransitionError(currentStatus, nextStatus, orderNo);
    }
  }

  public static isCurrentTab(status: OrderStatus): boolean {
    return [
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.QUEUED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.DELAYED,
    ].includes(status);
  }

  public static isHistoryTab(status: OrderStatus): boolean {
    return [
      OrderStatus.COMPLETED,
      OrderStatus.FAILED,
      OrderStatus.EXPIRED,
      OrderStatus.REFUNDED,
    ].includes(status);
  }
}
