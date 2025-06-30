'use strict';

const Homey = require('homey');
const LR4Data = require('../../lib/litterrobot4data');

module.exports = class LitterRobotDevice extends Homey.Device {

  /**
   * Device initialization - sets up capabilities, WebSocket subscription, and listeners
   */
  async onInit() {
    this.log('Litter-Robot device initialized');

    try {
      // Get robot serial from device data
      const data = this.getData();
      this.robotSerial = data.id;

      if (!this.robotSerial) {
        throw new Error('Invalid device data. Missing robot serial.');
      }

      this.log('Device data:', { robotSerial: this.robotSerial, data });

      // Initialize capabilities with loading states
      await this._initializeCapabilities();

      // Get robot data using centralized session
      await this._fetchRobotData();

      // Setup WebSocket subscription for real-time updates
      await this._setupWebSocket();

      // Register capability listeners for user interactions
      await this._registerCapabilityListeners();
      
      this.log('Device initialization completed successfully');
      
      // Ensure device is marked as available
      if (this.setAvailable) {
        this.setAvailable();
        this.log('Device marked as available');
      }

    } catch (err) {
      this.error('Failed to initialize device:', err);
      
      // Mark device as unavailable if initialization fails
      if (this.setUnavailable) {
        this.setUnavailable(err.message);
        this.log('Device marked as unavailable due to initialization failure');
      }
      
      throw err;
    }
  }

  /**
   * Refresh device state - called during repair to reinitialize the device
   * @returns {Promise<void>}
   */
  async refresh() {
    this.log('Refreshing device state...');

    try {
      // Clean up existing connections
      if (this._eventSubscription) {
        this._eventSubscription();
        this._eventSubscription = null;
        this.log('Cleaned up existing event subscription');
      }

      if (this.robot?.serial) {
        const apiSession = this.homey.app.apiSession;
        if (apiSession) {
          apiSession.closeWebSocketConnection(this.robot.serial);
          this.log('Closed existing WebSocket connection');
    }
      }

      // Force re-initialization
      await this._forceReinitialize();

      this.log('Device refresh completed successfully');
    } catch (err) {
      this.error('Failed to refresh device:', err);
    
      // Mark device as unavailable if refresh fails
      if (this.setUnavailable) {
        this.setUnavailable(err.message);
        this.log('Device marked as unavailable due to refresh failure');
      }
      
      throw err;
    }
  }

  /**
   * Force re-initialization of the device
   * @private
   */
  async _forceReinitialize() {
    this.log('Forcing device re-initialization...');

    try {
      // Re-fetch robot data
      await this._fetchRobotData();

      // Re-setup WebSocket subscription
      await this._setupWebSocket();

      // Re-register capability listeners
      await this._registerCapabilityListeners();
      
      // Ensure device is marked as available
      if (this.setAvailable) {
        this.setAvailable();
        this.log('Device marked as available after re-initialization');
      }

      this.log('Device re-initialization completed successfully');
    } catch (err) {
      this.error('Failed to re-initialize device:', err);
      throw err;
    }
  }

  /**
   * Initialize all device capabilities with loading states
   * @private
   */
  async _initializeCapabilities() {
    const initialCapabilities = {
      // Status capabilities
      clean_cycle_status: 'Loading...',
      litter_robot_status: 'Loading...',
      
      // Alarm capabilities
      alarm_cat_detected: false,
      alarm_waste_drawer_full: false,
      alarm_sleep_mode_active: false,
      alarm_sleep_mode_scheduled: false,
      alarm_problem: false,
      alarm_connectivity: false,
      
      // Measurement capabilities
      measure_litter_level_percentage: null,
      measure_waste_drawer_level_percentage: null,
      measure_odometer_clean_cycles: null,
      measure_scoops_saved_count: null,
      measure_weight: null,
      
      // Control capabilities
      clean_cycle_wait_time: null,
      key_pad_lock_out: false,
      
      // Time-related capabilities
      sleep_mode_start_time: 'Loading...',
      sleep_mode_end_time: 'Loading...',
      last_seen: 'Loading...'
    };

    // Set all initial values
    for (const [capability, value] of Object.entries(initialCapabilities)) {
      try {
        await this.setCapabilityValue(capability, value);
      } catch (err) {
        this.error(`Failed to initialize capability ${capability}:`, err);
      }
    }

    this.log('Capabilities initialized');
  }

  /**
   * Fetch robot data from API
   * @private
   */
  async _fetchRobotData() {
    try {
      const apiSession = this.homey.app.apiSession;
      if (!apiSession) {
        throw new Error('No API session available. Please repair device.');
      }

      // Use the same approach as the old working code - get all robots and find by serial
      const robots = await apiSession.getRobots();
      const robot = robots.find(r => String(r.serial) === String(this.robotSerial));
      
      if (!robot) {
        throw new Error(`Robot with serial ${this.robotSerial} not found`);
      }

      this.robot = robot;
      this.log('Connected to robot:', this.robot.nickname || this.robot.serial);

      // Update capabilities with initial data
      this._updateCapabilities(this.robot);

      // Update device settings with robot information
      await this._updateDeviceSettings(this.robot);

    } catch (err) {
      this.error('Failed to fetch robot data:', err);
      throw err;
    }
  }

  /**
   * Update device settings with robot information
   * @param {Object} robot - Robot data
   * @private
   */
  async _updateDeviceSettings(robot) {
    try {
      // Get user preferences for time/date formatting
      const settings = this.getSettings();
      const use12hFormat = settings.use_12h_format || false;
      const forceUSDate = settings.use_us_date_format || false;
      
      // Update device settings with robot information
      await this.setSettings({
        device_serial: robot.serial || 'Unknown',
        device_user_id: robot.userId || 'Unknown',
        device_firmware: LR4Data.formatFirmwareVersion(robot) || 'Unknown',
        device_setup_date: robot.setupDateTime ? 
          LR4Data.formatTime(robot.setupDateTime, { use12hFormat, forceUSDate }) : 
          'Unknown',
        device_timezone: robot.unitTimezone || 'Unknown'
      });

      this.log('Device settings updated with robot information');
    } catch (err) {
      this.error('Failed to update device settings:', err);
    }
  }

  /**
   * Setup WebSocket subscription for real-time updates
   * @private
   */
  async _setupWebSocket() {
    try {
      const apiSession = this.homey.app.apiSession;
      
      // Subscribe to robot updates via WebSocket
      this._subscription = await apiSession.createWebSocketConnection(
        this.robot.serial,
        {
          serial: this.robot.serial
        }
      );

      // Subscribe to WebSocket events
      this._eventSubscription = apiSession.getEventEmitter().on('data_received', (eventData) => {
        if (eventData.deviceId === this.robot.serial) {
          this._handleRobotUpdate(eventData.data);
        }
      });

      this.log('WebSocket subscription established');

      // Request initial state
      setTimeout(() => {
        this._requestInitialState();
      }, 10000);
      
    } catch (err) {
      this.error('Failed to setup WebSocket:', err);
      throw err;
    }
  }

  /**
   * Request initial state from robot
   * @private
   */
  async _requestInitialState() {
    try {
      const apiSession = this.homey.app.apiSession;
      
      // Send requestState command via GraphQL mutation (not WebSocket)
      const query = `
        mutation sendCommand($serial: String!, $command: String!, $value: String) {
          sendLitterRobot4Command(input: {
            serial: $serial,
            command: $command,
            value: $value
          })
        }
      `;
      
      await apiSession.lr4Graphql(query, {
        serial: this.robot.serial,
        command: 'requestState',
        value: null
      });
      
      this.log('Requested initial state from robot via GraphQL');
    } catch (err) {
      this.error('Failed to request initial state:', err);
    }
  }

  /**
   * Register capability listeners for user interactions
   * @private
   */
  async _registerCapabilityListeners() {
    // Register capability listeners for user interactions
    this.registerCapabilityListener('start_clean_cycle', async () => {
      await this._sendCommand('cleanCycle');
    });

    this.registerCapabilityListener('start_empty_cycle', async () => {
      await this._sendCommand('emptyCycle');
    });

    this.registerCapabilityListener('short_reset_press', async () => {
      await this._sendCommand('shortResetPress');
    });

    this.registerCapabilityListener('clean_cycle_wait_time', async (value) => {
      const clumpTime = parseInt(value, 10);
      if (isNaN(clumpTime)) throw new Error('Invalid wait time value');
      const payload = JSON.stringify({ clumpTime });
      this.log('Sending setClumpTime with payload:', payload);
      await this._sendCommand('setClumpTime', payload);
    });

    this.registerCapabilityListener('night_light_mode', async (value) => {
      let command;
      switch (value) {
        case 'off':  command = 'nightLightModeOff'; break;
        case 'on':   command = 'nightLightModeOn'; break;
        case 'auto': command = 'nightLightModeAuto'; break;
        default: throw new Error('Invalid night light mode value');
      }
      await this._sendCommand(command);
    });

    this.registerCapabilityListener('panel_brightness', async (value) => {
      let command;
      switch (value) {
        case 'low':    command = 'panelBrightnessLow'; break;
        case 'medium': command = 'panelBrightnessMed'; break;
        case 'high':   command = 'panelBrightnessHigh'; break;
        default: throw new Error('Invalid panel brightness value');
      }
      await this._sendCommand(command);
    });

    this.registerCapabilityListener('key_pad_lock_out', async (value) => {
      const command = value ? 'keyPadLockOutOn' : 'keyPadLockOutOff';
      await this._sendCommand(command);
    });

    this.log('Capability listeners registered');
  }

  /**
   * Send command to robot using centralized session
   * @param {string} command - Command to send
   * @param {Object} payload - Optional payload
   * @private
   */
  async _sendCommand(command, payload = null) {
    try {
      const apiSession = this.homey.app.apiSession;
      
      if (!this.robot?.isOnline) {
        throw new Error(`Robot is offline. Cannot send command: ${command}`);
      }

      // Send command via GraphQL mutation (not WebSocket)
      const query = `
        mutation sendCommand($serial: String!, $command: String!, $value: String) {
          sendLitterRobot4Command(input: {
            serial: $serial,
            command: $command,
            value: $value
          })
        }
      `;
      
      // Convert payload to string value if provided
      const value = payload ? (typeof payload === 'object' ? JSON.stringify(payload) : String(payload)) : null;
      
      this.log(`Sending command: ${command}`, payload);
      await apiSession.lr4Graphql(query, {
        serial: this.robot.serial,
        command,
        value
      });
      this.log(`Successfully sent command: ${command}`);

      } catch (err) {
      this.error(`Failed to send command ${command}:`, err);
        throw err;
      }
  }

  /**
   * Handle robot updates from WebSocket
   * @param {Object} update - Robot update data
   * @private
   */
  _handleRobotUpdate(update) {
    this.log('Received robot update:', update);
    
    // Update robot data
    this.robot = { ...this.robot, ...update };

    // Update capabilities
    this._updateCapabilities(update);
    
    // Update device settings if firmware information changed
    if (update.espFirmware || update.picFirmwareVersion || update.laserBoardFirmwareVersion) {
      this._updateDeviceSettings(this.robot);
    }
    
    // Notify pet devices of weight changes
    if (update.catWeight) {
      const weightGrams = Math.round(update.catWeight * 453.592); // lbs to grams
      this._notifyPetDevices(weightGrams);
    }
  }

  /**
   * Notify pet devices of weight measurement
   * @param {number} weightGrams - Weight in grams
   * @private
   */
  async _notifyPetDevices(weightGrams) {
    try {
      const app = this.homey.app;
      if (app && app.onWeightMeasurement) {
        await app.onWeightMeasurement(weightGrams);
      }
    } catch (err) {
      this.error('Failed to notify pet devices:', err);
    }
  }

  /**
   * Update device capabilities based on robot data
   * @param {Object} data - Robot data
   * @private
   */
  _updateCapabilities(data) {
    if (!data) return;
    
    // Create robot data instance for processing
    const robotData = new LR4Data({ robot: data });
    const settings = this.getSettings();
    
    // Define capability updates
    const updates = [
      ['clean_cycle_status', robotData.cycleStateDescription],
      ['litter_robot_status', robotData.statusDescription],
      ['alarm_cat_detected', robotData.isCatDetected],
      ['alarm_waste_drawer_full', robotData.isDrawerFull],
      ['measure_litter_level_percentage', robotData.litterLevelPercentage],
      ['measure_waste_drawer_level_percentage', robotData.wasteDrawerLevelPercentage],
      ['measure_odometer_clean_cycles', robotData.totalCleanCycles],
      ['measure_scoops_saved_count', robotData.scoopsSavedCount],
      ['alarm_sleep_mode_active', robotData.isSleepActive],
      ['alarm_sleep_mode_scheduled', !!robotData.sleepSchedule],
      ['sleep_mode_start_time', robotData.sleepSchedule?.startString || 'Not set'],
      ['sleep_mode_end_time', robotData.sleepSchedule?.endString || 'Not set'],
      ['measure_weight', robotData.weightInGrams],
      ['alarm_problem', robotData.hasProblem],
      ['clean_cycle_wait_time', robotData.cleanCycleWaitTimeString],
      ['key_pad_lock_out', robotData.isKeypadLocked],
      ['night_light_mode', robotData.nightLightMode],
      ['alarm_connectivity', !robotData.isOnline],
      ['last_seen', robotData.isOnline ? 'Currently connected' : (robotData.lastSeenFormatted || 'Unknown')]
    ];

    // Track changes for Flow card triggering
    const changes = new Set();
    
    // Update capabilities
    for (const [capability, newValue] of updates) {
      if (newValue === undefined || newValue === null) continue;

      const oldValue = this.getCapabilityValue(capability);
      
      // Handle initialization from loading state
      if (oldValue === 'Loading...') {
        this.setCapabilityValue(capability, newValue).catch(err => {
          this.error(`Failed to initialize capability ${capability}:`, err);
        });
        continue;
      }

      // Only update if value actually changed
      if (newValue !== oldValue) {
        this.log(`${capability} changed: ${oldValue} → ${newValue}`);
        this.setCapabilityValue(capability, newValue).catch(err => {
          this.error(`Failed to update capability ${capability}:`, err);
        });
        changes.add(capability);
      }
    }

    // Trigger Flow cards for detected changes
    if (changes.size > 0) {
      this._triggerFlowCards(changes, robotData);
    }
  }

  /**
   * Trigger Flow cards based on capability changes
   * @param {Set<string>} changes - Set of changed capabilities
   * @param {LR4Data} robotData - Current robot data
   * @private
   */
  _triggerFlowCards(changes, robotData) {
    // Clean cycle multiple trigger - trigger on every cycle increase
    // The run listener in the driver will check if it's a multiple of the user's configured count
    if (changes.has('measure_odometer_clean_cycles')) {
      const totalCycles = this.getCapabilityValue('measure_odometer_clean_cycles');
      if (typeof totalCycles === 'number' && totalCycles > 0) {
        // Get the previous cycle count from device store
        const previousCycles = this.getStoreValue('previous_clean_cycles') || 0;
        
        // Only trigger if the cycle count increased (not on initialization)
        if (totalCycles > previousCycles) {
          this.log(`Clean cycle count increased: ${previousCycles} → ${totalCycles}`);
          
          // Trigger the clean_cycle_multiple card - the run listener will check if it's a multiple
          this.homey.flow.getDeviceTriggerCard('clean_cycle_multiple')
            .trigger(this, { total_cycles: totalCycles })
            .catch(err => this.error('Failed to trigger clean_cycle_multiple:', err));
        }
        
        // Store the current count for next comparison
        this.setStoreValue('previous_clean_cycles', totalCycles);
      }
    }

    // Cat detection triggers
    if (changes.has('alarm_cat_detected')) {
      const isCatDetected = robotData.isCatDetected;
      const triggerCard = isCatDetected ? 'cat_detected' : 'cat_not_detected';
      
      this.homey.flow.getDeviceTriggerCard(triggerCard)
        .trigger(this, {})
        .catch(err => this.error(`Failed to trigger ${triggerCard}:`, err));
    }

    // Waste drawer triggers
    if (changes.has('alarm_waste_drawer_full')) {
      const isDrawerFull = robotData.isDrawerFull;
      const wasteLevel = robotData.wasteDrawerLevelPercentage;
      const triggerCard = isDrawerFull ? 'waste_drawer_full' : 'waste_drawer_not_full';
      
      this.homey.flow.getDeviceTriggerCard(triggerCard)
        .trigger(this, { waste_level: wasteLevel })
        .catch(err => this.error(`Failed to trigger ${triggerCard}:`, err));
    }

    // Sleep mode triggers
    if (changes.has('alarm_sleep_mode_active')) {
      const isSleepActive = robotData.isSleepActive;
      if (isSleepActive) {
        this.homey.flow.getDeviceTriggerCard('sleep_mode_activated')
          .trigger(this, {})
          .catch(err => this.error('Failed to trigger sleep_mode_activated:', err));
      } else {
        this.homey.flow.getDeviceTriggerCard('sleep_mode_deactivated')
          .trigger(this, {})
          .catch(err => this.error('Failed to trigger sleep_mode_deactivated:', err));
      }
    }

    // Problem detection triggers
    if (changes.has('alarm_problem')) {
      const hasProblem = robotData.hasProblem;
      if (hasProblem) {
        this.homey.flow.getDeviceTriggerCard('problem_details_provided')
          .trigger(this, {
          problem_description: robotData.problemDescription,
          problem_codes: robotData.problemCodes,
          problem_count: robotData.problemCount
          })
          .catch(err => this.error('Failed to trigger problem_details_provided:', err));
      }
    }
  }

  /**
   * Device cleanup when deleted
   */
  onDeleted() {
    this.log('Device deleted, cleaning up...');
    
    // Clean up WebSocket connection
    if (this.robot?.serial) {
      const apiSession = this.homey.app.apiSession;
      if (apiSession) {
        apiSession.closeWebSocketConnection(this.robot.serial);
    }
  }

    // Clean up event subscription
    if (this._eventSubscription) {
      this._eventSubscription();
    }
  }
} 