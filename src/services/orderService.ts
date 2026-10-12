import { OrderRepository } from '../repositories/orderRepository';
import { TimelineRepository } from '../repositories/timelineRepository';
import { IssueRepository } from '../repositories/issueRepository';
import { IdempotencyRepository } from '../repositories/idempotencyRepository';
import { withTransaction } from '../db/connection';
import {
  CreateOrderDTO,
  Order,
  OrderStatus,
  ActorType,
  OrderTimeline,
  OrderIssue,
  PaginationParams,
} from '../domain/types';
import { OrderStateMachine } from '../domain/stateMachine';
import { NotFoundError, BadRequestError } from '../domain/errors';
import { validateOrderNo, generateOrderNo } from '../utils/orderNoValidator';
import { createOrderLogger } from '../utils/logger';

export class OrderService {
  constructor(
    private orderRepo: OrderRepository = new OrderRepository(),
    private timelineRepo: TimelineRepository = new TimelineRepository(),
    private issueRepo: IssueRepository = new IssueRepository(),
    private idempotencyRepo: IdempotencyRepository = new IdempotencyRepository()
  ) {}

  public async createOrder(dto: CreateOrderDTO, idempotencyKey?: string): Promise<Order> {
    if (idempotencyKey) {
      const cached = await this.idempotencyRepo.get(idempotencyKey);
      if (cached) {
        return cached.response_body as unknown as Order;
      }
    }

    const orderNo = generateOrderNo();
    const logger = createOrderLogger(orderNo);
    logger.info('Creating new order', { customerId: dto.customer_id, amount: dto.amount });

    // Payment expires in 15 minutes by default
    const paymentExpiryMinutes = parseInt(process.env.PAYMENT_EXPIRY_MINUTES || '15', 10);
    const paymentExpiresAt = new Date(Date.now() + paymentExpiryMinutes * 60 * 1000);

    const createdOrder = await withTransaction(async (client) => {
      const order = await this.orderRepo.create(
        {
          order_no: orderNo,
          customer_id: dto.customer_id,
          game_id: dto.game_id,
          package_id: dto.package_id,
          uid: dto.uid,
          server_id: dto.server_id,
          amount: dto.amount,
          status: OrderStatus.PENDING_PAYMENT,
          payment_expires_at: paymentExpiresAt,
          version: 1,
        },
        client
      );

      await this.timelineRepo.record(
        {
          order_id: order.id,
          order_no: order.order_no,
          from_status: null,
          to_status: OrderStatus.PENDING_PAYMENT,
          actor_type: ActorType.CUSTOMER,
          actor_id: dto.customer_id,
          action: 'ORDER_CREATED',
          reason: 'Customer initiated top-up order',
          metadata: {
            game_id: dto.game_id,
            package_id: dto.package_id,
            amount: dto.amount,
            uid: dto.uid,
          },
        },
        client
      );

      return order;
    });

    if (idempotencyKey) {
      await this.idempotencyRepo.save({
        key: idempotencyKey,
        resource_type: 'ORDER_CREATE',
        response_status: 201,
        response_body: createdOrder as unknown as Record<string, unknown>,
      });
    }

    return createdOrder;
  }

  public async getOrderByOrderNo(orderNo: string): Promise<Order> {
    validateOrderNo(orderNo);
    const order = await this.orderRepo.findByOrderNo(orderNo);
    if (!order) {
      throw new NotFoundError(`Order with number '${orderNo}' not found`, orderNo);
    }
    return order;
  }

  public async getOrders(params: PaginationParams) {
    return this.orderRepo.findPaginated(params);
  }

  public async getOrderTimeline(orderNo: string): Promise<OrderTimeline[]> {
    validateOrderNo(orderNo);
    const order = await this.orderRepo.findByOrderNo(orderNo);
    if (!order) {
      throw new NotFoundError(`Order with number '${orderNo}' not found`, orderNo);
    }
    return this.timelineRepo.findByOrderNo(orderNo);
  }

  public async reportIssue(
    orderNo: string,
    reportedBy: string,
    category: string,
    details: string
  ): Promise<{ issue: OrderIssue; order: Order }> {
    validateOrderNo(orderNo);
    const logger = createOrderLogger(orderNo);
    logger.warn('Customer reported issue', { category, details, reportedBy });

    return withTransaction(async (client) => {
      const order = await this.orderRepo.findByOrderNoForUpdate(orderNo, client);
      if (!order) {
        throw new NotFoundError(`Order with number '${orderNo}' not found`, orderNo);
      }

      const issue = await this.issueRepo.create(
        {
          order_no: orderNo,
          reported_by: reportedBy,
          category,
          details,
        },
        client
      );

      let updatedOrder = order;
      // If order is active (not already COMPLETED, REFUNDED, EXPIRED), move to DELAYED for investigation
      if (
        order.status !== OrderStatus.COMPLETED &&
        order.status !== OrderStatus.REFUNDED &&
        order.status !== OrderStatus.EXPIRED
      ) {
        OrderStateMachine.assertTransition(order.status, OrderStatus.DELAYED, orderNo);
        updatedOrder = (await this.orderRepo.updateStatus(
          orderNo,
          OrderStatus.DELAYED,
          {
            failure_reason: `CUSTOMER_ISSUE_REPORTED: ${details}`,
          },
          client
        ))!;

        await this.timelineRepo.record(
          {
            order_id: order.id,
            order_no: orderNo,
            from_status: order.status,
            to_status: OrderStatus.DELAYED,
            actor_type: ActorType.CUSTOMER,
            actor_id: reportedBy,
            action: 'ISSUE_REPORTED',
            reason: `Issue reported: [${category}] ${details}`,
            metadata: { issueId: issue.id, category, details },
          },
          client
        );
      } else {
        await this.timelineRepo.record(
          {
            order_id: order.id,
            order_no: orderNo,
            from_status: order.status,
            to_status: order.status,
            actor_type: ActorType.CUSTOMER,
            actor_id: reportedBy,
            action: 'ISSUE_NOTE_ADDED',
            reason: `Customer added issue note: [${category}] ${details}`,
            metadata: { issueId: issue.id, category, details },
          },
          client
        );
      }

      return { issue, order: updatedOrder };
    });
  }

  // Case 4: Correct UID and re-queue
  public async updateUidAndRetry(orderNo: string, newUid: string, actorId: string = 'CUSTOMER'): Promise<Order> {
    validateOrderNo(orderNo);
    if (!newUid || newUid.trim() === '') {
      throw new BadRequestError('New UID cannot be empty', orderNo);
    }

    const logger = createOrderLogger(orderNo);
    logger.info('Updating UID and re-queuing order', { oldUid: '***', newUid });

    return withTransaction(async (client) => {
      const order = await this.orderRepo.findByOrderNoForUpdate(orderNo, client);
      if (!order) {
        throw new NotFoundError(`Order with number '${orderNo}' not found`, orderNo);
      }

      if (order.status !== OrderStatus.FAILED && order.status !== OrderStatus.DELAYED) {
        throw new BadRequestError(
          `Can only update UID for orders in FAILED or DELAYED status (current: ${order.status})`,
          orderNo
        );
      }

      OrderStateMachine.assertTransition(order.status, OrderStatus.QUEUED, orderNo);

      const updated = await this.orderRepo.updateStatus(
        orderNo,
        OrderStatus.QUEUED,
        {
          uid: newUid,
          assigned_bot_id: null,
          lease_expires_at: null,
          failure_reason: null,
          failure_type: null,
          retry_count: 0, // Reset retries after customer correction
          queued_at: new Date(),
        },
        client
      );

      await this.timelineRepo.record(
        {
          order_id: order.id,
          order_no: orderNo,
          from_status: order.status,
          to_status: OrderStatus.QUEUED,
          actor_type: ActorType.CUSTOMER,
          actor_id: actorId,
          action: 'UID_UPDATED_REQUEUED',
          reason: `Customer updated UID to '${newUid}' and requeued order`,
          metadata: { previousUid: order.uid, newUid },
        },
        client
      );

      return updated!;
    });
  }

  // Refund order
  public async refundOrder(orderNo: string, reason: string, actorId: string = 'ADMIN'): Promise<Order> {
    validateOrderNo(orderNo);
    const logger = createOrderLogger(orderNo);
    logger.info('Processing order refund', { reason, actorId });

    return withTransaction(async (client) => {
      const order = await this.orderRepo.findByOrderNoForUpdate(orderNo, client);
      if (!order) {
        throw new NotFoundError(`Order with number '${orderNo}' not found`, orderNo);
      }

      OrderStateMachine.assertTransition(order.status, OrderStatus.REFUNDED, orderNo);

      const updated = await this.orderRepo.updateStatus(
        orderNo,
        OrderStatus.REFUNDED,
        {
          failure_reason: `REFUNDED: ${reason}`,
        },
        client
      );

      await this.timelineRepo.record(
        {
          order_id: order.id,
          order_no: orderNo,
          from_status: order.status,
          to_status: OrderStatus.REFUNDED,
          actor_type: ActorType.ADMIN,
          actor_id: actorId,
          action: 'REFUND_PROCESSED',
          reason,
        },
        client
      );

      return updated!;
    });
  }
}
