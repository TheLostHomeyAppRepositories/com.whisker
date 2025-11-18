/**
 * Provides event constants and helper functions for structured event emission.
 * Ensures consistent event payloads and logging across components that use EventEmitter.
 */

const EventEmitter = require('events');
const { colorize, LOG_COLORS } = require('./utils');

/**
 * Standardized event type constants.
 * Prevents typos and ensures consistent event names across components.
 */
const EVENTS = {
  UPDATE: 'update',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
  AUTHENTICATION_FAILED: 'authentication_failed',
  DEVICE_ADDED: 'device_added',
  DEVICE_REMOVED: 'device_removed',
  DATA_RECEIVED: 'data_received',
  COMMAND_SENT: 'command_sent',
  COMMAND_FAILED: 'command_failed',
};

/**
 * Emits a structured data received event with consistent payload format.
 * Includes timestamp and source tracking to enable debugging and event correlation.
 * @param {EventEmitter} emitter - Event emitter instance
 * @param {string} deviceId - Device identifier
 * @param {Object} data - Data received
 * @param {string} source - Data source (e.g., 'websocket', 'api')
 * @param {Object} homey - Optional Homey instance for logging
 */
function emitDataReceived(emitter, deviceId, data, source = 'unknown', homey = null) {
  if (homey) {
    homey.log(`[EventEmitter] ${colorize(LOG_COLORS.INFO, `Data received for device ${deviceId} from ${source}`)}`);
  }
  emitter.emit(EVENTS.DATA_RECEIVED, {
    deviceId, data, source, timestamp: Date.now(),
  });
}

/**
 * Emits a structured connection event with consistent payload format.
 * Provides connection state tracking for monitoring and debugging purposes.
 * @param {EventEmitter} emitter - Event emitter instance
 * @param {string} deviceId - Device identifier
 * @param {Object} connectionInfo - Connection information
 * @param {Object} homey - Optional Homey instance for logging
 */
function emitConnected(emitter, deviceId, connectionInfo = {}, homey = null) {
  if (homey) {
    homey.log(`[EventEmitter] ${colorize(LOG_COLORS.SUCCESS, `Device ${deviceId} connected`)}`);
  }
  emitter.emit(EVENTS.CONNECTED, { deviceId, connectionInfo, timestamp: Date.now() });
}

/**
 * Emits a structured disconnection event with consistent payload format.
 * Captures disconnection reason for troubleshooting connection issues.
 * @param {EventEmitter} emitter - Event emitter instance
 * @param {string} deviceId - Device identifier
 * @param {string} reason - Disconnection reason
 * @param {Object} homey - Optional Homey instance for logging
 */
function emitDisconnected(emitter, deviceId, reason = 'unknown', homey = null) {
  if (homey) {
    homey.log(`[EventEmitter] ${colorize(LOG_COLORS.WARNING, `Device ${deviceId} disconnected: ${reason}`)}`);
  }
  emitter.emit(EVENTS.DISCONNECTED, { deviceId, reason, timestamp: Date.now() });
}

/**
 * Emits a structured error event with consistent payload format.
 * Includes error context to help identify where failures occur in the system.
 * @param {EventEmitter} emitter - Event emitter instance
 * @param {Error} error - Error object
 * @param {string} context - Error context
 * @param {Object} homey - Optional Homey instance for logging
 */
function emitError(emitter, error, context = 'unknown', homey = null) {
  if (homey) {
    homey.error(`[EventEmitter] ${colorize(LOG_COLORS.ERROR, `Error in ${context}:`)}`, error);
  }
  emitter.emit(EVENTS.ERROR, { error, context, timestamp: Date.now() });
}

module.exports = {
  EVENTS,
  EventEmitter,
  emitDataReceived,
  emitConnected,
  emitDisconnected,
  emitError,
};
