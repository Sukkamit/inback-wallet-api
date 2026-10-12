import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app';
import { runMigrations } from './db/migrate';
import { JobScheduler } from './jobs/scheduler';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
  try {
    // Run database migrations on startup
    await runMigrations();

    const app = createApp();

    // Start background recovery scheduler
    const scheduler = new JobScheduler();
    scheduler.start();

    const server = app.listen(PORT, () => {
      logger.info(`🚀 Order Tracking API is running on http://localhost:${PORT}`);
    });

    const shutdown = () => {
      logger.info('Shutting down gracefully...');
      scheduler.stop();
      server.close(() => {
        logger.info('HTTP server closed.');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    logger.error('Failed to start server', { error: (error as Error).message });
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}
