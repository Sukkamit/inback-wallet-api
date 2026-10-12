import { OrderRepository } from '../repositories/orderRepository';
import { TimelineRepository } from '../repositories/timelineRepository';
import { withTransaction } from '../db/connection';
import { Order, OrderStatus, ActorType, FailureType } from '../domain/types';
import { OrderStateMachine } from '../domain/stateMachine';
import { ConflictError, NotFoundError, BadRequestError } from '../domain/errors';
import { validateOrderNo } from '../utils/orderNoValidator';
import { createOrderLogger } from '../utils/logger';

export class BotService {
  constructor(
    private orderRepo: OrderRepository = new OrderRepository(),
    private timelineRepo: TimelineRepository = new TimelineRepository()
  ) {}

  // Case 2: Atomic Claim Order to prevent race condition between multiple bots
  public async claimOrder(
    orderNo: string,
    botId: string,
    leaseSeconds: number = 60
  ): Promise<Order> {
    validateOrderNo(orderNo);
    const logger = createOrderLogger(orderNo);
    logger.info(`Bot '${botId}' attempting to claim order`, { botId, leaseSeconds });

    const claimedOrder = await withTransaction(async (client) => {
      // 1. Atomic claim with SELECT FOR UPDATE SKIP LOCKED + UNIQUE bot_executions record
      let order: Order | null = null;
      try {
        order = await this.orderRepo.claimOrderAtomic(orderNo, botId, leaseSeconds, client);
      } catch (err: any) {
        // Handle PostgreSQL unique constraint violation (code 23505)
        if (err.code === '23505') {
          throw new ConflictError(
            `Order '${orderNo}' has already been claimed or executed by another bot`,
            orderNo
          );
        }
        throw err;
      }

      if (!order) {
        // Either order is not in QUEUED state, or is locked by another transaction
        const existing = await this.orderRepo.findByOrderNo(orderNo);
        if (!existing) {
          throw new NotFoundError(`Order '${orderNo}' not found`, orderNo);
        }
        throw new ConflictError(
          `Unable to claim order '${orderNo}'. Current status: '${existing.status}' (already claimed or in progress)`,
          orderNo
        );
      }

      // Record timeline
      await this.timelineRepo.record(
        {
          order_id: order.id,
          order_no: order.order_no,
          from_status: OrderStatus.QUEUED,
          to_status: OrderStatus.IN_PROGRESS,
          actor_type: ActorType.BOT,
          actor_id: botId,
          action: 'ORDER_CLAIMED',
          reason: `Bot '${botId}' acquired lease for ${leaseSeconds} seconds`,
          metadata: {
            botId,
            leaseSeconds,
            leaseExpiresAt: order.lease_expires_at,
          },
        },
        client
      );

      return order;
    });

    logger.info(`Bot '${botId}' successfully claimed order`, { leaseExpiresAt: claimedOrder.lease_expires_at });
    return claimedOrder;
  }

  // Case 1: Bot Heartbeat to renew lease
  public async sendHeartbeat(
    orderNo: string,
    botId: string,
    leaseExtensionSeconds: number = 60
  ): Promise<Order> {
    validateOrderNo(orderNo);
    const logger = createOrderLogger(orderNo);
    logger.debug(`Bot '${botId}' heartbeat received`, { leaseExtensionSeconds });

    const updated = await this.orderRepo.updateHeartbeat(orderNo, botId, leaseExtensionSeconds);
    if (!updated) {
      const order = await this.orderRepo.findByOrderNo(orderNo);
      if (!order) {
        throw new NotFoundError(`Order '${orderNo}' not found`, orderNo);
      }
      throw new BadRequestError(
        `Heartbeat rejected: order is not in IN_PROGRESS state assigned to bot '${botId}' (current status: ${order.status}, assigned bot: ${order.assigned_bot_id})`,
        orderNo
      );
    }

    return updated;
  }

  // Complete Order
  public async completeOrder(
    orderNo: string,
    botId: string,
    externalTransactionId?: string
  ): Promise<Order> {
    validateOrderNo(orderNo);
    const logger = createOrderLogger(orderNo);
    logger.info(`Bot '${botId}' completing order`, { externalTransactionId });

    return withTransaction(async (client) => {
      const order = await this.orderRepo.findByOrderNoForUpdate(orderNo, client);
      if (!order) {
        throw new NotFoundError(`Order '${orderNo}' not found`, orderNo);
      }

      if (order.status !== OrderStatus.IN_PROGRESS || order.assigned_bot_id !== botId) {
        throw new BadRequestError(
          `Cannot complete order '${orderNo}'. Current status is '${order.status}', assigned to '${order.assigned_bot_id}'`,
          orderNo
        );
      }

      OrderStateMachine.assertTransition(order.status, OrderStatus.COMPLETED, orderNo);

      const completed = await this.orderRepo.updateStatus(
        orderNo,
        OrderStatus.COMPLETED,
        {
          lease_expires_at: null,
        },
        client
      );

      await this.timelineRepo.record(
        {
          order_id: order.id,
          order_no: orderNo,
          from_status: OrderStatus.IN_PROGRESS,
          to_status: OrderStatus.COMPLETED,
          actor_type: ActorType.BOT,
          actor_id: botId,
          action: 'TOPUP_COMPLETED',
          reason: 'Game top-up completed successfully',
          metadata: { externalTransactionId, botId },
        },
        client
      );

      return completed!;
    });
  }

  // Case 4: Report failure with Transient vs Permanent categorization
  public async reportFailure(
    orderNo: string,
    botId: string,
    failureType: FailureType,
    reason: string
  ): Promise<Order> {
    validateOrderNo(orderNo);
    const logger = createOrderLogger(orderNo);
    logger.warn(`Bot '${botId}' reported failure: [${failureType}] ${reason}`);

    return withTransaction(async (client) => {
      const order = await this.orderRepo.findByOrderNoForUpdate(orderNo, client);
      if (!order) {
        throw new NotFoundError(`Order '${orderNo}' not found`, orderNo);
      }

      if (order.status !== OrderStatus.IN_PROGRESS) {
        throw new BadRequestError(
          `Cannot report failure on order with status '${order.status}'`,
          orderNo
        );
      }

      // Permanent failure (e.g. Invalid UID, Account Banned)
      if (failureType === FailureType.PERMANENT) {
        OrderStateMachine.assertTransition(order.status, OrderStatus.FAILED, orderNo);

        const failed = await this.orderRepo.updateStatus(
          orderNo,
          OrderStatus.FAILED,
          {
            assigned_bot_id: null,
            lease_expires_at: null,
            failure_reason: reason,
            failure_type: FailureType.PERMANENT,
          },
          client
        );

        await this.timelineRepo.record(
          {
            order_id: order.id,
            order_no: orderNo,
            from_status: OrderStatus.IN_PROGRESS,
            to_status: OrderStatus.FAILED,
            actor_type: ActorType.BOT,
            actor_id: botId,
            action: 'PERMANENT_FAILURE',
            reason: `Permanent error encountered: ${reason}. Please update UID or contact support.`,
            metadata: { failureType, reason, botId },
          },
          client
        );

        return failed!;
      }

      // Transient failure (e.g. Provider 503, network timeout)
      const nextRetry = order.retry_count + 1;
      if (nextRetry <= order.max_retries) {
        // Backoff and re-queue
        OrderStateMachine.assertTransition(order.status, OrderStatus.QUEUED, orderNo);

        const requeued = await this.orderRepo.updateStatus(
          orderNo,
          OrderStatus.QUEUED,
          {
            assigned_bot_id: null,
            lease_expires_at: null,
            retry_count: nextRetry,
            failure_reason: `Transient retry (${nextRetry}/${order.max_retries}): ${reason}`,
            failure_type: FailureType.TRANSIENT,
            queued_at: new Date(),
          },
          client
        );

        // Calculate exponential backoff delay for logging/info
        const backoffSeconds = Math.pow(2, nextRetry) * 5;

        await this.timelineRepo.record(
          {
            order_id: order.id,
            order_no: orderNo,
            from_status: OrderStatus.IN_PROGRESS,
            to_status: OrderStatus.QUEUED,
            actor_type: ActorType.BOT,
            actor_id: botId,
            action: 'TRANSIENT_RETRY',
            reason: `Transient error: ${reason}. Re-queued for retry ${nextRetry}/${order.max_retries} with ${backoffSeconds}s backoff`,
            metadata: {
              failureType,
              retryCount: nextRetry,
              maxRetries: order.max_retries,
              backoffSeconds,
            },
          },
          client
        );

        return requeued!;
      } else {
        // Retries exhausted -> Transition to DELAYED and flag for admin
        OrderStateMachine.assertTransition(order.status, OrderStatus.DELAYED, orderNo);

        const delayed = await this.orderRepo.updateStatus(
          orderNo,
          OrderStatus.DELAYED,
          {
            assigned_bot_id: null,
            lease_expires_at: null,
            failure_reason: `Max retries exceeded (${order.max_retries}): ${reason}`,
            failure_type: FailureType.TRANSIENT,
          },
          client
        );

        await this.timelineRepo.record(
          {
            order_id: order.id,
            order_no: orderNo,
            from_status: OrderStatus.IN_PROGRESS,
            to_status: OrderStatus.DELAYED,
            actor_type: ActorType.BOT,
            actor_id: botId,
            action: 'MAX_RETRIES_EXCEEDED',
            reason: `All ${order.max_retries} retries exhausted due to provider transient errors. Flagged for admin inspection.`,
            metadata: { failureType, retriesExhausted: true, reason },
          },
          client
        );

        return delayed!;
      }
    });
  }
}
