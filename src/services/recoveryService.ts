import { OrderRepository } from '../repositories/orderRepository';
import { TimelineRepository } from '../repositories/timelineRepository';
import { withTransaction } from '../db/connection';
import { OrderStatus, ActorType, FailureType } from '../domain/types';
import { OrderStateMachine } from '../domain/stateMachine';
import { logger, createOrderLogger } from '../utils/logger';

export class RecoveryService {
  constructor(
    private orderRepo: OrderRepository = new OrderRepository(),
    private timelineRepo: TimelineRepository = new TimelineRepository()
  ) {}

  // Case 1: Detect crashed/silent bots whose lease has expired
  public async handleExpiredBotLeases(): Promise<number> {
    const expiredOrders = await this.orderRepo.findExpiredLeases();
    if (expiredOrders.length === 0) return 0;

    logger.info(`Found ${expiredOrders.length} orders with expired bot leases.`);

    let processedCount = 0;
    for (const order of expiredOrders) {
      const orderLogger = createOrderLogger(order.order_no);
      try {
        await withTransaction(async (client) => {
          const freshOrder = await this.orderRepo.findByOrderNoForUpdate(order.order_no, client);
          if (!freshOrder || freshOrder.status !== OrderStatus.IN_PROGRESS) return;
          if (!freshOrder.lease_expires_at || freshOrder.lease_expires_at > new Date()) return;

          const nextRetry = freshOrder.retry_count + 1;
          const assignedBot = freshOrder.assigned_bot_id || 'UNKNOWN_BOT';

          if (nextRetry <= freshOrder.max_retries) {
            // Exponential backoff retry: Re-queue
            OrderStateMachine.assertTransition(freshOrder.status, OrderStatus.QUEUED, freshOrder.order_no);

            await this.orderRepo.updateStatus(
              freshOrder.order_no,
              OrderStatus.QUEUED,
              {
                assigned_bot_id: null,
                lease_expires_at: null,
                retry_count: nextRetry,
                failure_reason: `Bot lease expired without heartbeat. Requeued (${nextRetry}/${freshOrder.max_retries}).`,
                failure_type: FailureType.TRANSIENT,
                queued_at: new Date(),
              },
              client
            );

            await this.timelineRepo.record(
              {
                order_id: freshOrder.id,
                order_no: freshOrder.order_no,
                from_status: OrderStatus.IN_PROGRESS,
                to_status: OrderStatus.QUEUED,
                actor_type: ActorType.SYSTEM_SCHEDULER,
                actor_id: 'LEASE_MONITOR',
                action: 'LEASE_EXPIRED_REQUEUED',
                reason: `Bot '${assignedBot}' stopped reporting heartbeat. Lease expired. Order returned to queue (retry ${nextRetry}/${freshOrder.max_retries}).`,
                metadata: {
                  assignedBot,
                  retryCount: nextRetry,
                  maxRetries: freshOrder.max_retries,
                },
              },
              client
            );

            orderLogger.warn(`Bot '${assignedBot}' lease expired. Order requeued for retry ${nextRetry}/${freshOrder.max_retries}.`);
          } else {
            // Max retries exceeded: Move to DELAYED and trigger admin alert
            OrderStateMachine.assertTransition(freshOrder.status, OrderStatus.DELAYED, freshOrder.order_no);

            await this.orderRepo.updateStatus(
              freshOrder.order_no,
              OrderStatus.DELAYED,
              {
                assigned_bot_id: null,
                lease_expires_at: null,
                failure_reason: `Bot lease expired and max retries (${freshOrder.max_retries}) reached. Escalated to admin.`,
                failure_type: FailureType.TRANSIENT,
              },
              client
            );

            await this.timelineRepo.record(
              {
                order_id: freshOrder.id,
                order_no: freshOrder.order_no,
                from_status: OrderStatus.IN_PROGRESS,
                to_status: OrderStatus.DELAYED,
                actor_type: ActorType.SYSTEM_SCHEDULER,
                actor_id: 'LEASE_MONITOR',
                action: 'LEASE_EXPIRED_ESCALATED',
                reason: `Bot crashed repeatedly. Retries exceeded limit (${freshOrder.max_retries}). Status changed to DELAYED. Alert generated for admin.`,
                metadata: {
                  assignedBot,
                  retriesExhausted: true,
                  alertLevel: 'HIGH',
                },
              },
              client
            );

            orderLogger.error(`CRITICAL: Order exceeded max retries after bot silence. Moved to DELAYED for admin intervention.`);
          }
          processedCount++;
        });
      } catch (err: any) {
        orderLogger.error('Failed to process expired lease for order', { error: err.message });
      }
    }

    return processedCount;
  }

  // Case 5: Expire unpaid orders (QR / payment timeout)
  public async expireUnpaidOrders(): Promise<number> {
    const expiredOrders = await this.orderRepo.findExpiredPayments();
    if (expiredOrders.length === 0) return 0;

    logger.info(`Found ${expiredOrders.length} unpaid orders past payment deadline.`);

    let processedCount = 0;
    for (const order of expiredOrders) {
      const orderLogger = createOrderLogger(order.order_no);
      try {
        await withTransaction(async (client) => {
          const freshOrder = await this.orderRepo.findByOrderNoForUpdate(order.order_no, client);
          if (!freshOrder || freshOrder.status !== OrderStatus.PENDING_PAYMENT) return;
          if (freshOrder.payment_expires_at > new Date()) return;

          OrderStateMachine.assertTransition(freshOrder.status, OrderStatus.EXPIRED, freshOrder.order_no);

          await this.orderRepo.updateStatus(
            freshOrder.order_no,
            OrderStatus.EXPIRED,
            { failure_reason: 'PAYMENT_WINDOW_EXPIRED' },
            client
          );

          await this.timelineRepo.record(
            {
              order_id: freshOrder.id,
              order_no: freshOrder.order_no,
              from_status: OrderStatus.PENDING_PAYMENT,
              to_status: OrderStatus.EXPIRED,
              actor_type: ActorType.SYSTEM_SCHEDULER,
              actor_id: 'PAYMENT_EXPIRY_CRON',
              action: 'ORDER_EXPIRED',
              reason: 'Payment was not completed within the allowed time limit (QR expired).',
              metadata: { expiredAt: freshOrder.payment_expires_at },
            },
            client
          );

          orderLogger.info('Unpaid order expired automatically.');
          processedCount++;
        });
      } catch (err: any) {
        orderLogger.error('Failed to expire unpaid order', { error: err.message });
      }
    }

    return processedCount;
  }

  // Case 5: Alert on QUEUED orders exceeding SLA wait time
  public async checkQueueSlaViolations(slaMinutes: number = 10): Promise<number> {
    const overdueOrders = await this.orderRepo.findExceededSlaQueued(slaMinutes);
    if (overdueOrders.length === 0) return 0;

    logger.warn(`Found ${overdueOrders.length} orders in queue exceeding SLA of ${slaMinutes} minutes.`);

    let processedCount = 0;
    for (const order of overdueOrders) {
      const orderLogger = createOrderLogger(order.order_no);
      try {
        await withTransaction(async (client) => {
          const freshOrder = await this.orderRepo.findByOrderNoForUpdate(order.order_no, client);
          if (!freshOrder || freshOrder.status !== OrderStatus.QUEUED) return;

          OrderStateMachine.assertTransition(freshOrder.status, OrderStatus.DELAYED, freshOrder.order_no);

          await this.orderRepo.updateStatus(
            freshOrder.order_no,
            OrderStatus.DELAYED,
            { failure_reason: `QUEUE_SLA_EXCEEDED: Waiting in queue > ${slaMinutes} mins` },
            client
          );

          await this.timelineRepo.record(
            {
              order_id: freshOrder.id,
              order_no: freshOrder.order_no,
              from_status: OrderStatus.QUEUED,
              to_status: OrderStatus.DELAYED,
              actor_type: ActorType.SYSTEM_SCHEDULER,
              actor_id: 'SLA_WATCHDOG',
              action: 'QUEUE_SLA_VIOLATION_DELAYED',
              reason: `Order queued for longer than SLA (${slaMinutes} minutes). Moved to DELAYED and admin alerted.`,
              metadata: { slaMinutes, queuedAt: freshOrder.queued_at },
            },
            client
          );

          orderLogger.warn(`Order exceeded queue SLA (${slaMinutes}m). Moved to DELAYED.`);
          processedCount++;
        });
      } catch (err: any) {
        orderLogger.error('Failed to process SLA violation for order', { error: err.message });
      }
    }

    return processedCount;
  }
}
