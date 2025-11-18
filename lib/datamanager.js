/**
 * @module DataManager
 * Manages centralized pet polling and weight-triggered synchronization for pet devices.
 * Uses a single API call to update all pet devices simultaneously, reducing API load.
 * Devices manage their own WebSocket connections and data sources independently.
 */

const { EventEmitter } = require('./event');
const { colorize, LOG_COLORS, convertLbsToGrams } = require('./utils');

/**
 * Manages centralized pet polling and weight-triggered synchronization.
 * Coordinates pet data updates across multiple pet devices using a single API call
 * to reduce redundant requests. Devices manage their own connections and only
 * register here for polling updates.
 *
 * @class
 */
class DataManager {
  /**
   * Creates a new DataManager instance.
   *
   * @param {Object} session - API session for making pet data requests
   * @param {Object} homey - Homey instance for logging and timers
   * @param {Function|null} [onSignOutCallback=null] - Callback invoked when all devices are unregistered
   * @param {EventEmitter} [eventEmitter] - Optional shared event emitter; creates new one if not provided
   */
  constructor(session, homey, onSignOutCallback = null, eventEmitter) {
    if (!session) {
      throw new Error('Session is required');
    }
    if (!homey) {
      throw new Error('Homey instance is required');
    }

    this.session = session;
    this.homey = homey;
    this.onSignOutCallback = onSignOutCallback;

    this.eventEmitter = eventEmitter || new EventEmitter();
    if (this.eventEmitter === eventEmitter) {
      // Shared emitter requires higher limit to accommodate multiple devices
      this.eventEmitter.setMaxListeners(100);
    }

    // Stores minimal device info needed for centralized polling
    // Maps deviceId -> { petId, onDataUpdate callback }
    this.petDevices = new Map();

    // Tracks last reported weight per device to avoid unnecessary refreshes
    this.lastWeightUpdates = new Map();

    // Coordinates single API call that updates all pet devices simultaneously
    this.petPolling = {
      interval: null,
      lastPoll: null,
      isPolling: false,
      registrationTimeout: null,
      immediatePollTimeout: null,
    };

    this.config = {
      pollInterval: 5 * 60 * 1000,
      weightPollDebounceMs: 3000,
    };

    this._weightPollTimer = null;
    this._weightPollCallback = null;
  }

  /**
   * Registers a pet device for centralized polling.
   * Batches registration requests to avoid starting multiple polling intervals
   * when multiple devices register simultaneously.
   *
   * @param {string} deviceId - Device identifier
   * @param {string} petId - Pet ID to poll for
   * @param {Function} onDataUpdate - Callback invoked when pet data is retrieved
   */
  registerPetDevice(deviceId, petId, onDataUpdate) {
    if (this.petDevices.has(deviceId)) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, `Pet device ${deviceId} is already registered`)}`);
      return;
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, `Registering pet device ${deviceId} (${petId}) for polling`)}`);

    this.petDevices.set(deviceId, {
      petId,
      onDataUpdate,
      registeredAt: Date.now(),
    });

    const isPollingActive = this.petPolling.interval || this.petPolling.isPolling;

    // Debounce polling start to batch multiple simultaneous registrations
    if (this.petPolling.registrationTimeout) {
      this.homey.clearTimeout(this.petPolling.registrationTimeout);
    }

    this.petPolling.registrationTimeout = this.homey.setTimeout(() => {
      this._startPetPolling();
    }, 100);

    if (isPollingActive) {
      // Debounce immediate poll to coalesce multiple registrations into one API call
      if (this.petPolling.immediatePollTimeout) {
        this.homey.clearTimeout(this.petPolling.immediatePollTimeout);
      }

      this.petPolling.immediatePollTimeout = this.homey.setTimeout(() => {
        this._triggerPetPoll();
      }, 150);
    }
  }

  /**
   * Unregisters a pet device from centralized polling.
   * Stops polling if no devices remain and triggers sign-out callback if configured.
   *
   * @param {string} deviceId - Device identifier to unregister
   */
  unregisterPetDevice(deviceId) {
    if (!this.petDevices.has(deviceId)) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, `Pet device ${deviceId} is not registered`)}`);
      return;
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, `Unregistering pet device ${deviceId}`)}`);

    this.petDevices.delete(deviceId);

    this._checkAndStopPetPolling();

    const totalDevices = this.petDevices.size;
    if (totalDevices === 0 && this.onSignOutCallback) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, 'No devices remaining, triggering signOut...')}`);
      try {
        this.onSignOutCallback().catch((error) => {
          this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, 'Error during signOut callback:')}`, error);
        });
      } catch (error) {
        this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, 'Error during signOut callback:')}`, error);
      }
    }
  }

  /**
   * Notifies DataManager of a weight update from an LR4 device.
   * Debounces weight-triggered pet polls to prevent excessive API calls
   * when weight readings fluctuate rapidly.
   *
   * @param {number} weight - Weight in pounds
   * @param {string} sourceDeviceId - Source LR4 device ID that reported the weight
   * @param {Function} [onPollComplete] - Optional callback invoked after pet poll completes with pets array
   */
  notifyWeightUpdate(weight, sourceDeviceId, onPollComplete = null) {
    const weightGrams = convertLbsToGrams(weight);
    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, `Weight update: ${weight} lbs (${weightGrams} g) from device ${sourceDeviceId}`)}`);

    const lastWeight = this.lastWeightUpdates.get(sourceDeviceId);
    if (lastWeight === weight) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Weight unchanged (${weight} lbs), skipping pet data refresh`)}`);
      return;
    }

    this.lastWeightUpdates.set(sourceDeviceId, weight);

    // Store callback to invoke after poll completes
    this._weightPollCallback = onPollComplete;

    // Debounce to coalesce rapid weight updates into a single pet poll
    if (this._weightPollTimer) {
      this.homey.clearTimeout(this._weightPollTimer);
    }

    this._weightPollTimer = this.homey.setTimeout(() => {
      this._executeCentralizedPetPoll();
    }, this.config.weightPollDebounceMs);
  }

  /**
   * Executes a single API call to fetch all pets and updates all registered devices.
   * Prevents concurrent polls to avoid race conditions and redundant API calls.
   *
   * @private
   */
  async _executeCentralizedPetPoll() {
    if (this.petPolling.isPolling) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, 'Pet polling already in progress, skipping')}`);
      return;
    }

    this.petPolling.isPolling = true;

    let pets = null;
    try {
      this.petPolling.lastPoll = Date.now();

      if (this.petDevices.size === 0) {
        this._stopPetPolling();
        // Still invoke callback with empty array if no pet devices
        if (this._weightPollCallback) {
          try {
            this._weightPollCallback([]);
          } catch (error) {
            this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, 'Error in weight poll callback:')}`, error);
          }
          this._weightPollCallback = null;
        }
        return;
      }

      pets = await this.session.getPets();

      for (const [deviceId, deviceInfo] of this.petDevices.entries()) {
        const pet = pets.find((p) => String(p.petId) === String(deviceInfo.petId));
        if (pet && deviceInfo.onDataUpdate) {
          try {
            deviceInfo.onDataUpdate(pet, 'api');
          } catch (error) {
            this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Error in pet device callback for ${deviceId}:`)}`, error);
          }
        }
      }

      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SUCCESS, `Pet poll completed for ${this.petDevices.size} devices`)}`);
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, 'Pet polling failed:')}`, error);
      pets = null; // Ensure pets is null on error
    } finally {
      this.petPolling.isPolling = false;

      // Invoke callback with fetched pets (or null on error)
      if (this._weightPollCallback) {
        try {
          this._weightPollCallback(pets || []);
        } catch (error) {
          this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, 'Error in weight poll callback:')}`, error);
        }
        this._weightPollCallback = null;
      }
    }
  }

  /**
   * Triggers immediate pet poll for newly registered devices.
   * Used when polling is already active to provide initial data without waiting
   * for the next scheduled interval.
   *
   * @private
   */
  async _triggerPetPoll() {
    try {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, 'Triggering pet poll for newly registered devices')}`);

      await this._executeCentralizedPetPoll();

      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SUCCESS, 'Pet poll completed')}`);
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, 'Failed to trigger pet poll:')}`, error);
    }
  }

  /**
   * Starts periodic pet polling using a single API call per interval.
   * Executes immediate poll on start to populate device data without delay.
   *
   * @private
   */
  _startPetPolling() {
    if (this.petPolling.interval || this.petPolling.isPolling) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, 'Pet polling already active, skipping start')}`);
      return;
    }

    if (this.petDevices.size === 0) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, 'No pet devices found, skipping polling start')}`);
      return;
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Starting pet polling for ${this.petDevices.size} devices...`)}`);

    if (this.petPolling.interval) {
      this.homey.clearInterval(this.petPolling.interval);
    }

    this._executeCentralizedPetPoll();

    this.petPolling.interval = this.homey.setInterval(() => {
      this._executeCentralizedPetPoll();
    }, this.config.pollInterval);
  }

  /**
   * Stops polling when no pet devices remain to avoid unnecessary API calls.
   *
   * @private
   */
  _checkAndStopPetPolling() {
    if (this.petDevices.size === 0) {
      this._stopPetPolling();
    }
  }

  /**
   * Stops pet polling interval and clears all pending timers.
   * Prevents leaks from orphaned intervals and timeouts.
   *
   * @private
   */
  _stopPetPolling() {
    if (this.petPolling.interval) {
      this.homey.clearInterval(this.petPolling.interval);
      this.petPolling.interval = null;
      this.petPolling.isPolling = false;
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, 'Stopped pet polling')}`);
    }

    if (this.petPolling.registrationTimeout) {
      this.homey.clearTimeout(this.petPolling.registrationTimeout);
      this.petPolling.registrationTimeout = null;
    }

    if (this.petPolling.immediatePollTimeout) {
      this.homey.clearTimeout(this.petPolling.immediatePollTimeout);
      this.petPolling.immediatePollTimeout = null;
    }

    if (this._weightPollTimer) {
      this.homey.clearTimeout(this._weightPollTimer);
      this._weightPollTimer = null;
    }
  }

  /**
   * Destroys the data manager and releases all resources.
   * Stops polling, clears device registrations, and removes event listeners
   * to prevent memory leaks.
   */
  destroyDataManager() {
    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, 'Destroying data manager...')}`);

    this._stopPetPolling();

    this.onSignOutCallback = null;

    this.petDevices.clear();
    this.lastWeightUpdates.clear();

    if (this.eventEmitter) {
      this.eventEmitter.removeAllListeners();
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SUCCESS, 'Data manager destroyed')}`);
  }
}

module.exports = DataManager;
