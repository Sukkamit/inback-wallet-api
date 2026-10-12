import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BotService } from '../services/botService';
import { FailureType } from '../domain/types';
import { BadRequestError } from '../domain/errors';

const claimSchema = z.object({
  bot_id: z.string().optional(),
  botId: z.string().optional(),
  lease_seconds: z.number().int().positive().optional().default(60),
});

const heartbeatSchema = z.object({
  bot_id: z.string().optional(),
  botId: z.string().optional(),
  lease_extension_seconds: z.number().int().positive().optional().default(60),
});

const completeSchema = z.object({
  bot_id: z.string().optional(),
  botId: z.string().optional(),
  external_transaction_id: z.string().optional(),
  externalTransactionId: z.string().optional(),
});

const failSchema = z.object({
  bot_id: z.string().optional(),
  botId: z.string().optional(),
  failure_type: z.enum([FailureType.TRANSIENT, FailureType.PERMANENT]).optional().default(FailureType.PERMANENT),
  failureType: z.enum([FailureType.TRANSIENT, FailureType.PERMANENT]).optional(),
  reason: z.string().optional(),
  errorMessage: z.string().optional(),
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

      const botId = parsed.data.bot_id || parsed.data.botId || 'BOT-DEFAULT';
      const order = await this.botService.claimOrder(
        orderNo,
        botId,
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

      const botId = parsed.data.bot_id || parsed.data.botId || 'BOT-DEFAULT';
      const order = await this.botService.sendHeartbeat(
        orderNo,
        botId,
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

      const botId = parsed.data.bot_id || parsed.data.botId || 'BOT-DEFAULT';
      const extTxId = parsed.data.external_transaction_id || parsed.data.externalTransactionId;
      const order = await this.botService.completeOrder(
        orderNo,
        botId,
        extTxId
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

      const botId = parsed.data.bot_id || parsed.data.botId || 'BOT-DEFAULT';
      const failureType = (parsed.data.failure_type || parsed.data.failureType || FailureType.PERMANENT) as FailureType;
      const reason = parsed.data.reason || parsed.data.errorMessage || 'Unknown bot failure';

      const order = await this.botService.reportFailure(
        orderNo,
        botId,
        failureType,
        reason
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
