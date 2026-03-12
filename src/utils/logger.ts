import winston from "winston";
import { config } from "../config";

// Winston logger with two different formats:
// Development: colorized, human-readable single line
// Production: JSON — machine-parseable, works with log aggregators (Datadog, CloudWatch)


const devFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({format : 'HH:mm:ss'}),
    winston.format.printf(({level , message ,timestamp, ...meta}) => {
        // meta = any extra fields you pass: logger.info('msg', { userId: 123 })
    const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
    })
);

const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }), // include stack traces on errors
  winston.format.json()                   // output as JSON object
);

export const logger = winston.createLogger({
  level: config.server.isDev ? 'debug' : 'info',
  // debug: most verbose, logs everything
  // info: normal operation events
  // warn: something unexpected but not broken
  // error: something broken

  format: config.server.isDev ? devFormat : prodFormat,

  transports: [
    new winston.transports.Console(),
    // In production you'd add: new winston.transports.File({ filename: 'error.log', level: 'error' })
  ],
});
