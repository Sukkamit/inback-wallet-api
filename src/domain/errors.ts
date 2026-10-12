export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly orderNo?: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, orderNo?: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.orderNo = orderNo;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, orderNo?: string, details?: unknown) {
    super(400, 'BAD_REQUEST', message, orderNo, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, orderNo?: string) {
    super(404, 'NOT_FOUND', message, orderNo);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, orderNo?: string) {
    super(409, 'CONFLICT', message, orderNo);
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(fromStatus: string, toStatus: string, orderNo?: string) {
    super(
      422,
      'INVALID_STATE_TRANSITION',
      `Cannot transition order from status '${fromStatus}' to '${toStatus}'`,
      orderNo
    );
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error', orderNo?: string) {
    super(500, 'INTERNAL_SERVER_ERROR', message, orderNo);
  }
}
