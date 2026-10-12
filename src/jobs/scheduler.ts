import { RecoveryService } from '../services/recoveryService';
import { logger } from '../utils/logger';

export class JobScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private intervalMs: number;

  constructor(
    private recoveryService: RecoveryService = new RecoveryService(),
    intervalMs: number = 10000 // Run every 10 seconds by default
  ) {
    this.intervalMs = intervalMs;
  }

  public start(): void {
    if (this.timer) return;
    logger.info(`Starting background recovery scheduler (interval: ${this.intervalMs}ms)...`);
    this.timer = setInterval(() => this.runJobs(), this.intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Background recovery scheduler stopped.');
    }
  }

  public async runJobs(): Promise<{
    expiredLeases: number;
    expiredPayments: number;
    slaViolations: number;
  }> {
    if (this.isRunning) {
      logger.debug('Previous scheduler cycle still running. Skipping iteration.');
      return { expiredLeases: 0, expiredPayments: 0, slaViolations: 0 };
    }

    this.isRunning = true;
    try {
      // 1. Check for dead/crashed bots (Case 1)
      const expiredLeases = await this.recoveryService.handleExpiredBotLeases();

      // 2. Check for expired QR / unpaid orders (Case 5)
      const expiredPayments = await this.recoveryService.expireUnpaidOrders();

      // 3. Check for orders stuck in QUEUED exceeding SLA (Case 5)
      const slaMinutes = parseInt(process.env.QUEUE_SLA_MINUTES || '10', 10);
      const slaViolations = await this.recoveryService.checkQueueSlaViolations(slaMinutes);

      return { expiredLeases, expiredPayments, slaViolations };
    } catch (err: any) {
      logger.error('Error during scheduled recovery cycle', { error: err.message });
      return { expiredLeases: 0, expiredPayments: 0, slaViolations: 0 };
    } finally {
      this.isRunning = false;
    }
  }
}
