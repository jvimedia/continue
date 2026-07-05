/**
 * Minimal timestamped logger. Kept dependency-free on purpose - this is a
 * small reference bot, not production infra.
 */
function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(message: string, ...rest: unknown[]): void {
    console.log(`[${timestamp()}] [info] ${message}`, ...rest);
  },
  warn(message: string, ...rest: unknown[]): void {
    console.warn(`[${timestamp()}] [warn] ${message}`, ...rest);
  },
  error(message: string, ...rest: unknown[]): void {
    console.error(`[${timestamp()}] [error] ${message}`, ...rest);
  },
};
