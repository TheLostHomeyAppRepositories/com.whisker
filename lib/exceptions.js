'use strict';

/**
 * Custom exception classes for the Whisker app.
 * Following the pylitterbot pattern for clean error handling.
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

class WhiskerInvalidCommandException extends WhiskerException {
  constructor(message = 'Invalid command sent to device', cause = null) {
    super(message, cause);
  }
}

class WhiskerDeviceException extends WhiskerException {
  constructor(message = 'Device operation failed', cause = null) {
    super(message, cause);
  }
}

class WhiskerWebSocketException extends WhiskerException {
  constructor(message = 'WebSocket operation failed', cause = null) {
    super(message, cause);
  }
}

module.exports = {
  WhiskerException,
  WhiskerAuthenticationException,
  WhiskerLoginException,
  WhiskerTokenException,
  WhiskerApiException,
  WhiskerInvalidCommandException,
  WhiskerDeviceException,
  WhiskerWebSocketException,
}; 