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
    
    // Polling management (centralized only)
    
    // WebSocket management
    this.websocketConnections = new Map(); // deviceId -> connection info
    
    // Weight update tracking
    this.lastWeightUpdates = new Map(); // deviceId -> last weight
    
    // Centralized pet polling
    this.centralizedPetPolling = {
      interval: null,
      lastPoll: null,
      isPolling: false
    };
    
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
    
    // Clean up polling (centralized polling is handled separately)
    
    // Clean up WebSocket connections
    await this._cleanupWebSocketConnection(deviceId);
    
    // Remove device data
    this.devices.delete(deviceId);
    this.deviceSubscriptions.delete(deviceId);
    this.websocketConnections.delete(deviceId);
    
    this.eventEmitter.emitDeviceRemoved(deviceId);
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
   * Set up centralized polling data source for Pet devices.
   * @param {string} deviceId - Device identifier
   * @param {Object} deviceInfo - Device information
   * @private
   */
  async _setupPetDataSource(deviceId, deviceInfo) {
    const petId = deviceInfo.data.petId;
    if (!petId) {
      throw new Error('Pet device missing pet ID');
    }

    this.homey.log(`Registering Pet device ${deviceId} (${petId}) for centralized polling`);
    
    // Start centralized polling if not already running
    this._startCentralizedPetPolling();
    
    // Store subscription cleanup
    this.deviceSubscriptions.set(deviceId, () => {
      this._checkAndStopCentralizedPetPolling();
    });
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
   * Start centralized polling for all pet devices.
   * @private
   */
  _startCentralizedPetPolling() {
    // Only start if not already running
    if (this.centralizedPetPolling.interval) {
      return;
    }

    this.homey.log('Starting centralized pet polling');
    
    const poll = async () => {
      // Prevent concurrent polls
      if (this.centralizedPetPolling.isPolling) {
        return;
      }
      
      this.centralizedPetPolling.isPolling = true;
      
      try {
        // Get all pets in a single API call
        const pets = await this.apiSession.getPets();
        this.homey.log(`Centralized pet poll: fetched ${pets.length} pets`);
        
        // Get all registered pet devices
        const petDevices = this.getDevicesByType(DEVICE_TYPES.PET);
        
        // Distribute data to each pet device
        for (const petDevice of petDevices) {
          const pet = pets.find(p => String(p.petId) === String(petDevice.data.petId));
          if (pet) {
            this._handlePetDataUpdate(petDevice.id, pet);
          }
        }
        
        this.centralizedPetPolling.lastPoll = Date.now();
        this.homey.log(`Centralized pet poll completed: updated ${petDevices.length} devices`);
        
      } catch (error) {
        this.homey.error('Centralized pet polling failed:', error);
        this.eventEmitter.emitError(error, 'centralized_pet_polling');
      } finally {
        this.centralizedPetPolling.isPolling = false;
      }
    };
    
    // Initial poll
    poll();
    
    // Set up interval
    this.centralizedPetPolling.interval = setInterval(poll, this.config.pollInterval);
  }

  /**
   * Check if centralized pet polling should be stopped and stop it if no pet devices remain.
   * @private
   */
  _checkAndStopCentralizedPetPolling() {
    const petDevices = this.getDevicesByType(DEVICE_TYPES.PET);
    
    if (petDevices.length === 0) {
      this._stopCentralizedPetPolling();
    }
  }

  /**
   * Stop centralized pet polling.
   * @private
   */
  _stopCentralizedPetPolling() {
    if (this.centralizedPetPolling.interval) {
      clearInterval(this.centralizedPetPolling.interval);
      this.centralizedPetPolling.interval = null;
      this.centralizedPetPolling.isPolling = false;
      this.homey.log('Stopped centralized pet polling');
    }
  }

  /**
   * Notify all pet devices of weight updates from LR4 devices.
   * @param {number} weight - Weight in pounds
   * @param {string} sourceDeviceId - Source LR4 device ID
   * @private
   */
  async _notifyWeightUpdate(weight, sourceDeviceId) {
    const weightGrams = Math.round(weight * 453.59237);
    this.homey.log(`\x1b[35mWeight update: ${weight} lbs (${weightGrams} g) from device ${sourceDeviceId}\x1b[0m`);

    // Check if weight actually changed to avoid unnecessary updates
    const lastWeight = this.lastWeightUpdates.get(sourceDeviceId);
    if (lastWeight === weight) {
      this.homey.log(`Weight unchanged (${weight} lbs), skipping pet data refresh`);
      return;
    }
    
    // Store the new weight
    this.lastWeightUpdates.set(sourceDeviceId, weight);

    // Trigger a centralized pet poll to refresh all pet devices
    const petDevices = this.getDevicesByType(DEVICE_TYPES.PET);
    if (petDevices.length === 0) {
      return;
    }

    try {
      this.homey.log(`Triggering centralized pet poll for ${petDevices.length} pet devices after weight update...`);
      
      // Make a single API call to get all pet data and update all devices
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
      // Use centralized polling approach - get all pets and find the specific one
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
    
    // Clean up centralized pet polling
    this._stopCentralizedPetPolling();
    
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
    this.websocketConnections.clear();
    this.lastWeightUpdates.clear();
    
    this.homey.log('Data manager destroyed');
  }
}

// Attach constants to the class
DataManager.DATA_SOURCES = DATA_SOURCES;
DataManager.DEVICE_TYPES = DEVICE_TYPES;

module.exports = DataManager; 