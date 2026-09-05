import { pino } from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.LOG_LEVEL,
  // Pretty output in dev; structured JSON in production.
  ...(config.NODE_ENV === 'production'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
