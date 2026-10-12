import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { OrderService } from '../services/orderService';
import { BadRequestError } from '../domain/errors';

const createOrderSchema = z.object({
  customer_id: z.string().optional(),
  customerId: z.string().optional(),
  customerEmail: z.string().optional(),
  game_id: z.string().optional(),
  gameId: z.string().optional(),
  gameCode: z.string().optional(),
  package_id: z.string().optional(),
  packageId: z.string().optional(),
  itemName: z.string().optional(),
  uid: z.string().optional(),
  targetUid: z.string().optional(),
  server_id: z.string().optional(),
  serverId: z.string().optional(),
  targetServer: z.string().optional(),
  amount: z.number().positive('amount must be greater than 0').optional(),
  price: z.number().positive('price must be greater than 0').optional(),
});

const reportIssueSchema = z.object({
  reported_by: z.string().optional(),
  reportedBy: z.string().optional(),
  category: z.string().min(1, 'category is required'),
  details: z.string().min(1, 'details is required'),
});

const updateTargetSchema = z.object({
  uid: z.string().optional(),
  targetUid: z.string().optional(),
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

      const normalizedData = {
        customer_id: parsed.data.customer_id || parsed.data.customerId || parsed.data.customerEmail || 'CUST-001',
        game_id: parsed.data.game_id || parsed.data.gameId || parsed.data.gameCode || 'ROV',
        package_id: parsed.data.package_id || parsed.data.packageId || parsed.data.itemName || 'ITEM-01',
        uid: parsed.data.uid || parsed.data.targetUid || 'UID-12345',
        server_id: parsed.data.server_id || parsed.data.serverId || parsed.data.targetServer || 'Server-1',
        amount: parsed.data.amount ?? parsed.data.price ?? 100,
      };

      const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
      const order = await this.orderService.createOrder(normalizedData, idempotencyKey);

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

      const reporter = parsed.data.reported_by || parsed.data.reportedBy || 'CUSTOMER';
      const result = await this.orderService.reportIssue(
        orderNo,
        reporter,
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

      const targetUid = parsed.data.uid || parsed.data.targetUid || '';
      const updated = await this.orderService.updateUidAndRetry(orderNo, targetUid);

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
