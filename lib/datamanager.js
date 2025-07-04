'use strict';

/**
 * Centralized data manager for the Whisker app.
 * Handles all data processing, WebSocket connections, and polling for both LR4 and Pet devices.
 * Following the pylitterbot pattern for clean data management.
 */

const { WhiskerException, WhiskerApiException } = require('./exceptions');
const { WhiskerEventEmitter, EVENTS } = require('./event');
const { redactSensitiveData, deepClone, deepEqual, sleep } = require('./utils');
const ApiSession = require('./apisession');

// Data source types
const DATA_SOURCES = {
  WEBSOCKET: 'websocket',
  POLLING: 'polling',
  API: 'api'
};

// Device types
const DEVICE_TYPES = {
  LITTER_ROBOT_4: 'litter_robot_4',
  PET: 'pet'
};

/**
 * Centralized data manager that handles all data processing and distribution.
 * Manages WebSocket connections, polling, and data parsing for all device types.
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
    
    this.eventEmitter = new WhiskerEventEmitter();
    
    // Device registrations
    this.devices = new Map(); // deviceId -> deviceInfo
    this.deviceSubscriptions = new Map(); // deviceId -> unsubscribe function
    
    // Data processors
    this.dataProcessors = new Map(); // deviceType -> processor class
    
    // Polling management
    this.pollingIntervals = new Map(); // deviceId -> interval
    this.pollingData = new Map(); // deviceId -> last poll data
    this.lastPollTimes = new Map(); // deviceId -> timestamp
    
    // WebSocket management
    this.websocketConnections = new Map(); // deviceId -> connection info
    
    // Cross-device communication
    this.weightUpdateSubscribers = new Set(); // Pet devices that want weight updates
    
    // Configuration
    this.config = {
      pollInterval: 5 * 60 * 1000, // 5 minutes for pet polling
      maxRetries: 3,
      retryDelay: 1000,
      websocketReconnectDelay: 5000,
      dataCacheTimeout: 30 * 1000 // 30 seconds
    };
  }

  /**
   * Register a data processor for a specific device type.
   * @param {string} deviceType - Device type (e.g., 'litter_robot_4', 'pet')
   * @param {Class} processorClass - Data processor class
   */
  registerDataProcessor(deviceType, processorClass) {
    this.dataProcessors.set(deviceType, processorClass);
    this.homey.log(`Registered data processor for ${deviceType}`);
  }

  /**
   * Register a device for data management.
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
      this.homey.log(`Device ${deviceId} is already registered`);
      return;
    }

    this.homey.log(`Registering device ${deviceId} (${deviceInfo.type})`);
    
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
   * Unregister a device and clean up resources.
   * @param {string} deviceId - Device identifier
   */
  async unregisterDevice(deviceId) {
    if (!this.devices.has(deviceId)) {
      this.homey.log(`Device ${deviceId} is not registered`);
      return;
    }

    this.homey.log(`Unregistering device ${deviceId}`);
    
    // Clean up subscriptions
    await this._cleanupDeviceSubscriptions(deviceId);
    
    // Clean up polling
    this._stopPolling(deviceId);
    
    // Clean up WebSocket connections
    await this._cleanupWebSocketConnection(deviceId);
    
    // Remove device data
    this.devices.delete(deviceId);
    this.deviceSubscriptions.delete(deviceId);
    this.pollingData.delete(deviceId);
    this.lastPollTimes.delete(deviceId);
    this.websocketConnections.delete(deviceId);
    
    this.eventEmitter.emitDeviceRemoved(deviceId);
  }

  /**
   * Subscribe to weight updates from LR4 devices.
   * Used by pet devices to get notified of weight changes.
   * @param {Function} callback - Callback function for weight updates
   * @returns {Function} Unsubscribe function
   */
  subscribeToWeightUpdates(callback) {
    this.weightUpdateSubscribers.add(callback);
    
    return () => {
      this.weightUpdateSubscribers.delete(callback);
    };
  }

  /**
   * Manually trigger a data refresh for a device.
   * @param {string} deviceId - Device identifier
   * @param {boolean} force - Force refresh even if recently updated
   * @returns {Promise<Object>} Updated data
   */
  async refreshDeviceData(deviceId, force = false) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      throw new Error(`Device ${deviceId} not found`);
    }

    this.homey.log(`Refreshing data for device ${deviceId}`);
    
    if (deviceInfo.type === DEVICE_TYPES.LITTER_ROBOT_4) {
      return this._refreshLR4Data(deviceId, force);
    } else if (deviceInfo.type === DEVICE_TYPES.PET) {
      return this._refreshPetData(deviceId, force);
    } else {
      throw new Error(`Unknown device type: ${deviceInfo.type}`);
    }
  }

  /**
   * Get the event emitter for subscribing to data manager events.
   * @returns {WhiskerEventEmitter} Event emitter instance
   */
  getEventEmitter() {
    return this.eventEmitter;
  }

  /**
   * Set up data source for a device based on its type.
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
      this.homey.error(`Failed to setup data source for device ${deviceId}:`, error);
      throw error;
    }
  }

  /**
   * Set up WebSocket data source for LR4 devices.
   * @param {string} deviceId - Device identifier
   * @param {Object} deviceInfo - Device information
   * @private
   */
  async _setupLR4DataSource(deviceId, deviceInfo) {
    const serial = deviceInfo.data.serial;
    if (!serial) {
      throw new Error('LR4 device missing serial number');
    }

    this.homey.log(`Setting up WebSocket for LR4 device ${deviceId} (${serial})`);
    
    // Create WebSocket connection
    const ws = await this.apiSession.createWebSocketConnection(deviceId, {
      serial,
      deviceType: DEVICE_TYPES.LITTER_ROBOT_4
    });
    
    // Store connection info
    this.websocketConnections.set(deviceId, {
      serial,
      connection: ws,
      connectedAt: Date.now(),
      lastMessage: null
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
   * Set up polling data source for Pet devices.
   * @param {string} deviceId - Device identifier
   * @param {Object} deviceInfo - Device information
   * @private
   */
  async _setupPetDataSource(deviceId, deviceInfo) {
    const petId = deviceInfo.data.petId;
    if (!petId) {
      throw new Error('Pet device missing pet ID');
    }

    this.homey.log(`Setting up polling for Pet device ${deviceId} (${petId})`);
    
    // Start polling
    this._startPolling(deviceId, petId);
    
    // Subscribe to weight updates if this is a pet device
    if (deviceInfo.data.subscribeToWeightUpdates) {
      const weightUnsubscribe = this.subscribeToWeightUpdates((weightData) => {
        this._handleWeightUpdate(deviceId, weightData);
      });
      
      // Store both subscriptions
      this.deviceSubscriptions.set(deviceId, () => {
        this._stopPolling(deviceId);
        weightUnsubscribe();
      });
    } else {
      this.deviceSubscriptions.set(deviceId, () => {
        this._stopPolling(deviceId);
      });
    }
  }

  /**
   * Handle LR4 data updates from WebSocket or API.
   * @param {string} deviceId - Device identifier
   * @param {Object} data - Updated robot data
   * @private
   */
  _handleLR4DataUpdate(deviceId, data) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      this.homey.log(`Received LR4 update for unregistered device ${deviceId}`);
      return;
    }

    this.homey.log(`Processing LR4 data update for device ${deviceId}`);
    
    // Update device data
    deviceInfo.lastUpdate = Date.now();
    this.devices.set(deviceId, deviceInfo);
    
    // Call device callback if provided
    if (deviceInfo.onDataUpdate) {
      try {
        deviceInfo.onDataUpdate(data, 'websocket');
      } catch (error) {
        this.homey.error(`Error in device data update callback for ${deviceId}:`, error);
      }
    }
    
    // Check for weight updates and notify pet devices
    if (data.catWeight && data.catWeight > 0) {
      this._notifyWeightUpdate(data.catWeight, deviceId);
    }
    
    // Emit event for other listeners
    this.eventEmitter.emitUpdate(deviceId, data);
  }

  /**
   * Handle Pet data updates from API.
   * @param {string} deviceId - Device identifier
   * @param {Object} data - Updated pet data
   * @private
   */
  _handlePetDataUpdate(deviceId, data) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      this.homey.log(`Received Pet update for unregistered device ${deviceId}`);
      return;
    }

    this.homey.log(`Processing Pet data update for device ${deviceId}`);
    
    // Update device data
    deviceInfo.lastUpdate = Date.now();
    this.devices.set(deviceId, deviceInfo);
    
    // Call device callback if provided
    if (deviceInfo.onDataUpdate) {
      try {
        deviceInfo.onDataUpdate(data, 'api');
      } catch (error) {
        this.homey.error(`Error in device data update callback for ${deviceId}:`, error);
      }
    }
    
    // Emit event for other listeners
    this.eventEmitter.emitUpdate(deviceId, data);
  }

  /**
   * Start polling for a pet device.
   * @param {string} deviceId - Device identifier
   * @param {string} petId - Pet ID
   * @private
   */
  _startPolling(deviceId, petId) {
    this.homey.log(`Starting polling for pet device ${deviceId} (${petId})`);
    
    const poll = async () => {
      try {
        const pets = await this.apiSession.getPets();
        const pet = pets.find(p => String(p.petId) === petId);
        
        if (pet) {
          this._handlePetDataUpdate(deviceId, pet);
        }
      } catch (error) {
        this.homey.error(`Polling failed for device ${deviceId}:`, error);
        this.eventEmitter.emitError(error, `pet_polling_${deviceId}`);
      }
    };
    
    // Initial poll
    poll();
    
    // Set up interval
    const interval = setInterval(poll, this.config.pollInterval);
    this.pollingIntervals.set(deviceId, interval);
  }

  /**
   * Stop polling for a device.
   * @param {string} deviceId - Device identifier
   * @private
   */
  _stopPolling(deviceId) {
    const interval = this.pollingIntervals.get(deviceId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(deviceId);
      this.homey.log(`Stopped polling for device ${deviceId}`);
    }
  }

  /**
   * Notify all pet devices of weight updates from LR4 devices.
   * @param {number} weight - Weight in pounds
   * @param {string} sourceDeviceId - Source LR4 device ID
   * @private
   */
  async _notifyWeightUpdate(weight, sourceDeviceId) {
    if (this.weightUpdateSubscribers.size === 0) {
      return;
    }

    const weightGrams = Math.round(weight * 453.59237);
    this.homey.log(`\x1b[35mWeight update: ${weight} lbs (${weightGrams} g) from device ${sourceDeviceId}\x1b[0m`);
    
    const weightData = {
      weight,
      weightGrams,
      sourceDeviceId,
      timestamp: Date.now()
    };

    // Get all pet devices that need updating
    const petDevices = this.getDevicesByType(DEVICE_TYPES.PET);
    if (petDevices.length === 0) {
      return;
    }

    // Make a single API call to get all pet data
    try {
      this.homey.log(`Refreshing pet data for ${petDevices.length} pet devices after weight update...`);
      const pets = await this.apiSession.getPets();
      
      // Update each pet device with the fresh data
      for (const petDevice of petDevices) {
        const pet = pets.find(p => String(p.petId) === String(petDevice.data.petId));
        if (pet) {
          this._handlePetDataUpdate(petDevice.id, pet);
        }
      }
      
      this.homey.log(`Successfully updated ${petDevices.length} pet devices with fresh data`);
    } catch (error) {
      this.homey.error('Failed to refresh pet data after weight update:', error);
      
      // Fallback: notify individual subscribers if centralized approach fails
      for (const callback of this.weightUpdateSubscribers) {
        try {
          callback(weightData);
        } catch (callbackError) {
          this.homey.error('Error in weight update callback:', callbackError);
        }
      }
    }
  }

  /**
   * Handle weight updates for pet devices.
   * @param {string} deviceId - Pet device identifier
   * @param {Object} weightData - Weight data from LR4
   * @private
   */
  _handleWeightUpdate(deviceId, weightData) {
            this.homey.log(`Pet device ${deviceId} received weight update: ${weightData.weight} lbs`);
    
    // Update pet device with new weight
    const deviceInfo = this.devices.get(deviceId);
    if (deviceInfo && deviceInfo.onDataUpdate) {
      try {
        deviceInfo.onDataUpdate({ lastWeightReading: weightData.weight }, 'weight_update');
      } catch (error) {
        this.homey.error(`Error updating pet device ${deviceId} with weight:`, error);
      }
    }
  }

  /**
   * Trigger an immediate poll for a pet device.
   * @param {string} deviceId - Device identifier
   * @private
   */
  async _triggerPetPoll(deviceId) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo || deviceInfo.type !== DEVICE_TYPES.PET) {
      return;
    }

    const petId = deviceInfo.data.petId;
    if (!petId) {
      return;
    }

    try {
      const pets = await this.apiSession.getPets();
      const pet = pets.find(p => String(p.petId) === petId);
      
      if (pet) {
        this._handlePetDataUpdate(deviceId, pet);
      }
    } catch (error) {
      this.homey.error(`Triggered poll failed for device ${deviceId}:`, error);
    }
  }

  /**
   * Refresh LR4 data via API.
   * @param {string} deviceId - Device identifier
   * @param {boolean} force - Force refresh
   * @private
   */
  async _refreshLR4Data(deviceId, force) {
    const deviceInfo = this.devices.get(deviceId);
    if (!deviceInfo) {
      throw new Error(`Device ${deviceId} not found`);
    }

    const lastUpdate = deviceInfo.lastUpdate;
    if (!force && lastUpdate && (Date.now() - lastUpdate) < this.config.dataCacheTimeout) {
      this.homey.log(`Skipping LR4 refresh for device ${deviceId} - data is recent`);
      return null;
    }

    try {
      // Get robot data via API
      const robots = await this.apiSession.getRobots();
      
      const robot = robots.find(r => r.serial === deviceInfo.data.serial);
      if (robot) {
        this._handleLR4DataUpdate(deviceId, robot);
        return robot;
      } else {
        throw new Error(`Robot with serial ${deviceInfo.data.serial} not found`);
      }
    } catch (error) {
      this.homey.error(`Failed to refresh LR4 data for device ${deviceId}:`, error);
      throw error;
    }
  }

  /**
   * Refresh pet data via API.
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
      this.homey.log(`Skipping Pet refresh for device ${deviceId} - data is recent`);
      return null;
    }

    try {
      const pets = await this.apiSession.getPets();
      const pet = pets.find(p => String(p.petId) === deviceInfo.data.petId);
      
      if (pet) {
        this._handlePetDataUpdate(deviceId, pet);
        return pet;
      } else {
        throw new Error(`Pet with ID ${deviceInfo.data.petId} not found`);
      }
    } catch (error) {
      this.homey.error(`Failed to refresh Pet data for device ${deviceId}:`, error);
      throw error;
    }
  }

  /**
   * Clean up device subscriptions.
   * @param {string} deviceId - Device identifier
   * @private
   */
  async _cleanupDeviceSubscriptions(deviceId) {
    const unsubscribe = this.deviceSubscriptions.get(deviceId);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (error) {
        this.homey.error(`Error during subscription cleanup for device ${deviceId}:`, error);
      }
      this.deviceSubscriptions.delete(deviceId);
    }
  }

  /**
   * Clean up WebSocket connection.
   * @param {string} deviceId - Device identifier
   * @private
   */
  async _cleanupWebSocketConnection(deviceId) {
    const connectionInfo = this.websocketConnections.get(deviceId);
    if (connectionInfo) {
      try {
        this.apiSession.closeWebSocketConnection(deviceId);
      } catch (error) {
        this.homey.error(`Error during WebSocket cleanup for device ${deviceId}:`, error);
      }
      this.websocketConnections.delete(deviceId);
    }
  }

  /**
   * Get device information.
   * @param {string} deviceId - Device identifier
   * @returns {Object|null} Device information
   */
  getDeviceInfo(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  /**
   * Get all registered devices.
   * @returns {Array} Array of device information
   */
  getAllDevices() {
    return Array.from(this.devices.entries()).map(([id, info]) => ({
      id,
      ...info
    }));
  }

  /**
   * Get devices by type.
   * @param {string} deviceType - Device type
   * @returns {Array} Array of devices of the specified type
   */
  getDevicesByType(deviceType) {
    return this.getAllDevices().filter(device => device.type === deviceType);
  }

  /**
   * Update device settings.
   * @param {string} deviceId - Device identifier
   * @param {Object} settings - New settings
   */
  updateDeviceSettings(deviceId, settings) {
    const deviceInfo = this.devices.get(deviceId);
    if (deviceInfo) {
      deviceInfo.settings = { ...deviceInfo.settings, ...settings };
      this.devices.set(deviceId, deviceInfo);
      this.homey.log(`Updated settings for device ${deviceId}`);
    }
  }

  /**
   * Clean up all resources.
   */
  destroy() {
    this.homey.log('Destroying data manager...');
    
    // Clean up all devices
    for (const deviceId of this.devices.keys()) {
      this.unregisterDevice(deviceId).catch(error => {
        this.homey.error(`Error during device cleanup for ${deviceId}:`, error);
      });
    }
    
    // Clean up event emitter
    this.eventEmitter.removeAllListeners();
    
    // Clear all maps
    this.devices.clear();
    this.deviceSubscriptions.clear();
    this.pollingIntervals.clear();
    this.pollingData.clear();
    this.lastPollTimes.clear();
    this.websocketConnections.clear();
    this.weightUpdateSubscribers.clear();
    
    this.homey.log('Data manager destroyed');
  }
}

// Attach constants to the class
DataManager.DATA_SOURCES = DATA_SOURCES;
DataManager.DEVICE_TYPES = DEVICE_TYPES;

module.exports = DataManager; 