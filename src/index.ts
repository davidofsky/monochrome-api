import { startServer } from './server';
import { logger } from './logger';

startServer().catch((err) => {
  logger.fatal({ err }, 'failed to start server');
  process.exit(1);
});
