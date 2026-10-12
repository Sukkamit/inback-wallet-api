import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { OrderService } from '../services/orderService';
import { BadRequestError } from '../domain/errors';

const createOrderSchema = z.object({
  customer_id: z.string().min(1, 'customer_id is required'),
  game_id: z.string().min(1, 'game_id is required'),
  package_id: z.string().min(1, 'package_id is required'),
  uid: z.string().min(1, 'uid is required'),
  server_id: z.string().optional(),
  amount: z.number().positive('amount must be greater than 0'),
});

const reportIssueSchema = z.object({
  reported_by: z.string().min(1, 'reported_by is required'),
  category: z.string().min(1, 'category is required'),
  details: z.string().min(1, 'details is required'),
});

const updateTargetSchema = z.object({
  uid: z.string().min(1, 'uid is required'),
});

const refundOrderSchema = z.object({
  reason: z.string().min(1, 'reason is required'),
});

export class OrderController {
  constructor(private orderService: OrderService = new OrderService()) {}

  // POST /orders
  public createOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', undefined, parsed.error.issues);
      }

      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const order = await this.orderService.createOrder(parsed.data, idempotencyKey);

      res.status(201).json({
        success: true,
        data: order,
      });
    } catch (err) {
      next(err);
    }
  };

  // GET /orders/:orderNo
  public getOrderByOrderNo = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const order = await this.orderService.getOrderByOrderNo(orderNo);

      res.status(200).json({
        success: true,
        data: order,
      });
    } catch (err) {
      next(err);
    }
  };

  // GET /orders?tab=current|history&page=1&limit=10
  public getOrders = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tab = req.query.tab as 'current' | 'history' | undefined;
      if (tab && !['current', 'history'].includes(tab)) {
        throw new BadRequestError(`Invalid tab value '${tab}'. Must be 'current' or 'history'.`);
      }

      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;

      const result = await this.orderService.getOrders({ tab, page, limit });

      res.status(200).json({
        success: true,
        data: result.data,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  // GET /orders/:orderNo/timeline
  public getTimeline = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const timeline = await this.orderService.getOrderTimeline(orderNo);

      res.status(200).json({
        success: true,
        orderNo,
        data: timeline,
      });
    } catch (err) {
      next(err);
    }
  };

  // POST /orders/:orderNo/report-issue
  public reportIssue = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const parsed = reportIssueSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', orderNo, parsed.error.issues);
      }

      const result = await this.orderService.reportIssue(
        orderNo,
        parsed.data.reported_by,
        parsed.data.category,
        parsed.data.details
      );

      res.status(200).json({
        success: true,
        message: 'Issue reported successfully',
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  // PATCH /orders/:orderNo/update-target (Case 4: Update UID & Retry)
  public updateTarget = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const parsed = updateTargetSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', orderNo, parsed.error.issues);
      }

      const updated = await this.orderService.updateUidAndRetry(orderNo, parsed.data.uid);

      res.status(200).json({
        success: true,
        message: 'UID updated and order requeued for processing',
        data: updated,
      });
    } catch (err) {
      next(err);
    }
  };

  // POST /orders/:orderNo/refund
  public refund = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const parsed = refundOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', orderNo, parsed.error.issues);
      }

      const refunded = await this.orderService.refundOrder(orderNo, parsed.data.reason);

      res.status(200).json({
        success: true,
        message: 'Order refunded successfully',
        data: refunded,
      });
    } catch (err) {
      next(err);
    }
  };
}
