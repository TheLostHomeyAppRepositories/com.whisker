'use strict';

/**
 * Custom exception hierarchy for the Whisker app.
 * Provides structured error handling with specific exception types for different failure scenarios,
 * enabling better error categorization and debugging throughout the application.
 */

/**
 * Base exception class for all Whisker-specific errors.
 * Establishes consistent error structure with optional cause chaining for debugging.
 */
class WhiskerException extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

/**
 * Authentication-related exception base class.
 * Covers general authentication failures like missing credentials or initialization errors.
 */
class WhiskerAuthenticationException extends WhiskerException {
  constructor(message = 'Authentication failed', cause = null) {
    super(message, cause);
  }
}

/**
 * Login-specific exception for credential validation and authentication flow failures.
 * Handles cases like invalid credentials, MFA requirements, and password change requests.
 */
class WhiskerLoginException extends WhiskerAuthenticationException {
  constructor(message = 'Login failed - check credentials', cause = null) {
    super(message, cause);
  }
}

/**
 * Token-related exception for JWT validation, parsing, and refresh failures.
 * Covers expired tokens, malformed tokens, and missing token components.
 */
class WhiskerTokenException extends WhiskerAuthenticationException {
  constructor(message = 'Token validation failed', cause = null) {
    super(message, cause);
  }
}

/**
 * API request exception for HTTP and GraphQL communication failures.
 * Includes HTTP status codes for proper error categorization and retry logic.
 */
class WhiskerApiException extends WhiskerException {
  constructor(message = 'API request failed', statusCode = null, cause = null) {
    super(message, cause);
    this.statusCode = statusCode;
  }
}

module.exports = {
  WhiskerException,
  WhiskerAuthenticationException,
  WhiskerLoginException,
  WhiskerTokenException,
  WhiskerApiException,
}; 