export type ValidationDetail = { path: string; message: string };

// Only explicit application errors may supply public messages. Arbitrary thrown
// database errors must never expose connection strings or internal stack traces.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ValidationDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
