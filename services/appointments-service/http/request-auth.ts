import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

// The caller's Authorization header, available to the HTTP adapters for the rest of
// the request without threading it through every service function. The adapters
// forward it, so clinics-service and users-service check the same token (RF17).

const storage = new AsyncLocalStorage<{ authorization: string | undefined }>();

export const captureAuthorization: RequestHandler = (req, _res, next) => {
  storage.run({ authorization: req.get('authorization') }, next);
};

/** The Authorization header of the request being served, if any. */
export function currentAuthorization(): string | undefined {
  return storage.getStore()?.authorization;
}
