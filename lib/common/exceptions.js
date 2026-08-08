/* eslint-disable max-classes-per-file */
/**
 * Custom exception hierarchy for the Whisker app.
 * Enables error categorization and cause chaining across session, API, and WebSocket layers.
 */

class WhiskerException extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

class WhiskerAuthenticationException extends WhiskerException {
  constructor(message = 'Authentication failed', cause = null) {
    super(message, cause);
  }
}

class WhiskerLoginException extends WhiskerAuthenticationException {
  constructor(message = 'Login failed - check credentials', cause = null) {
    super(message, cause);
  }
}

class WhiskerTokenException extends WhiskerAuthenticationException {
  constructor(message = 'Token validation failed', cause = null) {
    super(message, cause);
  }
}

class WhiskerApiException extends WhiskerException {
  constructor(message = 'API request failed', statusCode = null, cause = null) {
    super(message, cause);
    this.statusCode = statusCode;
  }
}

class WhiskerNetworkException extends WhiskerException {
  constructor(cause = null) {
    super('Network unreachable', cause);
  }
}

module.exports = {
  WhiskerException,
  WhiskerAuthenticationException,
  WhiskerLoginException,
  WhiskerTokenException,
  WhiskerApiException,
  WhiskerNetworkException,
};
