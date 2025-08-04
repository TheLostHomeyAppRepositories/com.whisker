'use strict';

/**
 * Centralized event system for cross-device communication and data synchronization.
 * Enables decoupled communication between app components while maintaining consistent
 * event structure and timestamps for all system events.
 */

const EventEmitter = require('events');
const { colorize, LOG_COLORS } = require('./utils');

// Standardized event types for consistent cross-component communication
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
 * Enhanced event emitter providing structured event emission with consistent data format.
 * Ensures all events include device context and timestamps for reliable event tracking
 * and debugging across the distributed app architecture.
 */
class WhiskerEventEmitter extends EventEmitter {
  constructor(homey) {
    super();
    this.setMaxListeners(100); // Allow up to 100 listeners per event type
    this.homey = homey;
  }

  /**
   * Broadcasts device state changes to all registered listeners.
   * Used for real-time device updates that may affect multiple components.
   */
  emitUpdate(deviceId, data) {
    this.homey.log(`[EventEmitter] ${colorize(LOG_COLORS.INFO, `Broadcasting update for device ${deviceId}`)}`);
    this.emit(EVENTS.UPDATE, { deviceId, data, timestamp: Date.now() });
  }

  /**
   * Notifies when a device establishes a connection.
   * Enables connection state tracking and UI updates across the app.
   */
  emitConnected(deviceId, connectionInfo = {}) {
    this.homey.log(`[EventEmitter] ${colorize(LOG_COLORS.SUCCESS, `Device ${deviceId} connected`)}`);
    this.emit(EVENTS.CONNECTED, { deviceId, connectionInfo, timestamp: Date.now() });
  }

  /**
   * Notifies when a device connection is lost.
   * Provides context for disconnection to help with debugging and recovery.
   */
  emitDisconnected(deviceId, reason = 'unknown') {
    this.homey.log(`[EventEmitter] ${colorize(LOG_COLORS.WARNING, `Device ${deviceId} disconnected: ${reason}`)}`);
    this.emit(EVENTS.DISCONNECTED, { deviceId, reason, timestamp: Date.now() });
  }

  /**
   * Reports errors with context for centralized error handling and logging.
   * Enables consistent error reporting across all app components.
   */
  emitError(error, context = 'unknown') {
    this.homey.error(`[EventEmitter] ${colorize(LOG_COLORS.ERROR, `Error in ${context}:`)}`, error);
    this.emit(EVENTS.ERROR, { error, context, timestamp: Date.now() });
  }

  /**
   * Signals authentication failures for immediate user notification.
   * Triggers re-authentication flows and prevents cascading auth errors.
   */
  emitAuthenticationFailed(error) {
    this.homey.error(`[EventEmitter] ${colorize(LOG_COLORS.ERROR, 'Authentication failed:')}`, error);
    this.emit(EVENTS.AUTHENTICATION_FAILED, { error, timestamp: Date.now() });
  }

  /**
   * Announces new device registration for cross-device synchronization.
   * Enables other components to initialize device-specific handlers.
   */
  emitDeviceAdded(deviceId, deviceInfo = {}) {
    this.homey.log(`[EventEmitter] ${colorize(LOG_COLORS.SYSTEM, `Device ${deviceId} added to event system`)}`);
    this.emit(EVENTS.DEVICE_ADDED, { deviceId, deviceInfo, timestamp: Date.now() });
  }

  /**
   * Notifies when a device is removed to clean up related resources.
   * Prevents memory leaks and stale references in other components.
   */
  emitDeviceRemoved(deviceId) {
    this.homey.log(`[EventEmitter] ${colorize(LOG_COLORS.SYSTEM, `Device ${deviceId} removed from event system`)}`);
    this.emit(EVENTS.DEVICE_REMOVED, { deviceId, timestamp: Date.now() });
  }

  /**
   * Broadcasts incoming data from various sources (WebSocket, polling, etc.).
   * Enables centralized data processing and cross-device data synchronization.
   */
  emitDataReceived(deviceId, data, source = 'unknown') {
    this.homey.log(`[EventEmitter] ${colorize(LOG_COLORS.INFO, `Data received for device ${deviceId} from ${source}`)}`);
    this.emit(EVENTS.DATA_RECEIVED, { deviceId, data, source, timestamp: Date.now() });
  }

  /**
   * Logs command execution for audit trails and debugging.
   * Helps track command flow and identify potential issues.
   */
  emitCommandSent(deviceId, command, parameters = {}) {
    this.homey.log(`[EventEmitter] ${colorize(LOG_COLORS.COMMAND, `Command sent to device ${deviceId}: ${command}`)}`);
    this.emit(EVENTS.COMMAND_SENT, { deviceId, command, parameters, timestamp: Date.now() });
  }

  /**
   * Reports command failures for error handling and user feedback.
   * Enables retry logic and prevents silent command failures.
   */
  emitCommandFailed(deviceId, command, error) {
    this.homey.error(`[EventEmitter] ${colorize(LOG_COLORS.ERROR, `Command failed for device ${deviceId}: ${command}`)}`, error);
    this.emit(EVENTS.COMMAND_FAILED, { deviceId, command, error, timestamp: Date.now() });
  }
}

module.exports = {
  EVENTS,
  WhiskerEventEmitter,
}; 