import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { WebhookService } from '../services/webhookService';
import { BadRequestError } from '../domain/errors';

const bankWebhookSchema = z.object({
  eventId: z.string().optional(),
  event_id: z.string().optional(),
  event: z.string().optional(),
  orderNo: z.string().optional(),
  order_no: z.string().optional(),
  amount: z.number().positive('amount must be greater than 0'),
  paymentStatus: z.enum(['SUCCESS', 'FAILED']).optional(),
  payment_status: z.enum(['SUCCESS', 'FAILED']).optional(),
  transactionTime: z.string().optional(),
  transaction_time: z.string().optional(),
  transRef: z.string().optional(),
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

      const eventId = parsed.data.eventId || parsed.data.event_id || parsed.data.transRef || `EVT-${Date.now()}`;
      const orderNo = (parsed.data.orderNo || parsed.data.order_no) as string;
      if (!orderNo) {
        throw new BadRequestError('orderNo is required');
      }
      const paymentStatus = (parsed.data.paymentStatus || parsed.data.payment_status || 'SUCCESS') as 'SUCCESS' | 'FAILED';
      const transactionTime = parsed.data.transactionTime || parsed.data.transaction_time || new Date().toISOString();

      const normalizedPayload = {
        eventId,
        orderNo,
        amount: parsed.data.amount,
        paymentStatus,
        transactionTime,
      };

      const signature = req.headers['x-signature'] as string | undefined;
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);

      const result = await this.webhookService.handleBankWebhook(normalizedPayload, signature, rawBody);

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };
}
