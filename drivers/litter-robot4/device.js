const Homey = require('homey');
const LitterRobot4Data = require('../../lib/litterrobot4data');
const { colorize, LOG_COLORS, handleCapabilityError } = require('../../lib/utils');
const { createCatVisitNotification } = require('../../lib/notifications');
const { EVENTS } = require('../../lib/event');

/**
 * Litter-Robot 4 device handler that manages robot state, capabilities, and
 * real-time updates via WebSocket connections.
 */
module.exports = class LitterRobotDevice extends Homey.Device {

  /**
   * Initializes device state, establishes WebSocket connection, and registers
   * capability listeners. Sets device availability based on initialization success.
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
      await this._registerCapabilityListeners();
      await this._setupWebSocket();

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
   * Initializes capabilities with safe defaults to avoid undefined UI before
   * the first update from the robot.
   * @private
   */
  async _initializeCapabilities() {
    const initialCapabilities = {
      onoff: true,
      clean_cycle_status: 'Loading...',
      litter_robot_status: 'Loading...',
      alarm_cat_detected: false,
      alarm_waste_drawer_full: false,
      alarm_sleep_mode_active: false,
      alarm_sleep_mode_scheduled: false,
      alarm_problem: false,
      alarm_connectivity: false,
      measure_litter_level_percentage: null,
      measure_waste_drawer_level_percentage: null,
      measure_odometer_clean_cycles: null,
      measure_scoops_saved_count: null,
      measure_weight: null,
      clean_cycle_wait_time: null,
      key_pad_lock_out: false,
      night_light_brightness: null,
      sleep_mode_start_time: 'Loading...',
      sleep_mode_end_time: 'Loading...',
      last_seen: 'Loading...',
    };

    for (const [capability, value] of Object.entries(initialCapabilities)) {
      this.setCapabilityValue(capability, value).catch((err) => {
        handleCapabilityError(err, capability, 'initialize', this);
      });
    }

    this.log(colorize(LOG_COLORS.INFO, 'Capabilities initialized successfully'));
  }

  /**
   * Manages hopper capability visibility based on user preferences and hardware
   * detection. Ensures UI matches actual device capabilities.
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
   * Adds or removes hopper capabilities based on user preference mode and hardware
   * detection. Automatic mode shows capabilities only if hopper is detected.
   * @param {string} hopperMode - Hopper mode: 'automatic', 'enabled', or 'disabled'
   * @private
   */
  async _manageHopperCapabilitiesWithMode(hopperMode) {
    try {
      const settings = this.getSettings();
      let robotData = null;

      if (this.robot) {
        if (this.robotData) {
          robotData = this.robotData;
        } else {
          robotData = new LitterRobot4Data({ robot: this.robot, settings });
        }
      }

      const hasHopper = robotData
        ? (robotData.hopperStatus !== null && robotData.hopperStatus !== undefined && !robotData.isHopperRemoved)
        : false;

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
        'litter_hopper_enabled',
      ];

      const currentCapabilities = this.getCapabilities();
      let changesMade = false;

      for (const capability of hopperCapabilities) {
        const hasCapability = currentCapabilities.includes(capability);

        if (shouldShowHopper && !hasCapability) {
          this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Adding hopper capability: [${capability}]`)}`);
          await this.addCapability(capability).catch((err) => {
            handleCapabilityError(err, capability, 'add', this);
          });

          const defaultValue = this._getHopperCapabilityDefaultValue(capability);
          await this.setCapabilityValue(capability, defaultValue).catch((err) => {
            handleCapabilityError(err, capability, 'initialize', this);
          });
          changesMade = true;

        } else if (!shouldShowHopper && hasCapability) {
          this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Removing hopper capability: [${capability}]`)}`);
          await this.removeCapability(capability).catch((err) => {
            handleCapabilityError(err, capability, 'remove', this);
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
   * Returns default values for hopper capabilities when they are dynamically
   * added to prevent undefined states.
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
   * Fetches robot data from the API session to populate device state.
   * Required before WebSocket setup and capability updates since the device
   * needs robot metadata to function.
   * @private
   */
  async _fetchRobotData() {
    try {
      const { session } = this.homey.app;
      if (!session) {
        throw new Error('No session available. Please repair device.');
      }

      const robots = await session.getRobots();
      const robot = robots.lr4.find((r) => String(r.serial) === String(this.robotSerial));

      if (!robot) {
        throw new Error(`Robot with serial ${this.robotSerial} not found`);
      }

      this.robot = robot;
      this.log(colorize(LOG_COLORS.INFO, `Connected to robot: ${this.robot.nickname || this.robot.serial}`));

      const settings = this.getSettings();
      this.robotData = new LitterRobot4Data({
        robot: this.robot,
        settings,
      });

      await this._updateDeviceSettings(this.robot);

    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to fetch robot data:'), err);
      throw err;
    }
  }

  /**
   * Updates device settings with robot metadata so device information renders
   * in the user's preferred format.
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
        device_firmware: LitterRobot4Data.formatFirmwareVersion(robot) || 'Loading...',
        device_setup_date: robot.setupDateTime
          ? LitterRobot4Data.formatTime(robot.setupDateTime, { use12hFormat })
          : 'Loading...',
        device_timezone: robot.unitTimezone || 'Loading...',
      }).catch((err) => {
        this.error(colorize(LOG_COLORS.ERROR, 'Failed to update device settings:'), err);
      });

      this.log(colorize(LOG_COLORS.INFO, 'Device settings updated with robot information'));
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to update device settings:'), err);
    }
  }

  /**
   * Establishes WebSocket connection to receive real-time robot state changes
   * without polling. Registers event listener to process incoming updates.
   * @private
   */
  async _setupWebSocket() {
    try {
      const { session } = this.homey.app;
      if (!session) {
        this.log(colorize(LOG_COLORS.WARNING, 'Session not available, WebSocket setup deferred'));
        return;
      }

      if (!this.robot) {
        await this._fetchRobotData();
      }

      this.log(colorize(LOG_COLORS.INFO, 'Setting up WebSocket connection...'));

      await session.createWebSocket(this.robotSerial, {
        serial: this.robot.serial,
        deviceType: 'litter_robot_4',
      });

      const eventEmitter = session.getEventEmitter();

      const dataHandler = (data) => {
        if (data.deviceId === this.robotSerial) {
          this._handleRobotUpdate(data.data).catch((err) => {
            this.error(colorize(LOG_COLORS.ERROR, 'Failed to handle robot update:'), err);
          });
        }
      };

      eventEmitter.on(EVENTS.DATA_RECEIVED, dataHandler);
      this._websocketUnsubscribe = () => {
        eventEmitter.removeListener(EVENTS.DATA_RECEIVED, dataHandler);
      };

      this.log(colorize(LOG_COLORS.SUCCESS, 'WebSocket connection established'));

      this.homey.setTimeout(() => {
        this._requestInitialState();
      }, 5000);
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to setup WebSocket:'), err);
    }
  }

  /**
   * Requests current robot state after WebSocket connection to synchronize
   * device capabilities with robot state.
   * @private
   */
  async _requestInitialState() {
    try {
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, LitterRobot4Data.Commands.REQUEST_STATE, null, 'litter_robot_4');
      this.log(colorize(LOG_COLORS.INFO, 'Successfully requested initial state from robot'));
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to request initial state:'), err);
    }
  }

  /**
   * Registers capability listeners that translate UI actions into robot commands.
   * @private
   */
  async _registerCapabilityListeners() {
    this.registerCapabilityListener('start_clean_cycle', async () => {
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, LitterRobot4Data.Commands.CLEAN_CYCLE, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('start_empty_cycle', async () => {
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, LitterRobot4Data.Commands.EMPTY_CYCLE, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('short_reset_press', async () => {
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, LitterRobot4Data.Commands.SHORT_RESET_PRESS, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('clean_cycle_wait_time', async (value) => {
      const clumpTime = parseInt(value, 10);
      if (Number.isNaN(clumpTime)) throw new Error(LitterRobot4Data.ErrorMessages.INVALID_WAIT_TIME);
      const payload = JSON.stringify({ clumpTime });
      this.log(colorize(LOG_COLORS.COMMAND, `Sending ${LitterRobot4Data.Commands.SET_CLUMP_TIME} with payload: ${payload}`));
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, LitterRobot4Data.Commands.SET_CLUMP_TIME, payload, 'litter_robot_4');
    });

    this.registerCapabilityListener('night_light_mode', async (value) => {
      let command;
      switch (value) {
        case 'off': command = LitterRobot4Data.Commands.NIGHT_LIGHT_MODE_OFF; break;
        case 'on': command = LitterRobot4Data.Commands.NIGHT_LIGHT_MODE_ON; break;
        case 'auto': command = LitterRobot4Data.Commands.NIGHT_LIGHT_MODE_AUTO; break;
        default: throw new Error(LitterRobot4Data.ErrorMessages.INVALID_NIGHT_LIGHT_MODE);
      }
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('panel_brightness', async (value) => {
      let command;
      switch (value) {
        case 'low': command = LitterRobot4Data.Commands.PANEL_BRIGHTNESS_LOW; break;
        case 'medium': command = LitterRobot4Data.Commands.PANEL_BRIGHTNESS_MEDIUM; break;
        case 'high': command = LitterRobot4Data.Commands.PANEL_BRIGHTNESS_HIGH; break;
        default: throw new Error(LitterRobot4Data.ErrorMessages.INVALID_PANEL_BRIGHTNESS);
      }
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('night_light_brightness', async (value) => {
      let brightness;
      switch (value) {
        case 'low': brightness = 25; break;
        case 'medium': brightness = 50; break;
        case 'high': brightness = 100; break;
        default: throw new Error(LitterRobot4Data.ErrorMessages.INVALID_NIGHT_LIGHT_BRIGHTNESS);
      }
      if (!this.robot) await this._fetchRobotData();

      const payload = JSON.stringify({ nightLightPower: brightness });
      this.log(colorize(LOG_COLORS.COMMAND, `Sending ${LitterRobot4Data.Commands.SET_NIGHT_LIGHT_VALUE} with payload: ${payload}`));
      await this.homey.app.session.sendCommand(this.robot.serial, LitterRobot4Data.Commands.SET_NIGHT_LIGHT_VALUE, payload, 'litter_robot_4');
    });

    this.registerCapabilityListener('key_pad_lock_out', async (value) => {
      const command = value ? LitterRobot4Data.Commands.KEY_PAD_LOCK_OUT_ON : LitterRobot4Data.Commands.KEY_PAD_LOCK_OUT_OFF;
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('litter_hopper_enabled', async (value) => {
      this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `LitterHopper enabled capability changed to: ${value}`)}`);
      const command = value ? LitterRobot4Data.Commands.ENABLE_HOPPER : LitterRobot4Data.Commands.DISABLE_HOPPER;
      this.log(colorize(LOG_COLORS.COMMAND, `Sending command: ${command}`));
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.registerCapabilityListener('onoff', async (value) => {
      const command = value ? LitterRobot4Data.Commands.POWER_ON : LitterRobot4Data.Commands.POWER_OFF;
      if (!this.robot) await this._fetchRobotData();
      await this.homey.app.session.sendCommand(this.robot.serial, command, null, 'litter_robot_4');
    });

    this.log(colorize(LOG_COLORS.INFO, 'Capability listeners registered'));
  }

  /**
   * Processes incoming robot state updates from WebSocket. Merges updates with
   * existing robot data, notifies DataManager of weight changes for pet device
   * synchronization, and updates device settings on firmware changes.
   * @param {Object} update - Robot state data (may be partial)
   * @private
   */
  async _handleRobotUpdate(update) {
    if (!this.homey || !this.homey.app) {
      this.log(colorize(LOG_COLORS.WARNING, 'Device no longer available, skipping robot update'));
      return;
    }

    this.log(colorize(LOG_COLORS.INFO, `Received robot update for ${update.name || update.serial}`));

    const previousWeight = this.robot?.catWeight;
    const previousFirmware = {
      espFirmware: this.robot?.espFirmware,
      picFirmwareVersion: this.robot?.picFirmwareVersion,
      laserBoardFirmwareVersion: this.robot?.laserBoardFirmwareVersion,
    };

    // Merge partial updates to preserve fields not included in this update
    this.robot = { ...this.robot, ...update };

    try {
      await this._updateCapabilities(this.robot);
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to update capabilities:'), err);
      return;
    }

    // Notify DataManager when weight changes to trigger pet device updates
    if (update.catWeight && update.catWeight > 0 && update.catWeight !== previousWeight) {
      const { dataManager, session } = this.homey.app;
      if (dataManager) {
        const robotName = this.robot?.nickname || this.robot?.serial || 'Litter-Robot';

        // Create notification after pet poll completes with fresh pet data
        dataManager.notifyWeightUpdate(update.catWeight, this.robotSerial, (pets) => {
          if (session) {
            createCatVisitNotification(
              update.catWeight,
              robotName,
              dataManager,
              session,
              this.homey,
              pets,
            ).catch((err) => {
              this.error(colorize(LOG_COLORS.ERROR, 'Failed to create cat visit notification:'), err);
            });
          }
        });
      }
    }

    const hasFirmwareUpdate = (
      (update.espFirmware && update.espFirmware !== previousFirmware.espFirmware)
      || (update.picFirmwareVersion && update.picFirmwareVersion !== previousFirmware.picFirmwareVersion)
      || (update.laserBoardFirmwareVersion && update.laserBoardFirmwareVersion !== previousFirmware.laserBoardFirmwareVersion)
    );

    if (hasFirmwareUpdate) {
      this._updateDeviceSettings(this.robot);
    }
  }

  /**
   * Updates device capabilities from robot data and triggers flow cards for
   * changed capabilities. Handles both full and partial updates, computing
   * derived values like sleep schedule and alarm states.
   * @param {Object} data - Robot data (may be partial update from WebSocket)
   * @private
   */
  async _updateCapabilities(data) {
    if (!data) return;

    const settings = this.getSettings();

    // Always recreate robotData with current settings to ensure it uses the latest preferences
    // This ensures settings changes (time format, threshold, hopper mode) are immediately reflected
    try {
      this.robotData = new LitterRobot4Data({
        robot: data,
        settings,
      });
    } catch (err) {
      this.error(colorize(LOG_COLORS.WARNING, 'Failed to create robotData instance:'), err);
      return;
    }

    const { robotData } = this;
    const use12hFormat = settings.use_12h_format === '12h';

    try {
      await this._manageHopperCapabilities();
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to manage hopper capabilities during update:'), err);
    }

    // Compute sleep schedule using current user preferences for consistent formatting
    const sleepSchedule = LitterRobot4Data.computeSleepSchedule(data, { use12hFormat });

    const updates = [
      ['onoff', robotData.isOnOff],
      ['clean_cycle_status', robotData.cycleStateDescription],
      ['litter_robot_status', robotData.statusDescription],
      ['alarm_cat_detected', robotData.isCatDetected],
      ['alarm_waste_drawer_full', robotData.wasteDrawerLevelPercentage >= settings.waste_drawer_threshold],
      ['measure_litter_level_percentage', robotData.litterLevelPercentage],
      ['measure_waste_drawer_level_percentage', robotData.wasteDrawerLevelPercentage],
      ['measure_odometer_clean_cycles', robotData.totalCleanCycles],
      ['measure_scoops_saved_count', robotData.scoopsSavedCount],
      ['alarm_sleep_mode_active', robotData.isSleepActive],
      ['alarm_sleep_mode_scheduled', !!sleepSchedule],
      ['sleep_mode_start_time', sleepSchedule?.startString || 'Not set'],
      ['sleep_mode_end_time', sleepSchedule?.endString || 'Not set'],
      ['measure_weight', robotData.weightInGrams],
      ['alarm_problem', robotData.hasProblems],
      ['clean_cycle_wait_time', robotData.cleanCycleWaitTimeString],
      ['key_pad_lock_out', robotData.isKeypadLocked],
      ['night_light_mode', robotData.nightLightMode],
      ['night_light_brightness', robotData.nightLightBrightnessLevel],
      ['panel_brightness', robotData.panelBrightness],
      ['alarm_connectivity', !robotData.isOnline],
      ['last_seen', robotData.isOnline ? 'Currently connected' : (robotData.lastSeenFormatted || 'Unknown')],
    ];

    const currentCapabilities = this.getCapabilities();
    if (currentCapabilities.includes('alarm_litter_hopper_empty')) {
      updates.push(
        ['alarm_litter_hopper_empty', robotData.isHopperEmpty],
        ['litter_hopper_status', robotData.hopperStatusDescription],
        ['litter_hopper_enabled', robotData.isHopperEnabled],
      );
    }

    const changes = new Set();

    for (const [capability, newValue] of updates) {
      if (newValue === undefined || newValue === null) continue;

      const oldValue = this.getCapabilityValue(capability);

      if (oldValue === 'Loading...') {
        this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Initializing capability [${capability}]: ${newValue}`)}`);
        this.setCapabilityValue(capability, newValue).catch((err) => {
          handleCapabilityError(err, capability, 'initialize', this);
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
        this.setCapabilityValue(capability, newValue).catch((err) => {
          handleCapabilityError(err, capability, 'update', this);
        });
        changes.add(capability);
      }
    }

    if (changes.size > 0) {
      this._triggerFlowCards(changes, robotData);
    }
  }

  /**
   * Updates sleep time capabilities directly when time format changes.
   * Computes sleep schedule with current settings and updates capabilities.
   * @private
   */
  async _updateSleepTimeCapabilities() {
    if (!this.robot) return;

    const settings = this.getSettings();
    const use12hFormat = settings.use_12h_format === '12h';
    const sleepSchedule = LitterRobot4Data.computeSleepSchedule(this.robot, { use12hFormat });

    await this.setCapabilityValue('sleep_mode_start_time', sleepSchedule?.startString || 'Not set');
    await this.setCapabilityValue('sleep_mode_end_time', sleepSchedule?.endString || 'Not set');
  }

  /**
   * Updates waste drawer alarm capability directly when threshold changes.
   * Computes alarm state with current threshold and updates capability.
   * @private
   */
  async _updateWasteDrawerAlarm() {
    if (!this.robot) return;

    const settings = this.getSettings();
    const robotData = new LitterRobot4Data({
      robot: this.robot,
      settings,
    });

    const alarmValue = robotData.wasteDrawerLevelPercentage >= settings.waste_drawer_threshold;
    await this.setCapabilityValue('alarm_waste_drawer_full', alarmValue);
  }

  /**
   * Triggers Homey flow cards based on capability changes to enable user
   * automation. Only triggers for capabilities that actually changed to avoid
   * unnecessary flow executions.
   * @param {Set<string>} changes - Set of changed capability names
   * @param {LitterRobot4Data} robotData - Current robot data instance
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
            .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger clean_cycle_multiple:'), err));

          this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [clean_cycle_finished] (${totalCycles})`)}`);
          this.homey.flow.getDeviceTriggerCard('clean_cycle_finished')
            .trigger(this, { total_clean_cycles: totalCycles })
            .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger clean_cycle_finished:'), err));
        }

        this.setStoreValue('previous_clean_cycles', totalCycles).catch((err) => {
          this.error(colorize(LOG_COLORS.ERROR, 'Failed to update store value for previous_clean_cycles:'), err);
        });
      }
    }

    if (changes.has('alarm_problem')) {
      const { hasProblems } = robotData;
      if (hasProblems) {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [problem_details_provided] (${robotData.problemDescription})`)}`);
        this.homey.flow.getDeviceTriggerCard('problem_details_provided')
          .trigger(this, {
            problem_description: robotData.problemDescription,
            problem_codes: robotData.problemCodes.join(', '),
            problem_count: robotData.problemCount,
          })
          .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger problem_details_provided:'), err));
      }
    }
  }

  /**
   * Handles device settings changes, directly updating affected capabilities
   * when hopper mode, time format, or waste drawer threshold changes.
   * @param {Object} oldSettings - Previous settings object
   * @param {Object} newSettings - New settings object
   */
  async onSettings({ oldSettings, newSettings }) {
    this.log(colorize(LOG_COLORS.SYSTEM, 'Device settings updated'));

    const hopperModeChanged = oldSettings?.litter_hopper_mode !== newSettings?.litter_hopper_mode;
    const timeFormatChanged = oldSettings?.use_12h_format !== newSettings?.use_12h_format;
    const thresholdChanged = oldSettings?.waste_drawer_threshold !== newSettings?.waste_drawer_threshold;

    if (!hopperModeChanged && !timeFormatChanged && !thresholdChanged) {
      return;
    }

    if (hopperModeChanged) {
      this.log(colorize(LOG_COLORS.SYSTEM, `Hopper mode changed: ${oldSettings?.litter_hopper_mode} → ${newSettings?.litter_hopper_mode}`));
      await this._manageHopperCapabilitiesWithMode(newSettings.litter_hopper_mode);

      try {
        this.log(colorize(LOG_COLORS.INFO, 'Requesting fresh device state after hopper mode change...'));
        if (!this.robot) await this._fetchRobotData();
        await this.homey.app.session.sendCommand(this.robot.serial, LitterRobot4Data.Commands.REQUEST_STATE, null, 'litter_robot_4');
      } catch (err) {
        this.error(colorize(LOG_COLORS.ERROR, 'Failed to request state after hopper mode change:'), err);
      }
    }

    if (timeFormatChanged) {
      this.log(colorize(LOG_COLORS.SYSTEM, `Time format changed: ${oldSettings?.use_12h_format} → ${newSettings?.use_12h_format}`));

      if (this.robot) {
        try {
          await this._updateSleepTimeCapabilities();

          this.homey.setTimeout(async () => {
            try {
              await this._updateDeviceSettings(this.robot);
            } catch (err) {
              this.error(colorize(LOG_COLORS.ERROR, 'Failed to update device settings display after time format change:'), err);
            }
          }, 100);
        } catch (err) {
          this.error(colorize(LOG_COLORS.ERROR, 'Failed to update capabilities after time format change:'), err);
        }
      }
    }

    if (thresholdChanged) {
      this.log(colorize(LOG_COLORS.SYSTEM, `Waste drawer threshold changed: ${oldSettings?.waste_drawer_threshold}% → ${newSettings?.waste_drawer_threshold}%`));

      if (this.robot) {
        try {
          await this._updateWasteDrawerAlarm();
        } catch (err) {
          this.error(colorize(LOG_COLORS.ERROR, 'Failed to update capabilities after threshold change:'), err);
        }
      }
    }
  }

  /**
   * Cleans up WebSocket connections and event listeners when device is removed
   * to prevent resource leaks.
   */
  onDeleted() {
    this.log(colorize(LOG_COLORS.INFO, 'Device deleted, cleaning up...'));

    try {
      const { session } = this.homey.app;
      if (session && this.robotSerial) {
        session.closeWebSocket(this.robotSerial);
      }

      if (this._websocketUnsubscribe) {
        this._websocketUnsubscribe();
      }
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Error during WebSocket cleanup:'), err);
    }

    this.log(colorize(LOG_COLORS.SUCCESS, 'Device cleanup completed'));
  }
};
