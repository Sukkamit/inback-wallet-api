import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { WebhookService } from '../services/webhookService';
import { BadRequestError } from '../domain/errors';

const bankWebhookSchema = z.object({
  eventId: z.string().min(1, 'eventId is required'),
  orderNo: z.string().min(1, 'orderNo is required'),
  amount: z.number().positive('amount must be greater than 0'),
  paymentStatus: z.enum(['SUCCESS', 'FAILED']),
  transactionTime: z.string().min(1, 'transactionTime is required'),
});

export class WebhookController {
  constructor(private webhookService: WebhookService = new WebhookService()) {}

  // POST /webhooks/bank (Case 3)
  public handleBankWebhook = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = bankWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new BadRequestError('Validation error', req.body?.orderNo, parsed.error.issues);
      }

      const signature = req.headers['x-signature'] as string | undefined;
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);

      const result = await this.webhookService.handleBankWebhook(parsed.data, signature, rawBody);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };
}
