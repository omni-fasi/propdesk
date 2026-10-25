// Domain errors with a machine-readable code (ApiError.code) and the HTTP status the API maps them to.

export type ErrorCode =
  | 'invalid'
  | 'not_found'
  | 'account_closed'
  | 'locked'
  | 'market_closed'
  | 'no_price'
  | 'rule_violation'
  | 'insufficient_margin'
  | 'insufficient_funds'
  | 'stop_required'
  | 'busy'
  | 'conflict'
  | 'internal';

const STATUS: Record<ErrorCode, 400 | 404 | 409 | 500> = {
  invalid: 400,
  not_found: 404,
  account_closed: 409,
  locked: 400,
  market_closed: 400,
  no_price: 400,
  rule_violation: 400,
  insufficient_margin: 400,
  insufficient_funds: 400,
  stop_required: 400,
  busy: 409,
  conflict: 409,
  internal: 500,
};

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly status: 400 | 404 | 409 | 500;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = STATUS[code];
  }
}

/** Throw an EngineError (usable in expression position: `x ?? fail(...)`). */
export function fail(code: ErrorCode, message: string): never {
  throw new EngineError(code, message);
}

export function isEngineError(err: unknown): err is EngineError {
  return err instanceof EngineError;
}
