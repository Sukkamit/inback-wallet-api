import { Request, Response, NextFunction } from 'express';
import { RecoveryService } from '../services/recoveryService';

export class AdminController {
  constructor(private recoveryService: RecoveryService = new RecoveryService()) {}

  // POST /admin/jobs/trigger-recovery
  public triggerRecovery = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const slaMinutes = req.body?.slaMinutes ? parseInt(req.body.slaMinutes, 10) : 10;

      const expiredLeases = await this.recoveryService.handleExpiredBotLeases();
      const expiredPayments = await this.recoveryService.expireUnpaidOrders();
      const slaViolations = await this.recoveryService.checkQueueSlaViolations(slaMinutes);

      res.status(200).json({
        success: true,
        message: 'Recovery job cycle executed',
        results: {
          expiredLeasesRecovered: expiredLeases,
          unpaidOrdersExpired: expiredPayments,
          queueSlaViolationsDelayed: slaViolations,
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
