import type { FastifyServerOptions } from 'fastify';

export function makeLoggerOptions(opts: { level?: string; isDev?: boolean } = {}): FastifyServerOptions['logger'] {
  const level = opts.level ?? process.env['LOG_LEVEL'] ?? 'info';
  const isDev = opts.isDev ?? process.env['NODE_ENV'] !== 'production';

  return {
    level,
    base: { service: 'router', phase: 2 },
    redact: {
      paths: [
        // Inbound request headers (Fastify's default req serializer includes these)
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["proxy-authorization"]',
        // Body fields that might carry an apiKey (defensive — Phase 2 doesn't accept them
        // in any route, but a future route might; redact-by-default beats redact-by-remembering)
        '*.apiKey',
        '*.api_key',
        // Top-level forms (when an err object is logged with a `headers` field at the root)
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[REDACTED]',
      // Do NOT use `remove: true` — leaving '[REDACTED]' in the log proves the redaction is
      // active (vs. the field never being present, which is ambiguous evidence). The SC5
      // grep test specifically asserts ZERO matches for "bearer|authorization" string content.
    },
    // Dev pretty-print — guarded by NODE_ENV so prod stays JSON
    ...(isDev
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  };
}

export const loggerOptions: FastifyServerOptions['logger'] = makeLoggerOptions();
