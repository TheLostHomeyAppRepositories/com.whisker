'use strict';

/**
 * Centralized data manager for the Whisker app.
 * Manages real-time data flow between LR4 devices (via WebSocket) and Pet devices (via polling),
 * ensuring efficient API usage and cross-device communication for weight updates.
 */

const { WhiskerException, WhiskerApiException } = require('./exceptions');
const { WhiskerEventEmitter, EVENTS } = require('./event');
const ApiSession = require('./apisession');
const { convertLbsToGrams, colorize, LOG_COLORS } = require('./utils');

// Supported device types for data management
const DEVICE_TYPES = {
  LITTER_ROBOT_4: 'litter_robot_4',
  PET: 'pet'
};

/**
 * Centralized data manager that orchestrates data flow between devices and APIs.
 * Provides unified interface for device registration, real-time updates, and cross-device communication.
 */
class DataManager {
  constructor(apiSession, homey) {
    if (!apiSession) {
      throw new Error('ApiSession is required');
    }
    if (!homey) {
      throw new Error('Homey instance is required');
    }
    
    this.apiSession = apiSession;
    this.homey = homey;
    
    this.eventEmitter = new WhiskerEventEmitter(homey);
    
    // Device lifecycle management
    this.devices = new Map(); // deviceId -> deviceInfo
    this.deviceSubscriptions = new Map(); // deviceId -> unsubscribe function
    
    // Data processing pipeline
    this.dataProcessors = new Map(); // deviceType -> processor class
    
    // Cross-device weight synchronization
    this.lastWeightUpdates = new Map(); // deviceId -> last weight
    
    // Efficient pet data polling (single API call for all devices)
    this.centralizedPetPolling = {
      interval: null,
      lastPoll: null,
      isPolling: false,
      registrationTimeout: null,
      immediatePollTimeout: null
    };
    
    // Operational configuration
    this.config = {
      pollInterval: 5 * 60 * 1000, // Pet data refresh interval
      maxRetries: 3,
      retryDelay: 1000,
      websocketReconnectDelay: 5000,
      dataCacheTimeout: 30 * 1000 // Prevents redundant API calls
    };
  }

  /**
   * Registers a custom data processor for device-specific data transformation.
   * @param {string} deviceType - Device type (e.g., 'litter_robot_4', 'pet')
   * @param {Class} processorClass - Data processor class
   */
  registerDataProcessor(deviceType, processorClass) {
    this.dataProcessors.set(deviceType, processorClass);
    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Registered data processor for ${deviceType}`)}`);
  }

  /**
   * Registers a device for centralized data management and sets up appropriate data sources.
   * Establishes WebSocket connections for LR4 devices or polling for Pet devices.
   * @param {string} deviceId - Unique device identifier
   * @param {Object} deviceInfo - Device information
   * @param {string} deviceInfo.type - Device type
   * @param {Object} deviceInfo.data - Device-specific data
   * @param {Function} deviceInfo.onDataUpdate - Callback for data updates
   * @param {Object} deviceInfo.settings - Device settings
   * @returns {Promise<void>}
   */
  async registerDevice(deviceId, deviceInfo) {
    if (this.devices.has(deviceId)) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, `Device ${deviceId} is already registered`)}`);
      return;
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, `Registering device ${deviceId} (${deviceInfo.type})`)}`);
    
    // Store device information
    this.devices.set(deviceId, {
      ...deviceInfo,
      registeredAt: Date.now(),
      lastUpdate: null
    });

    // Set up data source based on device type
    await this._setupDeviceDataSource(deviceId, deviceInfo);
    
    this.eventEmitter.emitDeviceAdded(deviceId, deviceInfo);
  }

  /**
   * Unregisters a device and cleans up all associated resources.
   * Closes WebSocket connections, stops polling, and removes event subscriptions.
   * @param {string} deviceId - Device identifier
   */
  async unregisterDevice(deviceId) {
    if (!this.devices.has(deviceId)) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, `Device ${deviceId} is not registered`)}`);
      return;
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, `Unregistering device ${deviceId}`)}`);
    
    try {
      // Clean up subscriptions
      await this._cleanupDeviceSubscriptions(deviceId);
      
      // Clean up polling (centralized polling is handled separately)
      
      // Clean up WebSocket connections
      await this._cleanupWebSocketConnection(deviceId);
      
      // Remove device data
      this.devices.delete(deviceId);
      this.deviceSubscriptions.delete(deviceId);
      
      this.eventEmitter.emitDeviceRemoved(deviceId);
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Error during device unregistration for ${deviceId}:`)}`, error);
      // Continue cleanup even if some parts fail
      this.devices.delete(deviceId);
      this.deviceSubscriptions.delete(deviceId);
    }
  }



  /**
   * Manually triggers a data refresh for a device, bypassing cache if needed.
   * @param {string} deviceId - Device identifier
   * @param {boolean} force - Force refresh even if recently updated
   * @returns {Promise<Object>} Updated data
   */
  async refreshDeviceData(deviceId, force = false) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      throw new Error(`Device ${deviceId} not found`);
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Refreshing data for device ${deviceId}`)}`);
    
    if (deviceInfo.type === DEVICE_TYPES.LITTER_ROBOT_4) {
      return this._refreshLR4Data(deviceId, force);
    } else if (deviceInfo.type === DEVICE_TYPES.PET) {
      return this._refreshPetData(deviceId, force);
    } else {
      throw new Error(`Unknown device type: ${deviceInfo.type}`);
    }
  }

  /**
   * Returns the event emitter for subscribing to data manager events.
   * @returns {WhiskerEventEmitter} Event emitter instance
   */
  getEventEmitter() {
    return this.eventEmitter;
  }

  /**
   * Sets up the appropriate data source based on device type.
   * LR4 devices use WebSocket connections, Pet devices use centralized polling.
   * @param {string} deviceId - Device identifier
   * @param {Object} deviceInfo - Device information
   * @private
   */
  async _setupDeviceDataSource(deviceId, deviceInfo) {
    try {
      if (deviceInfo.type === DEVICE_TYPES.LITTER_ROBOT_4) {
        await this._setupLR4DataSource(deviceId, deviceInfo);
      } else if (deviceInfo.type === DEVICE_TYPES.PET) {
        await this._setupPetDataSource(deviceId, deviceInfo);
      } else {
        throw new Error(`Unknown device type: ${deviceInfo.type}`);
      }
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Failed to setup data source for device ${deviceId}:`)}`, error);
      throw error;
    }
  }

  /**
   * Establishes WebSocket connection for real-time LR4 device updates.
   * @param {string} deviceId - Device identifier
   * @param {Object} deviceInfo - Device information
   * @private
   */
  async _setupLR4DataSource(deviceId, deviceInfo) {
    const serial = deviceInfo.data.serial;
    if (!serial) {
      throw new Error('LR4 device missing serial number');
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Setting up WebSocket for LR4 device ${deviceId}`)}`);
    
    // Create WebSocket connection via ApiSession
    await this.apiSession.createWebSocketConnection(deviceId, {
      serial,
      deviceType: DEVICE_TYPES.LITTER_ROBOT_4
    });
    
    // Subscribe to WebSocket events
    const unsubscribe = this.apiSession.getEventEmitter().on(EVENTS.DATA_RECEIVED, (data) => {
      if (data.deviceId === deviceId) {
        this._handleLR4DataUpdate(deviceId, data.data);
      }
    });
    
    this.deviceSubscriptions.set(deviceId, unsubscribe);
  }

  /**
   * Registers Pet device for centralized polling to minimize API calls.
   * @param {string} deviceId - Device identifier
   * @param {Object} deviceInfo - Device information
   * @private
   */
  async _setupPetDataSource(deviceId, deviceInfo) {
    const petId = deviceInfo.data.petId;
    if (!petId) {
      throw new Error('Pet device missing pet ID');
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Registering Pet device ${deviceId} (${petId}) for centralized polling`)}`);
    
    // Check if centralized polling is already active
    const isPollingActive = this.centralizedPetPolling.interval || this.centralizedPetPolling.isPolling;
    
    // Batch device registrations to avoid multiple polling starts
    if (this.centralizedPetPolling.registrationTimeout) {
      this.homey.clearTimeout(this.centralizedPetPolling.registrationTimeout);
    }
    
    this.centralizedPetPolling.registrationTimeout = this.homey.setTimeout(() => {
      this._startCentralizedPetPolling();
    }, 100); // Delay allows multiple devices to register before starting polling
    
    // If polling is already active, trigger immediate centralized poll for new devices
    if (isPollingActive) {
      // Clear any existing immediate poll timeout to batch multiple registrations
      if (this.centralizedPetPolling.immediatePollTimeout) {
        this.homey.clearTimeout(this.centralizedPetPolling.immediatePollTimeout);
      }
      
      this.centralizedPetPolling.immediatePollTimeout = this.homey.setTimeout(() => {
        this._triggerImmediatePetPoll();
      }, 150);
    }
    
    // Store subscription cleanup - Pet devices use centralized polling, so cleanup is handled differently
    this.deviceSubscriptions.set(deviceId, () => {
      // For Pet devices, we just need to check if we should stop centralized polling
      this._checkAndStopCentralizedPetPolling();
    });
  }

  /**
   * Triggers immediate pet poll for newly registered devices when polling is already active.
   * @private
   */
  async _triggerImmediatePetPoll() {
    try {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Triggering immediate pet poll for newly registered devices`)}`);
      
      await this._executeCentralizedPetPoll();
      
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SUCCESS, `Immediate pet poll completed`)}`);
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Failed to trigger immediate pet poll:`)}`, error);
    }
  }

  /**
   * Processes LR4 data updates and triggers cross-device weight synchronization.
   * @param {string} deviceId - Device identifier
   * @param {Object} data - Updated robot data
   * @private
   */
  _handleLR4DataUpdate(deviceId, data) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, `Received LR4 update for unregistered device ${deviceId}`)}`);
      return;
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Processing LR4 data update for device ${deviceId}`)}`);
    
    // Update device state
    deviceInfo.lastUpdate = Date.now();
    this.devices.set(deviceId, deviceInfo);
    
    // Notify device of data update
    if (deviceInfo.onDataUpdate) {
      try {
        deviceInfo.onDataUpdate(data, 'websocket');
      } catch (error) {
        this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Error in device data update callback for ${deviceId}:`)}`, error);
      }
    }
    
    // Trigger pet data refresh if weight changed
    if (data.catWeight && data.catWeight > 0) {
      this._notifyWeightUpdate(data.catWeight, deviceId);
    }
    
    // Broadcast update to other listeners
    this.eventEmitter.emitUpdate(deviceId, data);
  }

  /**
   * Processes Pet data updates from API polling.
   * @param {string} deviceId - Device identifier
   * @param {Object} data - Updated pet data
   * @private
   */
  _handlePetDataUpdate(deviceId, data) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, `Received Pet update for unregistered device ${deviceId}`)}`);
      return;
    }

    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Processing Pet data update for device ${deviceId}`)}`);
    
    // Update device state
    deviceInfo.lastUpdate = Date.now();
    this.devices.set(deviceId, deviceInfo);
    
    // Notify device of data update
    if (deviceInfo.onDataUpdate) {
      try {
        deviceInfo.onDataUpdate(data, 'api');
      } catch (error) {
        this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Error in device data update callback for ${deviceId}:`)}`, error);
      }
    }
    
    // Broadcast update to other listeners
    this.eventEmitter.emitUpdate(deviceId, data);
  }



  /**
   * Executes a single centralized pet poll operation.
   * Extracted from _startCentralizedPetPolling for reuse.
   * @private
   */
  async _executeCentralizedPetPoll() {
    // Prevent concurrent polling operations
    if (this.centralizedPetPolling.isPolling) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, 'Centralized pet polling already in progress, skipping')}`);
      return;
    }
    
    this.centralizedPetPolling.isPolling = true;
    
    try {
      this.centralizedPetPolling.lastPoll = Date.now();
      
      // Verify devices still exist
      const petDevices = this.getDevicesByType(DEVICE_TYPES.PET);
      if (petDevices.length === 0) {
        this._stopCentralizedPetPolling();
        return;
      }
      
      // Single API call updates all pet devices efficiently
      const pets = await this.apiSession.getPets();
      
      // Distribute fresh data to all pet devices
      for (const petDevice of petDevices) {
        const pet = pets.find(p => String(p.petId) === String(petDevice.data.petId));
        if (pet) {
          this._handlePetDataUpdate(petDevice.id, pet);
        }
      }
      
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SUCCESS, `Centralized pet poll completed for ${petDevices.length} devices`)}`);
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, 'Centralized pet polling failed:')}`, error);
    } finally {
      this.centralizedPetPolling.isPolling = false;
    }
  }

  /**
   * Starts centralized pet polling to efficiently update all pet devices.
   * @private
   */
  _startCentralizedPetPolling() {
    // Prevent duplicate polling instances
    if (this.centralizedPetPolling.interval || this.centralizedPetPolling.isPolling) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, 'Centralized pet polling already active, skipping start')}`);
      return;
    }
    
    // Verify pet devices exist before starting
    const petDevices = this.getDevicesByType(DEVICE_TYPES.PET);
    if (petDevices.length === 0) {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, 'No pet devices found, skipping polling start')}`);
      return;
    }
    
    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Starting centralized pet polling for ${petDevices.length} devices...`)}`);
    
    // Ensure clean polling state
    if (this.centralizedPetPolling.interval) {
      this.homey.clearInterval(this.centralizedPetPolling.interval);
    }
    
    // Start immediate polling and schedule recurring updates
    this._executeCentralizedPetPoll();
    
    this.centralizedPetPolling.interval = this.homey.setInterval(() => {
      this._executeCentralizedPetPoll();
    }, this.config.pollInterval);
  }

  /**
   * Checks if centralized pet polling should be stopped due to no remaining pet devices.
   * @private
   */
  _checkAndStopCentralizedPetPolling() {
    const petDevices = this.getDevicesByType(DEVICE_TYPES.PET);
    
    if (petDevices.length === 0) {
      this._stopCentralizedPetPolling();
    }
  }

  /**
   * Stops centralized pet polling and cleans up associated resources.
   * @private
   */
  _stopCentralizedPetPolling() {
    if (this.centralizedPetPolling.interval) {
      this.homey.clearInterval(this.centralizedPetPolling.interval);
      this.centralizedPetPolling.interval = null;
      this.centralizedPetPolling.isPolling = false;
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, 'Stopped centralized pet polling')}`);
    }
    
    // Clean up registration timeout
    if (this.centralizedPetPolling.registrationTimeout) {
      this.homey.clearTimeout(this.centralizedPetPolling.registrationTimeout);
      this.centralizedPetPolling.registrationTimeout = null;
    }
    
    // Clean up immediate poll timeout
    if (this.centralizedPetPolling.immediatePollTimeout) {
      this.homey.clearTimeout(this.centralizedPetPolling.immediatePollTimeout);
      this.centralizedPetPolling.immediatePollTimeout = null;
    }
  }

  /**
   * Triggers pet data refresh when LR4 devices detect weight changes.
   * Ensures pet devices have current weight information for health monitoring.
   * @param {number} weight - Weight in pounds
   * @param {string} sourceDeviceId - Source LR4 device ID
   * @private
   */
  async _notifyWeightUpdate(weight, sourceDeviceId) {
    const weightGrams = convertLbsToGrams(weight, this.homey);
    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, `Weight update: ${weight} lbs (${weightGrams} g) from device ${sourceDeviceId}`)}`);

    // Avoid unnecessary API calls if weight hasn't changed
    const lastWeight = this.lastWeightUpdates.get(sourceDeviceId);
    if (lastWeight === weight) {
              this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Weight unchanged (${weight} lbs), skipping pet data refresh`)}`);
      return;
    }
    
    // Track weight change for future comparisons
    this.lastWeightUpdates.set(sourceDeviceId, weight);

    // Refresh all pet devices with current data
    const petDevices = this.getDevicesByType(DEVICE_TYPES.PET);
    if (petDevices.length === 0) {
      return;
    }

    try {
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, `Triggering centralized pet poll for ${petDevices.length} pet devices after weight update...`)}`);
      
      // Efficient single API call updates all pet devices
      const pets = await this.apiSession.getPets();
      
      // Distribute updated pet data
      for (const petDevice of petDevices) {
        const pet = pets.find(p => String(p.petId) === String(petDevice.data.petId));
        if (pet) {
          this._handlePetDataUpdate(petDevice.id, pet);
        }
      }
      
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SUCCESS, `Successfully updated ${petDevices.length} pet devices with fresh data`)}`);
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, 'Failed to refresh pet data after weight update:')}`, error);
    }
  }





  /**
   * Refreshes LR4 data via API when WebSocket is unavailable.
   * @param {string} deviceId - Device identifier
   * @param {boolean} force - Force refresh
   * @private
   */
  async _refreshLR4Data(deviceId, force) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      throw new Error(`Device ${deviceId} not found`);
    }

    // Respect cache timeout unless forced refresh
    const lastUpdate = deviceInfo.lastUpdate;
    if (!force && lastUpdate && (Date.now() - lastUpdate) < this.config.dataCacheTimeout) {
              this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, `Skipping LR4 refresh for device ${deviceId} - data is recent`)}`);
      return null;
    }

    try {
      // Fetch robot data and find matching device
      const robots = await this.apiSession.getRobots();
      
      const robot = robots.find(r => r.serial === deviceInfo.data.serial);
      if (robot) {
        this._handleLR4DataUpdate(deviceId, robot);
        return robot;
      } else {
        throw new Error(`Robot with serial ${deviceInfo.data.serial} not found`);
      }
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Failed to refresh LR4 data for device ${deviceId}:`)}`, error);
      throw error;
    }
  }

  /**
   * Refreshes pet data via API using centralized polling approach.
   * @param {string} deviceId - Device identifier
   * @param {boolean} force - Force refresh
   * @private
   */
  async _refreshPetData(deviceId, force) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      throw new Error(`Device ${deviceId} not found`);
    }

    const lastUpdate = deviceInfo.lastUpdate;
    if (!force && lastUpdate && (Date.now() - lastUpdate) < this.config.dataCacheTimeout) {
              this.homey.log(`[DataManager] ${colorize(LOG_COLORS.WARNING, `Skipping Pet refresh for device ${deviceId} - data is recent`)}`);
      return null;
    }

    try {
      // Leverage centralized polling for efficient data retrieval
      const pets = await this.apiSession.getPets();
      const pet = pets.find(p => String(p.petId) === deviceInfo.data.petId);
      
      if (pet) {
        this._handlePetDataUpdate(deviceId, pet);
        return pet;
      } else {
        throw new Error(`Pet with ID ${deviceInfo.data.petId} not found`);
      }
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Failed to refresh Pet data for device ${deviceId}:`)}`, error);
      throw error;
    }
  }

  /**
   * Cleans up device subscriptions and removes event listeners.
   * @param {string} deviceId - Device identifier
   * @private
   */
  async _cleanupDeviceSubscriptions(deviceId) {
    const unsubscribe = this.deviceSubscriptions.get(deviceId);
    if (unsubscribe && typeof unsubscribe === 'function') {
      try {
        unsubscribe();
      } catch (error) {
        this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Error during subscription cleanup for device ${deviceId}:`)}`, error);
      }
    }
    this.deviceSubscriptions.delete(deviceId);
  }

  /**
   * Closes WebSocket connection and cleans up associated resources.
   * @param {string} deviceId - Device identifier
   * @private
   */
  async _cleanupWebSocketConnection(deviceId) {
    try {
      if (this.apiSession) {
        this.apiSession.closeWebSocketConnection(deviceId);
      }
    } catch (error) {
      this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Error during WebSocket cleanup for device ${deviceId}:`)}`, error);
    }
  }

  /**
   * Retrieves device information by ID.
   * @param {string} deviceId - Device identifier
   * @returns {Object|null} Device information
   */
  getDeviceInfo(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  /**
   * Returns all registered devices with their information.
   * @returns {Array} Array of device information
   */
  getAllDevices() {
    return Array.from(this.devices.entries()).map(([id, info]) => ({
      id,
      ...info
    }));
  }

  /**
   * Returns all devices of a specific type.
   * @param {string} deviceType - Device type
   * @returns {Array} Array of devices of the specified type
   */
  getDevicesByType(deviceType) {
    return this.getAllDevices().filter(device => device.type === deviceType);
  }

  /**
   * Updates device settings with new configuration.
   * @param {string} deviceId - Device identifier
   * @param {Object} settings - New settings
   */
  updateDeviceSettings(deviceId, settings) {
    const deviceInfo = this.devices.get(deviceId);
    if (deviceInfo) {
      deviceInfo.settings = { ...deviceInfo.settings, ...settings };
      this.devices.set(deviceId, deviceInfo);
      this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SYSTEM, `Updated settings for device ${deviceId}`)}`);
    }
  }

  /**
   * Destroys the data manager and cleans up all resources.
   */
  destroy() {
    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.INFO, 'Destroying data manager...')}`);
    
    // Stop all background operations
    this._stopCentralizedPetPolling();
    
    // Unregister all devices
    for (const deviceId of this.devices.keys()) {
      this.unregisterDevice(deviceId).catch(error => {
        this.homey.error(`[DataManager] ${colorize(LOG_COLORS.ERROR, `Error during device cleanup for ${deviceId}:`)}`, error);
      });
    }
    
    // Remove all event listeners
    this.eventEmitter.removeAllListeners();
    
    // Clear all internal state
    this.devices.clear();
    this.deviceSubscriptions.clear();
    this.lastWeightUpdates.clear();
    
    this.homey.log(`[DataManager] ${colorize(LOG_COLORS.SUCCESS, 'Data manager destroyed')}`);
  }
}

// Expose device types for external use
DataManager.DEVICE_TYPES = DEVICE_TYPES;

module.exports = DataManager; 