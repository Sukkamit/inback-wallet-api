import express, { Express, Request, Response } from 'express';
import path from 'path';
import { OrderController } from './controllers/orderController';
import { BotController } from './controllers/botController';
import { WebhookController } from './controllers/webhookController';
import { AdminController } from './controllers/adminController';
import { errorHandler } from './middlewares/errorHandler';
import { requestLogger } from './middlewares/requestLogger';

export function createApp(): Express {
  const app = express();

  // Middleware to capture rawBody for signature verification
  app.use(
    express.json({
      verify: (req: Request, _res: Response, buf: Buffer) => {
        (req as any).rawBody = buf.toString();
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir));

  // Live Interactive Demo UI
  app.get('/demo', (_req: Request, res: Response) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'UP',
      service: 'Order Tracking & Issue Management API',
      timestamp: new Date().toISOString(),
    });
  });

  // API Root overview
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'Game Top-up Order Tracking API',
      version: '1.0.0',
      description: 'Order Tracking API and Issue Management for Game Top-up Bot System',
      demoDashboard: '/demo',
      endpoints: {
        orders: {
          create: 'POST /orders',
          getOne: 'GET /orders/:orderNo',
          list: 'GET /orders?tab=current|history&page=1&limit=10',
          timeline: 'GET /orders/:orderNo/timeline',
          reportIssue: 'POST /orders/:orderNo/report-issue',
          updateTarget: 'PATCH /orders/:orderNo/update-target',
          refund: 'POST /orders/:orderNo/refund',
        },
        bots: {
          claim: 'POST /bots/orders/:orderNo/claim',
          heartbeat: 'POST /bots/orders/:orderNo/heartbeat',
          complete: 'POST /bots/orders/:orderNo/complete',
          fail: 'POST /bots/orders/:orderNo/fail',
        },
        webhooks: {
          bank: 'POST /webhooks/bank',
        },
        admin: {
          triggerRecovery: 'POST /admin/jobs/trigger-recovery',
        },
      },
    });
  });

  // Controllers
  const orderController = new OrderController();
  const botController = new BotController();
  const webhookController = new WebhookController();
  const adminController = new AdminController();

  // Order Endpoints (Part 1)
  app.post('/orders', orderController.createOrder);
  app.get('/orders', orderController.getOrders);
  app.get('/orders/:orderNo', orderController.getOrderByOrderNo);
  app.get('/orders/:orderNo/timeline', orderController.getTimeline);
  app.post('/orders/:orderNo/report-issue', orderController.reportIssue);
  app.patch('/orders/:orderNo/update-target', orderController.updateTarget);
  app.post('/orders/:orderNo/refund', orderController.refund);

  // Bot Endpoints (Part 2 - Cases 1, 2, 4)
  app.post('/bots/orders/:orderNo/claim', botController.claimOrder);
  app.post('/bots/orders/:orderNo/heartbeat', botController.sendHeartbeat);
  app.post('/bots/orders/:orderNo/complete', botController.completeOrder);
  app.post('/bots/orders/:orderNo/fail', botController.reportFailure);

  // Webhook Endpoints (Part 2 - Case 3)
  app.post('/webhooks/bank', webhookController.handleBankWebhook);

  // Admin / System Endpoints (Part 2 - Case 5)
  app.post('/admin/jobs/trigger-recovery', adminController.triggerRecovery);

  // Fallback 404 handler for unknown routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      code: 'ROUTE_NOT_FOUND',
      message: `Endpoint ${req.method} ${req.path} not found.`,
    });
  });

  // Global Error Handler
  app.use(errorHandler);

  return app;
}
