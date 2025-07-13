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

      this.log(`Device initialized with robot serial: ${this.robotSerial}`);

      // Initialize capabilities with loading states
      await this._initializeCapabilities();

      // Get robot data using centralized session
      await this._fetchRobotData();

      // Manage hopper capabilities based on settings and device state
      await this._manageHopperCapabilities();

      // Register with DataManager for centralized data management
      await this._registerWithDataManager();

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
      // Clean up existing DataManager registration
      if (this.robotSerial) {
        const dataManager = this.homey.app.dataManager;
        if (dataManager) {
          await dataManager.unregisterDevice(this.robotSerial);
          this.log('Unregistered from DataManager');
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

      // Re-register with DataManager
      await this._registerWithDataManager();

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
   * Manage hopper capabilities based on user settings and device state
   * @private
   */
  async _manageHopperCapabilities() {
    try {
      const settings = this.getSettings();
      const hopperMode = settings.litter_hopper_mode || 'automatic';
      
      await this._manageHopperCapabilitiesWithMode(hopperMode);
    } catch (err) {
      this.error('Failed to manage hopper capabilities:', err);
    }
  }

  /**
   * Manage hopper capabilities with a specific mode
   * @param {string} hopperMode - The hopper mode to use
   * @private
   */
  async _manageHopperCapabilitiesWithMode(hopperMode) {
    try {
      // Get current device state for hopper detection
      const settings = this.getSettings();
      const robotData = this.robot ? new LR4Data({ robot: this.robot, settings }) : null;
      
      // Determine if device has a hopper based on hopper status
      // A device has a hopper if it has any hopper status (not null/undefined)
      // and is not in a "removed" state
      const hasHopper = robotData ? 
        (robotData.hopperStatus !== null && robotData.hopperStatus !== undefined && !robotData.isHopperRemoved) : 
        false;
      
      // Determine if hopper capabilities should be shown
      let shouldShowHopper = false;
      switch (hopperMode) {
        case 'automatic':
          shouldShowHopper = hasHopper;
          break;
        case 'enabled':
          shouldShowHopper = true;
          break;
        case 'disabled':
          shouldShowHopper = false;
          break;
        default:
          shouldShowHopper = hasHopper; // fallback to automatic
      }
      
      // Define hopper capabilities
      const hopperCapabilities = [
        'alarm_litter_hopper_empty',
        'litter_hopper_status', 
        'litter_hopper_enabled'
      ];
      
      // Get current capabilities
      const currentCapabilities = this.getCapabilities();
      
      // Track if any changes were made
      let changesMade = false;
      
      // Add or remove hopper capabilities as needed
      for (const capability of hopperCapabilities) {
        const hasCapability = currentCapabilities.includes(capability);
        
        if (shouldShowHopper && !hasCapability) {
          this.log(`\x1b[36mAdding hopper capability: ${capability}\x1b[0m`);
          await this.addCapability(capability);
          
          // Initialize the capability with appropriate default values
          const defaultValue = this._getHopperCapabilityDefaultValue(capability);
          await this.setCapabilityValue(capability, defaultValue);
          changesMade = true;
          
        } else if (!shouldShowHopper && hasCapability) {
          this.log(`\x1b[33mRemoving hopper capability: ${capability}\x1b[0m`);
          await this.removeCapability(capability);
          changesMade = true;
        }
      }
      
      // Only log completion if changes were made
      if (changesMade) {
        this.log(`\x1b[32mHopper capability management completed (mode: ${hopperMode})\x1b[0m`);
      }
    } catch (err) {
      this.error('Failed to manage hopper capabilities:', err);
    }
  }

  /**
   * Get default value for a hopper capability
   * @param {string} capability - Capability ID
   * @returns {any} Default value
   * @private
   */
  _getHopperCapabilityDefaultValue(capability) {
    switch (capability) {
      case 'alarm_litter_hopper_empty':
        return false;
      case 'litter_hopper_status':
        return 'Loading...';

      case 'litter_hopper_enabled':
        return false;
      default:
        return null;
    }
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
      // Get user preferences for time formatting
      const settings = this.getSettings();
      const use12hFormat = settings.use_12h_format === '12h';
      
      // Update device settings with robot information
      await this.setSettings({
        device_serial: robot.serial || 'Unknown',
        device_user_id: robot.userId || 'Unknown',
        device_firmware: LR4Data.formatFirmwareVersion(robot) || 'Unknown',
        device_setup_date: robot.setupDateTime ? 
          LR4Data.formatTime(robot.setupDateTime, { use12hFormat }) : 
          'Unknown',
        device_timezone: robot.unitTimezone || 'Unknown'
      });

      this.log('Device settings updated with robot information');
    } catch (err) {
      this.error('Failed to update device settings:', err);
    }
  }

  /**
   * Register with DataManager for centralized data management
   * @private
   */
  async _registerWithDataManager() {
    try {
      const dataManager = this.homey.app.dataManager;
      if (!dataManager) {
        throw new Error('DataManager not available');
      }

      // Register device with DataManager
      await dataManager.registerDevice(this.robotSerial, {
        type: 'litter_robot_4',
        data: {
          serial: this.robot.serial,
          name: this.robot.name
        },
        onDataUpdate: (data, source) => {
          this._handleRobotUpdate(data);
        }
      });

      this.log('Registered with DataManager for centralized data management');

      // Request initial state after a short delay
      setTimeout(() => {
        this._requestInitialState();
      }, 5000);
      
    } catch (err) {
      this.error('Failed to register with DataManager:', err);
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

    // Register hopper capability listeners
    this.registerCapabilityListener('litter_hopper_enabled', async (value) => {
      this.log(`LitterHopper enabled capability changed to: ${value}`);
      const command = value ? 'enableHopper' : 'disableHopper';
      this.log(`Sending command: ${command}`);
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
      
      this.log(`\x1b[33mSending command: ${command}${payload ? ' with payload' : ''}\x1b[0m`);
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
  async _handleRobotUpdate(update) {
    this.log(`\x1b[36mReceived robot update for ${update.name || update.serial}\x1b[0m`);
    
    // Update robot data
    this.robot = { ...this.robot, ...update };

    // Update capabilities
    await this._updateCapabilities(update);
    
    // Update device settings if firmware information changed
    if (update.espFirmware || update.picFirmwareVersion || update.laserBoardFirmwareVersion) {
      this._updateDeviceSettings(this.robot);
    }
    
    // Note: Weight updates are handled centrally by DataManager when WebSocket data is received
    // No need to manually notify pet devices here to avoid duplication
  }



  /**
   * Update device capabilities based on robot data
   * @param {Object} data - Robot data
   * @private
   */
  async _updateCapabilities(data) {
    if (!data) return;
    
    // Get current settings for time formatting
    const settings = this.getSettings();
    
    // Create robot data instance for processing with current settings
    const robotData = new LR4Data({ robot: data, settings });
    
    // Manage hopper capabilities first (this may add/remove capabilities)
    await this._manageHopperCapabilities();
    
    // Define capability updates
    const updates = [
      ['clean_cycle_status', robotData.cycleStateDescription],
      ['litter_robot_status', robotData.statusDescription],
      ['alarm_cat_detected', robotData.isCatDetected],
      ['alarm_waste_drawer_full', robotData.wasteDrawerLevelPercentage >= settings.waste_drawer_threshold],
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

    // Add hopper capability updates if hopper capabilities are present
    const currentCapabilities = this.getCapabilities();
    if (currentCapabilities.includes('alarm_litter_hopper_empty')) {
      updates.push(
        ['alarm_litter_hopper_empty', robotData.isHopperEmpty],
        ['litter_hopper_status', robotData.hopperStatusDescription],
        ['litter_hopper_enabled', robotData.isHopperEnabled]
      );
    }

    // Track changes for Flow card triggering
    const changes = new Set();
    
    // Update capabilities
    for (const [capability, newValue] of updates) {
      if (newValue === undefined || newValue === null) continue;

      const oldValue = this.getCapabilityValue(capability);
      
      // Handle initialization from loading state
      if (oldValue === 'Loading...') {
        this.log(`\x1b[36mInitializing capability ${capability}: ${newValue}\x1b[0m`);
        this.setCapabilityValue(capability, newValue).catch(err => {
          this.error(`\x1b[31mFailed to initialize capability ${capability}:\x1b[0m`, err);
        });
        continue;
      }

      // Only update if value actually changed
      if (newValue !== oldValue) {
        this.log(`\x1b[33m${capability} changed: ${oldValue} → ${newValue}\x1b[0m`);
        this.setCapabilityValue(capability, newValue).catch(err => {
          this.error(`\x1b[31mFailed to update capability ${capability}:\x1b[0m`, err);
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

    // Problem detection triggers
    if (changes.has('alarm_problem')) {
      const hasProblem = robotData.hasProblem;
      if (hasProblem) {
        this.homey.flow.getDeviceTriggerCard('problem_details_provided')
          .trigger(this, {
          problem_description: robotData.problemDescription,
          problem_codes: robotData.problemCodes.join(', '),
          problem_count: robotData.problemCount
          })
          .catch(err => this.error('Failed to trigger problem_details_provided:', err));
      }
    }
  }

  /**
   * Handle settings changes
   * @param {Object} oldSettings - Previous settings
   * @param {Object} newSettings - New settings
   */
  async onSettings({ oldSettings, newSettings }) {
    this.log('Device settings updated');
    
    // Check if hopper mode changed
    if (oldSettings?.litter_hopper_mode !== newSettings?.litter_hopper_mode) {
      this.log(`Hopper mode changed: ${oldSettings?.litter_hopper_mode} → ${newSettings?.litter_hopper_mode}`);
      
      // Use the new settings directly instead of reading from cache
      await this._manageHopperCapabilitiesWithMode(newSettings.litter_hopper_mode);
      
      // Request fresh state from the device to get updated hopper status
      try {
        this.log('Requesting fresh device state after hopper mode change...');
        await this._sendCommand('requestState');
      } catch (err) {
        this.error('Failed to request state after hopper mode change:', err);
      }
    }
    
    // Check if time format changed
    if (oldSettings?.use_12h_format !== newSettings?.use_12h_format) {
      this.log(`Time format changed: ${oldSettings?.use_12h_format} → ${newSettings?.use_12h_format}`);
      
      // Re-process current robot data with new time format settings
      if (this.robot) {
        this.log('Re-processing robot data with new time format settings...');
        await this._updateCapabilities(this.robot);
      }
    }
  }

  /**
   * Device cleanup when deleted
   */
  onDeleted() {
    this.log('Device deleted, cleaning up...');
    
    // Clean up DataManager registration
    if (this.robotSerial) {
      const dataManager = this.homey.app.dataManager;
      if (dataManager) {
        dataManager.unregisterDevice(this.robotSerial).catch(err => {
          this.error('Error during DataManager cleanup:', err);
        });
      }
    }
    
    this.log('Device cleanup completed');
  }
} 