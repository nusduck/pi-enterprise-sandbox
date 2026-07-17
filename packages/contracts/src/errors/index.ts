export {
  ERROR_CODE_CATEGORIES,
  ERROR_CODE_PATTERN,
  KNOWN_ERROR_CODES,
  errorCodeCategory,
  isErrorCodeCategory,
  isErrorCodeFormat,
  isKnownErrorCode,
  isValidErrorCode,
} from './codes.ts';

export type {
  ErrorCode,
  ErrorCodeCategory,
  KnownErrorCode,
} from './codes.ts';

export {
  parseErrorResponse,
  isErrorResponse,
  makeErrorResponse,
} from './response.ts';

export type {
  ErrorBody,
  ErrorResponse,
  ParseErrorResponseOutcome,
} from './response.ts';
