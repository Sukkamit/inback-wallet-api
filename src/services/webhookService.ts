import crypto from 'crypto';
import { OrderRepository } from '../repositories/orderRepository';
import { TimelineRepository } from '../repositories/timelineRepository';
import { WebhookRepository } from '../repositories/webhookRepository';
import { withTransaction } from '../db/connection';
import { OrderStatus, ActorType } from '../domain/types';
import { OrderStateMachine } from '../domain/stateMachine';
import { NotFoundError, UnauthorizedError, BadRequestError } from '../domain/errors';
import { validateOrderNo } from '../utils/orderNoValidator';
import { createOrderLogger } from '../utils/logger';

export interface BankWebhookPayload {
  eventId: string;
  orderNo: string;
  amount: number;
  paymentStatus: 'SUCCESS' | 'FAILED';
  transactionTime: string;
}

export class WebhookService {
  constructor(
    private orderRepo: OrderRepository = new OrderRepository(),
    private timelineRepo: TimelineRepository = new TimelineRepository(),
    private webhookRepo: WebhookRepository = new WebhookRepository()
  ) {}

  public verifySignature(rawBody: string, signature: string, secret: string = 'bank_webhook_secret_key'): boolean {
    if (!signature) return false;
    const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
  }

  // Case 3: Handle bank webhooks (duplicate, delayed, out-of-order)
  public async handleBankWebhook(
    payload: BankWebhookPayload,
    signature?: string,
    rawBodyString?: string
  ): Promise<{ status: string; message: string; orderNo: string }> {
    const { eventId, orderNo, amount, paymentStatus } = payload;
    validateOrderNo(orderNo);
    const logger = createOrderLogger(orderNo);
    logger.info(`Received bank webhook event '${eventId}'`, { paymentStatus, amount });

    // 1. Signature Verification (if secret configured or signature provided)
    const webhookSecret = process.env.BANK_WEBHOOK_SECRET || 'bank_webhook_secret_key';
    if (signature && rawBodyString) {
      const isValid = this.verifySignature(rawBodyString, signature, webhookSecret);
      if (!isValid) {
        logger.error(`Bank webhook signature verification failed for event '${eventId}'`);
        throw new UnauthorizedError('Invalid webhook signature');
      }
    }

    // 2. Idempotency Check: Was event_id already processed?
    const alreadyProcessed = await this.webhookRepo.isEventProcessed(eventId);
    if (alreadyProcessed) {
      logger.info(`Webhook event '${eventId}' has already been processed. Returning idempotent response.`);
      return {
        status: 'IDEMPOTENT_IGNORED',
        message: 'Webhook event was already processed previously.',
        orderNo,
      };
    }

    return withTransaction(async (client) => {
      const order = await this.orderRepo.findByOrderNoForUpdate(orderNo, client);
      if (!order) {
        throw new NotFoundError(`Order '${orderNo}' not found`, orderNo);
      }

      // Check amount matching
      if (Math.abs(order.amount - amount) > 0.01) {
        if (amount < order.amount && order.status === OrderStatus.PENDING_PAYMENT) {
          logger.warn(`Underpayment received: expected ${order.amount}, received ${amount}. Moving to DELAYED`);
          
          OrderStateMachine.assertTransition(order.status, OrderStatus.DELAYED, orderNo);
          await this.orderRepo.updateStatus(
            orderNo,
            OrderStatus.DELAYED,
            {
              failure_reason: `UNDERPAYMENT: Expected ${order.amount} THB, received ${amount} THB (Short by ${(order.amount - amount).toFixed(2)} THB)`,
            },
            client
          );

          await this.timelineRepo.record(
            {
              order_id: order.id,
              order_no: orderNo,
              from_status: OrderStatus.PENDING_PAYMENT,
              to_status: OrderStatus.DELAYED,
              actor_type: ActorType.BANK_WEBHOOK,
              actor_id: 'BANK_WEBHOOK',
              action: 'UNDERPAYMENT_DETECTED',
              reason: `Customer underpaid: Expected ${order.amount} THB, received ${amount} THB. Order moved to DELAYED waiting for supplementary payment.`,
              metadata: { expectedAmount: order.amount, receivedAmount: amount, difference: order.amount - amount, eventId },
            },
            client
          );

          await this.webhookRepo.recordEvent(
            {
              event_id: eventId,
              provider: 'BANK',
              order_no: orderNo,
              payload: payload as unknown as Record<string, unknown>,
              status: 'UNDERPAID_DELAYED',
            },
            client
          );

          return {
            status: 'UNDERPAYMENT_DELAYED',
            message: `Underpayment detected (received ${amount}/${order.amount}). Order marked as DELAYED.`,
            orderNo,
          };
        }

        logger.warn(`Webhook payment amount mismatch. Expected: ${order.amount}, got: ${amount}`);
        throw new BadRequestError(
          `Payment amount mismatch: expected ${order.amount}, received ${amount}`,
          orderNo
        );
      }

      // 3. State Check & Handling
      if (order.status === OrderStatus.PENDING_PAYMENT) {
        if (paymentStatus === 'SUCCESS') {
          // Check if payment arrived AFTER order payment expiration
          const now = new Date();
          if (now > order.payment_expires_at) {
            // Late payment! Order has timed out. Transition to REFUNDED automatically.
            logger.warn(`Payment arrived late after payment expiry time (${order.payment_expires_at.toISOString()}). Initiating auto-refund.`);
            
            OrderStateMachine.assertTransition(order.status, OrderStatus.EXPIRED, orderNo);
            await this.orderRepo.updateStatus(orderNo, OrderStatus.EXPIRED, {}, client);

            OrderStateMachine.assertTransition(OrderStatus.EXPIRED, OrderStatus.REFUNDED, orderNo);
            await this.orderRepo.updateStatus(
              orderNo,
              OrderStatus.REFUNDED,
              { failure_reason: 'LATE_PAYMENT_AUTO_REFUNDED' },
              client
            );

            await this.timelineRepo.record(
              {
                order_id: order.id,
                order_no: orderNo,
                from_status: OrderStatus.PENDING_PAYMENT,
                to_status: OrderStatus.REFUNDED,
                actor_type: ActorType.BANK_WEBHOOK,
                actor_id: 'BANK_SYSTEM',
                action: 'LATE_PAYMENT_REFUNDED',
                reason: 'Bank confirmed payment but QR/payment window had expired. Refund issued.',
                metadata: { eventId, expiredAt: order.payment_expires_at },
              },
              client
            );

            await this.webhookRepo.recordEvent(
              {
                event_id: eventId,
                provider: 'BANK',
                order_no: orderNo,
                payload: payload as unknown as Record<string, unknown>,
                status: 'EXPIRED_REFUNDED',
              },
              client
            );

            return {
              status: 'EXPIRED_REFUNDED',
              message: 'Payment received after expiration; order has been automatically refunded.',
              orderNo,
            };
          }

          // Normal timely payment: Transition to QUEUED
          OrderStateMachine.assertTransition(order.status, OrderStatus.QUEUED, orderNo);
          await this.orderRepo.updateStatus(
            orderNo,
            OrderStatus.QUEUED,
            { queued_at: new Date() },
            client
          );

          await this.timelineRepo.record(
            {
              order_id: order.id,
              order_no: orderNo,
              from_status: OrderStatus.PENDING_PAYMENT,
              to_status: OrderStatus.QUEUED,
              actor_type: ActorType.BANK_WEBHOOK,
              actor_id: 'BANK_SYSTEM',
              action: 'PAYMENT_CONFIRMED',
              reason: 'Bank payment confirmed via webhook. Order placed in queue for bot processing.',
              metadata: { eventId, amount },
            },
            client
          );

          await this.webhookRepo.recordEvent(
            {
              event_id: eventId,
              provider: 'BANK',
              order_no: orderNo,
              payload: payload as unknown as Record<string, unknown>,
              status: 'PROCESSED',
            },
            client
          );

          return {
            status: 'PROCESSED',
            message: 'Payment confirmed; order transitioned to QUEUED.',
            orderNo,
          };
        } else {
          // Payment failed at bank
          await this.timelineRepo.record(
            {
              order_id: order.id,
              order_no: orderNo,
              from_status: order.status,
              to_status: order.status,
              actor_type: ActorType.BANK_WEBHOOK,
              actor_id: 'BANK_SYSTEM',
              action: 'PAYMENT_FAILED_AT_BANK',
              reason: 'Bank reported transaction failure.',
              metadata: { eventId },
            },
            client
          );

          await this.webhookRepo.recordEvent(
            {
              event_id: eventId,
              provider: 'BANK',
              order_no: orderNo,
              payload: payload as unknown as Record<string, unknown>,
              status: 'FAILED',
            },
            client
          );

          return {
            status: 'PAYMENT_FAILED',
            message: 'Bank reported transaction failed.',
            orderNo,
          };
        }
      }

      // If order is already EXPIRED when webhook arrives
      if (order.status === OrderStatus.EXPIRED) {
        if (paymentStatus === 'SUCCESS') {
          OrderStateMachine.assertTransition(OrderStatus.EXPIRED, OrderStatus.REFUNDED, orderNo);
          await this.orderRepo.updateStatus(
            orderNo,
            OrderStatus.REFUNDED,
            { failure_reason: 'PAYMENT_ARRIVED_AFTER_EXPIRED_REFUNDED' },
            client
          );

          await this.timelineRepo.record(
            {
              order_id: order.id,
              order_no: orderNo,
              from_status: OrderStatus.EXPIRED,
              to_status: OrderStatus.REFUNDED,
              actor_type: ActorType.BANK_WEBHOOK,
              actor_id: 'BANK_SYSTEM',
              action: 'EXPIRED_ORDER_REFUNDED',
              reason: 'Payment arrived after order had already expired. Automatically converted to refund.',
              metadata: { eventId },
            },
            client
          );

          await this.webhookRepo.recordEvent(
            {
              event_id: eventId,
              provider: 'BANK',
              order_no: orderNo,
              payload: payload as unknown as Record<string, unknown>,
              status: 'EXPIRED_REFUNDED',
            },
            client
          );

          return {
            status: 'EXPIRED_REFUNDED',
            message: 'Payment received on expired order. Order marked for refund.',
            orderNo,
          };
        }
      }

      // If order is already in QUEUED, IN_PROGRESS, or COMPLETED: Duplicate webhook or delayed message
      await this.webhookRepo.recordEvent(
        {
          event_id: eventId,
          provider: 'BANK',
          order_no: orderNo,
          payload: payload as unknown as Record<string, unknown>,
          status: 'IGNORED_DUPLICATE',
        },
        client
      );

      return {
        status: 'IGNORED_DUPLICATE',
        message: `Order is already in state '${order.status}'. Webhook state transition ignored.`,
        orderNo,
      };
    });
  }
}
