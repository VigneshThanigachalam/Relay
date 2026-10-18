import type { ErrorRequestHandler, Request, Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { ApiError, type ValidationDetail } from './api-error.js';
import { InvalidTransitionError } from '../modules/domain/lifecycle.js';

export function sendError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: ValidationDetail[],
) {
  return res.status(status).json({
    error: { code, message, ...(details ? { details } : {}) },
    requestId: res.locals.requestId,
  });
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
  if (error instanceof ApiError) {
    sendError(req, res, error.status, error.code, error.message, error.details);
    return;
  }
  if (error instanceof ZodError) {
    sendError(
      req,
      res,
      400,
      'VALIDATION_ERROR',
      'Invalid request',
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
    return;
  }
  if (error instanceof InvalidTransitionError) {
    sendError(req, res, 409, error.code, error.message);
    return;
  }
  const mongo = mongoose.mongo;
  const transient =
    error instanceof mongo.MongoServerError &&
    (error.hasErrorLabel('TransientTransactionError') ||
      error.hasErrorLabel('UnknownTransactionCommitResult') ||
      (typeof error.code === 'number' && [50, 91, 11600, 11602].includes(error.code)));
  if (
    transient ||
    error instanceof mongo.MongoNetworkError ||
    error instanceof mongo.MongoServerSelectionError ||
    error instanceof mongo.MongoOperationTimeoutError ||
    (error instanceof Error && error.name === 'MongooseServerSelectionError')
  ) {
    sendError(
      req,
      res,
      503,
      'DEPENDENCY_UNAVAILABLE',
      'Database operation could not complete; retry the same request',
    );
    return;
  }
  // Log a request ID, never an arbitrary database error containing credentials.
  console.error('Unhandled request error', { requestId: res.locals.requestId });
  sendError(req, res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
};
