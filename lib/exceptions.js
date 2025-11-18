/**
 * Custom exception hierarchy for the Whisker app.
 * Defines exception types to enable error categorization and cause chaining.
 */

/**
 * Base exception class for all Whisker-specific errors.
 * Supports cause chaining to preserve error context through exception propagation.
 */
class WhiskerException extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

/**
 * Base class for authentication-related exceptions.
 * Separates authentication failures from API communication errors for distinct error handling.
 */
class WhiskerAuthenticationException extends WhiskerException {
  constructor(message = 'Authentication failed', cause = null) {
    super(message, cause);
  }
}

/**
 * Exception for login and credential validation failures.
 * Distinguishes login-specific errors from other authentication issues (e.g., token expiration).
 */
class WhiskerLoginException extends WhiskerAuthenticationException {
  constructor(message = 'Login failed - check credentials', cause = null) {
    super(message, cause);
  }
}

/**
 * Exception for JWT token validation, parsing, and refresh failures.
 * Separates token-related errors from login failures to enable different recovery strategies.
 */
class WhiskerTokenException extends WhiskerAuthenticationException {
  constructor(message = 'Token validation failed', cause = null) {
    super(message, cause);
  }
}

/**
 * Exception for HTTP and GraphQL API communication failures.
 * Includes statusCode to enable status-based retry logic and error handling.
 */
class WhiskerApiException extends WhiskerException {
  constructor(message = 'API request failed', statusCode = null, cause = null) {
    super(message, cause);
    this.statusCode = statusCode;
  }
}

/**
 * Maps AWS Cognito error codes to user-friendly error messages.
 * Cognito errors are technical and need translation for end users.
 * @param {Error} err - The Cognito error object
 * @returns {string} User-friendly error message
 */
function getCognitoErrorMessage(err) {
  const errorCode = err.code || err.name;
  const defaultMessage = err.message || 'Authentication failed';

  const errorMessages = {
    UserNotFoundException: 'User account not found. Please check your email address or create an account.',
    NotAuthorizedException: 'Incorrect username or password. Please check your credentials.',
    UserNotConfirmedException: 'Account not confirmed. Please verify your email address.',
  };

  return errorMessages[errorCode] || defaultMessage;
}

/**
 * Determines if a Cognito error should be logged as a warning rather than an error.
 * Some errors (e.g., UserNotFoundException) are expected during normal operation and should not trigger error-level logging.
 * @param {Error} err - The Cognito error object
 * @returns {boolean} True if the error should be logged as a warning
 */
function isCognitoWarningError(err) {
  const errorCode = err.code || err.name;
  const warningErrors = ['UserNotFoundException', 'NotAuthorizedException', 'UserNotConfirmedException'];
  return warningErrors.includes(errorCode);
}

module.exports = {
  WhiskerException,
  WhiskerAuthenticationException,
  WhiskerLoginException,
  WhiskerTokenException,
  WhiskerApiException,
  getCognitoErrorMessage,
  isCognitoWarningError,
};
