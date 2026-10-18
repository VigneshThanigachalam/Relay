import type { ErrorRequestHandler, Request, Response } from 'express';

export function sendError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
) {
  return res.status(status).json({ error: { code, message }, requestId: res.locals.requestId });
}

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const type =
    typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
  if (type === 'entity.parse.failed') {
    sendError(req, res, 400, 'INVALID_JSON', 'Request body must be valid JSON');
    return;
  }
  if (type === 'entity.too.large') {
    sendError(req, res, 413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 64 KiB');
    return;
  }
  // Structured logging and domain error mapping will accompany business modules.
  console.error('Unhandled request error', { requestId: res.locals.requestId });
  sendError(req, res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
};
