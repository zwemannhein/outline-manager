/**
 * Structured logging utility using Pino
 */

import pino from "pino";

const isDevelopment = process.env.NODE_ENV === "development";

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),
  // Disable pino-pretty in development to avoid webpack issues
  // Use simple JSON output instead
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    env: process.env.NODE_ENV,
  },
});

// Create child loggers for different modules
export const createLogger = (module: string) => logger.child({ module });
