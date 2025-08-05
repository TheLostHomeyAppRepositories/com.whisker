'use strict';

const Homey = require('homey');
const LR4Data = require('../../lib/litterrobot4data');
const { colorize, LOG_COLORS } = require('../../lib/utils');

module.exports = class LitterRobotDevice extends Homey.Device {

  /**
   * Initializes the Litter-Robot device and establishes connection to the centralized
   * data management system for real-time updates and cross-device communication.
   */
  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing Litter-Robot device...'));

    try {
      const data = this.getData();
      this.robotSerial = data.id;

      if (!this.robotSerial) {
        throw new Error('Invalid device data. Missing robot serial.');
      }

      this.log(colorize(LOG_COLORS.INFO, `Device initialized with robot serial: ${this.robotSerial}`));

      await this._initializeCapabilities();
      await this._fetchRobotData();
      await this._manageHopperCapabilities();
      await this._registerWithDataManager();
      await this._registerCapabilityListeners();
      
      this.log(colorize(LOG_COLORS.SUCCESS, 'Device initialization completed successfully'));
      
      if (this.setAvailable) {
        this.setAvailable();
        this.log(colorize(LOG_COLORS.SUCCESS, 'Device marked as available'));
      }

    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to initialize device:'), err);
      
      if (this.setUnavailable) {
        this.setUnavailable(err.message);
        this.log(colorize(LOG_COLORS.ERROR, 'Device marked as unavailable due to initialization failure'));
      }
      
      throw err;
    }
  }

  /**
   * Sets up all device capabilities with default values to prevent undefined
   * states while waiting for initial data from the robot.
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

    for (const [capability, value] of Object.entries(initialCapabilities)) {
      try {
        await this.setCapabilityValue(capability, value);
      } catch (err) {
        this.error(`[Capability] ${colorize(LOG_COLORS.ERROR, `Failed to initialize capability ${colorize(LOG_COLORS.BOLD, capability)}:`)}`, err);
      }
    }

    this.log(colorize(LOG_COLORS.INFO, 'Capabilities initialized successfully'));
  }

  /**
   * Determines hopper capability visibility based on user preferences and
   * hardware detection to provide a consistent user experience.
   * @private
   */
  async _manageHopperCapabilities() {
    try {
      const settings = this.getSettings();
      const hopperMode = settings.litter_hopper_mode || 'automatic';
      
      await this._manageHopperCapabilitiesWithMode(hopperMode);
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to manage hopper capabilities:'), err);
    }
  }

  /**
   * Dynamically adjusts hopper capabilities based on user preferences and hardware
   * detection to ensure the interface matches the actual device capabilities.
   * @param {string} hopperMode - The hopper mode to use (automatic, enabled, disabled)
   * @private
   */
  async _manageHopperCapabilitiesWithMode(hopperMode) {
    try {
      const settings = this.getSettings();
      const robotData = this.robot ? new LR4Data({ robot: this.robot, settings }) : null;
      
      const hasHopper = robotData ? 
        (robotData.hopperStatus !== null && robotData.hopperStatus !== undefined && !robotData.isHopperRemoved) : 
        false;
      
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
          shouldShowHopper = hasHopper;
      }
      
      const hopperCapabilities = [
        'alarm_litter_hopper_empty',
        'litter_hopper_status', 
        'litter_hopper_enabled'
      ];
      
      const currentCapabilities = this.getCapabilities();
      let changesMade = false;
      
      for (const capability of hopperCapabilities) {
        const hasCapability = currentCapabilities.includes(capability);
        
        if (shouldShowHopper && !hasCapability) {
          this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Adding hopper capability: [${capability}]`)}`);
          await this.addCapability(capability).catch(err => {
            this.error(`[Capability] ${colorize(LOG_COLORS.ERROR, `Failed to add hopper capability ${colorize(LOG_COLORS.BOLD, capability)}:`)}`, err);
          });
          
          const defaultValue = this._getHopperCapabilityDefaultValue(capability);
          await this.setCapabilityValue(capability, defaultValue).catch(err => {
            this.error(`[Capability] ${colorize(LOG_COLORS.ERROR, `Failed to initialize hopper capability ${colorize(LOG_COLORS.BOLD, capability)}:`)}`, err);
          });
          changesMade = true;
          
        } else if (!shouldShowHopper && hasCapability) {
          this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Removing hopper capability: [${capability}]`)}`);
          await this.removeCapability(capability).catch(err => {
            this.error(`[Capability] ${colorize(LOG_COLORS.ERROR, `Failed to remove hopper capability ${colorize(LOG_COLORS.BOLD, capability)}:`)}`, err);
          });
          changesMade = true;
        }
      }
      
      if (changesMade) {
        this.log(`[Capability] ${colorize(LOG_COLORS.SUCCESS, `Hopper capability management completed (mode: ${hopperMode})`)}`);
      }
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to manage hopper capabilities:'), err);
    }
  }

  /**
   * Provides safe default values for hopper capabilities to prevent undefined
   * states when capabilities are dynamically added.
   * @param {string} capability - Capability ID
   * @returns {any} Default value for the capability
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
   * Retrieves robot data from the centralized API session to establish
   * device identity and connection status.
   * @private
   */
  async _fetchRobotData() {
    try {
      const apiSession = this.homey.app.apiSession;
      if (!apiSession) {
        throw new Error('No API session available. Please repair device.');
      }

      const robots = await apiSession.getRobots();
      const robot = robots.find(r => String(r.serial) === String(this.robotSerial));
      
      if (!robot) {
        throw new Error(`Robot with serial ${this.robotSerial} not found`);
      }

      this.robot = robot;
      this.log(colorize(LOG_COLORS.INFO, `Connected to robot: ${this.robot.nickname || this.robot.serial}`));

      await this._updateDeviceSettings(this.robot);

    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to fetch robot data:'), err);
      throw err;
    }
  }

  /**
   * Updates device settings with robot metadata to provide users with
   * device information and firmware status in their preferred format.
   * @param {Object} robot - Robot data
   * @private
   */
  async _updateDeviceSettings(robot) {
    try {
      const settings = this.getSettings();
      const use12hFormat = settings.use_12h_format === '12h';
      
      await this.setSettings({
        device_serial: robot.serial || 'Loading...',
        device_user_id: robot.userId || 'Loading...',
        device_firmware: LR4Data.formatFirmwareVersion(robot) || 'Loading...',
        device_setup_date: robot.setupDateTime ? 
          LR4Data.formatTime(robot.setupDateTime, { use12hFormat }) : 
          'Loading...',
        device_timezone: robot.unitTimezone || 'Loading...'
      }).catch(err => {
        this.error(colorize(LOG_COLORS.ERROR, 'Failed to update device settings:'), err);
      });

      this.log(colorize(LOG_COLORS.INFO, 'Device settings updated with robot information'));
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to update device settings:'), err);
    }
  }

  /**
   * Registers with the centralized DataManager to enable real-time updates
   * and cross-device communication for automation scenarios.
   * @private
   */
  async _registerWithDataManager() {
    try {
      const dataManager = this.homey.app.dataManager;
      if (!dataManager) {
        throw new Error('DataManager not available');
      }

      if (!this.robot) {
        await this._fetchRobotData();
      }

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

      this.log(colorize(LOG_COLORS.INFO, 'Registered with DataManager for centralized data management'));

      this.homey.setTimeout(() => {
        this._requestInitialState();
      }, 5000);
      
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to register with DataManager:'), err);
      throw err;
    }
  }

  /**
   * Requests current robot state to ensure device data is synchronized
   * after registration with the DataManager.
   * @private
   */
  async _requestInitialState() {
    try {
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, LR4Data.Commands.REQUEST_STATE, null, 'litter_robot_4');
      this.log(colorize(LOG_COLORS.INFO, 'Successfully requested initial state from robot'));
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to request initial state:'), err);
    }
  }

  /**
   * Sets up capability listeners to translate user interface actions
   * into robot commands for remote control functionality.
   * @private
   */
  async _registerCapabilityListeners() {
    this.registerCapabilityListener('start_clean_cycle', async () => {
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, LR4Data.Commands.CLEAN_CYCLE, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('start_empty_cycle', async () => {
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, LR4Data.Commands.EMPTY_CYCLE, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('short_reset_press', async () => {
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, LR4Data.Commands.SHORT_RESET_PRESS, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('clean_cycle_wait_time', async (value) => {
      const clumpTime = parseInt(value, 10);
      if (isNaN(clumpTime)) throw new Error(LR4Data.ErrorMessages.INVALID_WAIT_TIME);
      const payload = JSON.stringify({ clumpTime });
      this.log(colorize(LOG_COLORS.COMMAND, `Sending ${LR4Data.Commands.SET_CLUMP_TIME} with payload: ${payload}`));
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, LR4Data.Commands.SET_CLUMP_TIME, payload, 'litter_robot_4');
    });

    this.registerCapabilityListener('night_light_mode', async (value) => {
      let command;
      switch (value) {
        case 'off':  command = LR4Data.Commands.NIGHT_LIGHT_MODE_OFF; break;
        case 'on':   command = LR4Data.Commands.NIGHT_LIGHT_MODE_ON; break;
        case 'auto': command = LR4Data.Commands.NIGHT_LIGHT_MODE_AUTO; break;
        default: throw new Error(LR4Data.ErrorMessages.INVALID_NIGHT_LIGHT_MODE);
      }
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('panel_brightness', async (value) => {
      let command;
      switch (value) {
        case 'low':    command = LR4Data.Commands.PANEL_BRIGHTNESS_LOW; break;
        case 'medium': command = LR4Data.Commands.PANEL_BRIGHTNESS_MEDIUM; break;
        case 'high':   command = LR4Data.Commands.PANEL_BRIGHTNESS_HIGH; break;
        default: throw new Error(LR4Data.ErrorMessages.INVALID_PANEL_BRIGHTNESS);
      }
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('key_pad_lock_out', async (value) => {
      const command = value ? LR4Data.Commands.KEY_PAD_LOCK_OUT_ON : LR4Data.Commands.KEY_PAD_LOCK_OUT_OFF;
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('litter_hopper_enabled', async (value) => {
      this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `LitterHopper enabled capability changed to: ${value}`)}`);
      const command = value ? LR4Data.Commands.ENABLE_HOPPER : LR4Data.Commands.DISABLE_HOPPER;
      this.log(colorize(LOG_COLORS.COMMAND, `Sending command: ${command}`));
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.apiSession.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.log(colorize(LOG_COLORS.INFO, 'Capability listeners registered'));
  }

  /**
   * Processes real-time robot updates to keep device state synchronized
   * with the actual robot status and trigger automation flows.
   * @param {Object} update - Robot update data
   * @private
   */
  async _handleRobotUpdate(update) {
    this.log(colorize(LOG_COLORS.INFO, `Received robot update for ${update.name || update.serial}`));
    
    const previousFirmware = {
      espFirmware: this.robot?.espFirmware,
      picFirmwareVersion: this.robot?.picFirmwareVersion,
      laserBoardFirmwareVersion: this.robot?.laserBoardFirmwareVersion
    };
    
    this.robot = { ...this.robot, ...update };

    await this._updateCapabilities(update);
    
    const hasFirmwareUpdate = (
      (update.espFirmware && update.espFirmware !== previousFirmware.espFirmware) ||
      (update.picFirmwareVersion && update.picFirmwareVersion !== previousFirmware.picFirmwareVersion) ||
      (update.laserBoardFirmwareVersion && update.laserBoardFirmwareVersion !== previousFirmware.laserBoardFirmwareVersion)
    );
    
    if (hasFirmwareUpdate) {
      this._updateDeviceSettings(this.robot);
    }    
  }



  /**
   * Updates device capabilities with current robot data and triggers
   * automation flows when significant changes occur.
   * @param {Object} data - Robot data
   * @private
   */
  async _updateCapabilities(data) {
    if (!data) return;
    
    const settings = this.getSettings();
    const robotData = new LR4Data({ robot: data, settings });
    
    await this._manageHopperCapabilities();
    
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
      ['panel_brightness', robotData.panelBrightness],
      ['alarm_connectivity', !robotData.isOnline],
      ['last_seen', robotData.isOnline ? 'Currently connected' : (robotData.lastSeenFormatted || 'Unknown')]
    ];

    const currentCapabilities = this.getCapabilities();
    if (currentCapabilities.includes('alarm_litter_hopper_empty')) {
      updates.push(
        ['alarm_litter_hopper_empty', robotData.isHopperEmpty],
        ['litter_hopper_status', robotData.hopperStatusDescription],
        ['litter_hopper_enabled', robotData.isHopperEnabled]
      );
    }

    const changes = new Set();
    
    for (const [capability, newValue] of updates) {
      if (newValue === undefined || newValue === null) continue;

      const oldValue = this.getCapabilityValue(capability);
      
      if (oldValue === 'Loading...') {
        this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Initializing capability [${capability}]: ${newValue}`)}`);
        this.setCapabilityValue(capability, newValue).catch(err => {
          this.error(`[Capability] ${colorize(LOG_COLORS.ERROR, `Failed to initialize capability ${colorize(LOG_COLORS.BOLD, capability)}:`)}`, err);
        });
        continue;
      }

      if (newValue !== oldValue) {
        if (capability === 'panel_brightness') {
          this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Panel brightness updated via websocket: ${oldValue} → ${newValue}`)}`);
        }
        
        if (capability === 'night_light_mode') {
          this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Night light mode updated via websocket: ${oldValue} → ${newValue}`)}`);
        }
        
        if (capability === 'clean_cycle_wait_time') {
          this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Clean cycle wait time updated via websocket: ${oldValue} → ${newValue}`)}`);
        }
        
        this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Capability [${capability}] changed: ${oldValue} → ${newValue}`)}`);
        this.setCapabilityValue(capability, newValue).catch(err => {
          this.error(`[Capability] ${colorize(LOG_COLORS.ERROR, `Failed to update capability ${colorize(LOG_COLORS.BOLD, capability)}:`)}`, err);
        });
        changes.add(capability);
      }
    }

    if (changes.size > 0) {
      this._triggerFlowCards(changes, robotData);
    }
  }

  /**
   * Triggers Flows when significant device events occur.
   * @param {Set<string>} changes - Set of changed capabilities
   * @param {LR4Data} robotData - Current robot data
   * @private
   */
  _triggerFlowCards(changes, robotData) {
    if (changes.has('measure_odometer_clean_cycles')) {
      const totalCycles = this.getCapabilityValue('measure_odometer_clean_cycles');
      if (typeof totalCycles === 'number' && totalCycles > 0) {
        const previousCycles = this.getStoreValue('previous_clean_cycles') || 0;
        
        if (totalCycles > previousCycles) {
          this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [clean_cycle_multiple] (${previousCycles} → ${totalCycles})`)}`);
          
          this.homey.flow.getDeviceTriggerCard('clean_cycle_multiple')
            .trigger(this, { total_cycles: totalCycles })
            .catch(err => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger clean_cycle_multiple:'), err));
          
          this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [clean_cycle_finished] (${totalCycles})`)}`);
          this.homey.flow.getDeviceTriggerCard('clean_cycle_finished')
            .trigger(this, { total_clean_cycles: totalCycles })
            .catch(err => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger clean_cycle_finished:'), err));
        }
        
        this.setStoreValue('previous_clean_cycles', totalCycles);
      }
    }


    if (changes.has('alarm_problem')) {
      const hasProblem = robotData.hasProblem;
      if (hasProblem) {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [problem_details_provided] (${robotData.problemDescription})`)}`);
        this.homey.flow.getDeviceTriggerCard('problem_details_provided')
          .trigger(this, {
          problem_description: robotData.problemDescription,
          problem_codes: robotData.problemCodes.join(', '),
          problem_count: robotData.problemCount
          })
          .catch(err => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger problem_details_provided:'), err));
      }
    }
  }

  /**
   * Responds to user preference changes by updating device behavior
   * and refreshing data with new formatting options.
   * @param {Object} oldSettings - Previous settings
   * @param {Object} newSettings - New settings
   */
  async onSettings({ oldSettings, newSettings }) {
    this.log(colorize(LOG_COLORS.SYSTEM, 'Device settings updated'));
    
    if (oldSettings?.litter_hopper_mode !== newSettings?.litter_hopper_mode) {
      this.log(colorize(LOG_COLORS.SYSTEM, `Hopper mode changed: ${oldSettings?.litter_hopper_mode} → ${newSettings?.litter_hopper_mode}`));
      
      await this._manageHopperCapabilitiesWithMode(newSettings.litter_hopper_mode);
      
      try {
        this.log(colorize(LOG_COLORS.INFO, 'Requesting fresh device state after hopper mode change...'));
        if (!this.robot) await this._fetchRobotData();
        await this.homey.app.apiSession.sendCommand(this.robot.serial, LR4Data.Commands.REQUEST_STATE, null, 'litter_robot_4');
      } catch (err) {
        this.error(colorize(LOG_COLORS.ERROR, 'Failed to request state after hopper mode change:'), err);
      }
    }
    
    if (oldSettings?.use_12h_format !== newSettings?.use_12h_format) {
      this.log(colorize(LOG_COLORS.SYSTEM, `Time format changed: ${oldSettings?.use_12h_format} → ${newSettings?.use_12h_format}`));
      
      if (this.robot) {
        this.log(colorize(LOG_COLORS.INFO, 'Re-processing robot data with new time format settings...'));
        await this._updateCapabilities(this.robot);
      }
    }
  }

  /**
   * Performs cleanup to prevent memory leaks and ensure proper
   * resource management when the device is removed.
   */
  onDeleted() {
    this.log(colorize(LOG_COLORS.INFO, 'Device deleted, cleaning up...'));
    
    if (this.robotSerial) {
      const dataManager = this.homey.app.dataManager;
      if (dataManager) {
        dataManager.unregisterDevice(this.robotSerial).catch(err => {
          this.error(colorize(LOG_COLORS.ERROR, 'Error during DataManager cleanup:'), err);
        });
      }
    }
    
    this.log(colorize(LOG_COLORS.SUCCESS, 'Device cleanup completed'));
  }
} 