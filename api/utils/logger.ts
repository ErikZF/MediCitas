// Only pass application-controlled messages. Never include request data or raw errors.
export const logger = {
  info(message: string): void {
    console.info(JSON.stringify({ level: 'info', message, timestamp: new Date().toISOString() }));
  },
  error(message: string): void {
    console.error(JSON.stringify({ level: 'error', message, timestamp: new Date().toISOString() }));
  },
};
