'use strict';

/**
 * Simple event system for the Whisker app.
 * Following the pylitterbot pattern for event handling.
 */

const EventEmitter = require('events');

// Event constants (following pylitterbot pattern)
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
 * WhiskerEventEmitter extends Node.js EventEmitter with Whisker-specific functionality.
 * Provides a centralized event system for the app.
 */
class WhiskerEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); // Allow unlimited listeners for flexibility
  }

  /**
   * Emit an update event with device data.
   * @param {string} deviceId - The device identifier
   * @param {Object} data - The updated data
   */
  emitUpdate(deviceId, data) {
    this.emit(EVENTS.UPDATE, { deviceId, data, timestamp: Date.now() });
  }

  /**
   * Emit a connection event.
   * @param {string} deviceId - The device identifier
   * @param {Object} connectionInfo - Connection information
   */
  emitConnected(deviceId, connectionInfo = {}) {
    this.emit(EVENTS.CONNECTED, { deviceId, connectionInfo, timestamp: Date.now() });
  }

  /**
   * Emit a disconnection event.
   * @param {string} deviceId - The device identifier
   * @param {string} reason - Reason for disconnection
   */
  emitDisconnected(deviceId, reason = 'unknown') {
    this.emit(EVENTS.DISCONNECTED, { deviceId, reason, timestamp: Date.now() });
  }

  /**
   * Emit an error event.
   * @param {Error} error - The error object
   * @param {string} context - Error context
   */
  emitError(error, context = 'unknown') {
    this.emit(EVENTS.ERROR, { error, context, timestamp: Date.now() });
  }

  /**
   * Emit an authentication failure event.
   * @param {Error} error - The authentication error
   */
  emitAuthenticationFailed(error) {
    this.emit(EVENTS.AUTHENTICATION_FAILED, { error, timestamp: Date.now() });
  }

  /**
   * Emit a device added event.
   * @param {string} deviceId - The device identifier
   * @param {Object} deviceInfo - Device information
   */
  emitDeviceAdded(deviceId, deviceInfo = {}) {
    this.emit(EVENTS.DEVICE_ADDED, { deviceId, deviceInfo, timestamp: Date.now() });
  }

  /**
   * Emit a device removed event.
   * @param {string} deviceId - The device identifier
   */
  emitDeviceRemoved(deviceId) {
    this.emit(EVENTS.DEVICE_REMOVED, { deviceId, timestamp: Date.now() });
  }

  /**
   * Emit a data received event.
   * @param {string} deviceId - The device identifier
   * @param {Object} data - The received data
   * @param {string} source - Data source (websocket, polling, etc.)
   */
  emitDataReceived(deviceId, data, source = 'unknown') {
    this.emit(EVENTS.DATA_RECEIVED, { deviceId, data, source, timestamp: Date.now() });
  }

  /**
   * Emit a command sent event.
   * @param {string} deviceId - The device identifier
   * @param {string} command - The command sent
   * @param {Object} parameters - Command parameters
   */
  emitCommandSent(deviceId, command, parameters = {}) {
    this.emit(EVENTS.COMMAND_SENT, { deviceId, command, parameters, timestamp: Date.now() });
  }

  /**
   * Emit a command failed event.
   * @param {string} deviceId - The device identifier
   * @param {string} command - The command that failed
   * @param {Error} error - The error
   */
  emitCommandFailed(deviceId, command, error) {
    this.emit(EVENTS.COMMAND_FAILED, { deviceId, command, error, timestamp: Date.now() });
  }
}

module.exports = {
  EVENTS,
  WhiskerEventEmitter,
}; 