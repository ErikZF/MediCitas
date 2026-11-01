export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const portValue = env.API_INTERNAL_PORT;

  if (portValue === undefined) {
    throw new Error('API_INTERNAL_PORT is required.');
  }

  const port = Number(portValue);

  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_INTERNAL_PORT must be an integer between 1 and 65535.');
  }

  return { port };
}
