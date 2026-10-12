import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BotService } from '../services/botService';
import { FailureType } from '../domain/types';
import { BadRequestError } from '../domain/errors';

const claimSchema = z.object({
  bot_id: z.string().min(1, 'bot_id is required'),
  lease_seconds: z.number().int().positive().optional().default(60),
});

const heartbeatSchema = z.object({
  bot_id: z.string().min(1, 'bot_id is required'),
  lease_extension_seconds: z.number().int().positive().optional().default(60),
});

const completeSchema = z.object({
  bot_id: z.string().min(1, 'bot_id is required'),
  external_transaction_id: z.string().optional(),
});

const failSchema = z.object({
  bot_id: z.string().min(1, 'bot_id is required'),
  failure_type: z.enum([FailureType.TRANSIENT, FailureType.PERMANENT]),
  reason: z.string().min(1, 'reason is required'),
});

export class BotController {
  constructor(private botService: BotService = new BotService()) {}

  // POST /bots/orders/:orderNo/claim (Case 2)
  public claimOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const parsed = claimSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', orderNo, parsed.error.issues);
      }

      const order = await this.botService.claimOrder(
        orderNo,
        parsed.data.bot_id,
        parsed.data.lease_seconds
      );

      res.status(200).json({
        success: true,
        message: 'Order successfully claimed',
        data: order,
      });
    } catch (err) {
      next(err);
    }
  };

  // POST /bots/orders/:orderNo/heartbeat (Case 1)
  public sendHeartbeat = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const parsed = heartbeatSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', orderNo, parsed.error.issues);
      }

      const order = await this.botService.sendHeartbeat(
        orderNo,
        parsed.data.bot_id,
        parsed.data.lease_extension_seconds
      );

      res.status(200).json({
        success: true,
        message: 'Heartbeat acknowledged. Lease extended.',
        data: order,
      });
    } catch (err) {
      next(err);
    }
  };

  // POST /bots/orders/:orderNo/complete
  public completeOrder = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', orderNo, parsed.error.issues);
      }

      const order = await this.botService.completeOrder(
        orderNo,
        parsed.data.bot_id,
        parsed.data.external_transaction_id
      );

      res.status(200).json({
        success: true,
        message: 'Order completed successfully',
        data: order,
      });
    } catch (err) {
      next(err);
    }
  };

  // POST /bots/orders/:orderNo/fail (Case 4)
  public reportFailure = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const orderNo = req.params.orderNo as string;
      const parsed = failSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', orderNo, parsed.error.issues);
      }

      const order = await this.botService.reportFailure(
        orderNo,
        parsed.data.bot_id,
        parsed.data.failure_type as FailureType,
        parsed.data.reason
      );

      res.status(200).json({
        success: true,
        message: 'Failure reported and processed',
        data: order,
      });
    } catch (err) {
      next(err);
    }
  };
}
