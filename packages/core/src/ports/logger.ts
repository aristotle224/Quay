// Minimal logger port. Adapters accept `Logger | undefined` (no-op default
// when missing) so they keep working in tests and unobservability-sensitive
// contexts. Apps inject a pino-backed implementation.
//
// Pino's full surface is huge; this interface only covers what's actually
// used across the codebase: child loggers (for binding requestId / linkId /
// jobId) and the four standard levels with the same overload flexibility
// pino offers (string msg, or `{...obj, msg?}`, or both).

export interface Logger {
  /** Return a child logger with the given bindings always included on every line. */
  child(bindings: Record<string, unknown>): Logger;

  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** A logger that drops every call on the floor. Use when no logger is supplied. */
export const NOOP_LOGGER: Logger = {
  child: () => NOOP_LOGGER,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};
