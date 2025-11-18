const Homey = require('homey');
const LitterRobot3Data = require('../../lib/litterrobot3data');
const { colorize, LOG_COLORS } = require('../../lib/utils');
const { handleCapabilityError } = require('../../lib/notifications');
const { EVENTS } = require('../../lib/event');

/**
 * Litter-Robot 3 device handler that manages robot state, capabilities, and
 * real-time updates via WebSocket connections.
 */
module.exports = class LitterRobot3Device extends Homey.Device {

  /**
   * Initializes device state, establishes WebSocket connection, and registers
   * capability listeners. Sets device availability based on initialization success.
   */
  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing Litter-Robot 3 device...'));

    try {
      const data = this.getData();
      this.robotSerial = data.id;

      if (!this.robotSerial) {
        throw new Error('Invalid device data. Missing robot serial.');
      }

      this.log(colorize(LOG_COLORS.INFO, `Device initialized with robot serial: ${this.robotSerial}`));

      await this._initializeCapabilities();
      await this._fetchRobotData();
      await this._registerCapabilityListeners();
      await this._setupWebSocket();

      this.log(colorize(LOG_COLORS.SUCCESS, 'Device initialization completed successfully'));

      if (this.setAvailable) {
        this.setAvailable();
      }

    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to initialize device:'), err);

      if (this.setUnavailable) {
        this.setUnavailable(err.message);
      }

      throw err;
    }
  }

  /**
   * Initializes capabilities with safe defaults to avoid undefined UI before the first update.
   * @private
   */
  async _initializeCapabilities() {
    const initialCapabilities = {
      onoff: true,
      clean_cycle_status: 'Loading...',
      litter_robot_status: 'Loading...',
      alarm_cat_detected: false,
      alarm_waste_drawer_full: false,
      measure_waste_drawer_level_percentage: null,
      measure_odometer_clean_cycles: null,
      measure_clean_cycles_since_empty: null,
      measure_scoops_saved_count: null,
      cycle_delay: '7',
      alarm_sleep_mode_active: false,
      alarm_sleep_mode_scheduled: false,
      sleep_mode_start_time: 'Not set',
      sleep_mode_end_time: 'Not set',
      alarm_problem: false,
      alarm_connectivity: false,
      last_seen: 'Loading...',
      key_pad_lock_out: false,
      sleep_mode_enabled: false,
      night_light_enabled: false,
    };

    for (const [capability, value] of Object.entries(initialCapabilities)) {
      this.setCapabilityValue(capability, value).catch((err) => {
        handleCapabilityError(err, capability, 'initialize', this);
      });
    }

    this.log(colorize(LOG_COLORS.INFO, 'Capabilities initialized successfully'));
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
        throw new Error('No session available');
      }

      const robots = await session.getRobots();
      const robot = robots.lr3.find((r) => String(r.litterRobotSerial) === String(this.robotSerial));

      if (!robot) {
        throw new Error(`Robot with serial ${this.robotSerial} not found`);
      }

      this.robot = robot;
      this.log(colorize(LOG_COLORS.INFO, `Connected to robot: ${this.robot.litterRobotNickname || this.robot.litterRobotSerial}`));

      const settings = this._getSettingsForRobotData();
      this.robotData = new LitterRobot3Data({
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
   * Gets settings with homeyTimezone for creating LitterRobot3Data instances.
   * homeyTimezone is required by LR3 data class for timezone-aware formatting.
   * @returns {Object} Settings object with homeyTimezone
   * @private
   */
  _getSettingsForRobotData() {
    return {
      ...this.getSettings(),
      homeyTimezone: this.homey.clock.getTimezone(),
    };
  }

  /**
   * Updates settings with robot metadata so device information renders in the user's preferred format.
   * @param {Object} robot - Robot data
   * @private
   */
  async _updateDeviceSettings(robot) {
    try {
      const settings = this.getSettings();
      const use12hFormat = settings.use_12h_format === '12h';

      await this.setSettings({
        device_serial: robot.litterRobotSerial || 'Loading...',
        device_setup_date: LitterRobot3Data.formatTime(robot.setupDate, {
          use12hFormat,
          includeDate: true,
          includeTime: true,
        }) || 'Loading...',
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
        serial: this.robot.litterRobotSerial,
        deviceType: 'litter_robot_3',
      });

      const eventEmitter = session.getEventEmitter();

      this._websocketUnsubscribe = eventEmitter.on(EVENTS.DATA_RECEIVED, (data) => {
        if (data.deviceId === this.robotSerial) {
          // LR3 API wraps data in nested structure; normalize to consistent format
          const normalizedData = data.data.data || data.data;
          this._handleRobotUpdate(normalizedData).catch((err) => {
            this.error(colorize(LOG_COLORS.ERROR, 'Failed to handle robot update:'), err);
          });
        }
      });

      this.log(colorize(LOG_COLORS.SUCCESS, 'WebSocket connection established'));

      this.homey.setTimeout(() => {
        this._requestInitialState();
      }, 5000);
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to setup WebSocket:'), err);
    }
  }

  /**
   * Synchronizes device capabilities with current robot state after WebSocket
   * connection. LR3 lacks a direct state request command, so we fetch robot
   * data instead.
   * @private
   */
  async _requestInitialState() {
    try {
      if (!this.robot) await this._fetchRobotData();
      await this._fetchRobotData();
      if (this.robot) {
        await this._handleRobotUpdate(this.robot);
      }
      this.log(colorize(LOG_COLORS.INFO, 'Successfully synchronized initial state from robot'));
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
      const { robotId } = this.getData();
      await this.homey.app.session.sendCommand(this.robot.litterRobotSerial, LitterRobot3Data.Commands.CLEAN, null, 'litter_robot_3', robotId);
    });

    this.registerCapabilityListener('reset_waste_drawer', async () => {
      if (!this.robot) await this._fetchRobotData();
      const { robotId } = this.getData();

      // Use helper to ensure patch payload matches format expected by flows and UI
      const payload = LitterRobot3Data.buildResetPatch(
        this.robot,
        { ...this.getSettings(), homeyTimezone: this.homey.clock.getTimezone() },
      );

      this.log(`[Drawer Reset] ${colorize(LOG_COLORS.INFO, `Sending PATCH to robot ${robotId} with payload: ${JSON.stringify(payload)}`)}`);
      await this.homey.app.session.patchLR3Robot(robotId, payload);
      this.log(`[Drawer Reset] ${colorize(LOG_COLORS.SUCCESS, 'Waste drawer reset PATCH completed')}`);

      await this._fetchRobotData();
      if (this.robot) {
        await this._handleRobotUpdate(this.robot);
      }
    });

    this.registerCapabilityListener('key_pad_lock_out', async (value) => {
      const command = value ? LitterRobot3Data.Commands.LOCK_ON : LitterRobot3Data.Commands.LOCK_OFF;
      if (!this.robot) await this._fetchRobotData();
      const { robotId } = this.getData();
      await this.homey.app.session.sendCommand(this.robot.litterRobotSerial, command, null, 'litter_robot_3', robotId);
    });

    this.registerCapabilityListener('sleep_mode_enabled', async (value) => {
      if (!this.robot) await this._fetchRobotData();
      const { robotId } = this.getData();

      const payload = LitterRobot3Data.buildSleepModePatch(
        this.robot,
        value,
        { ...this.getSettings(), homeyTimezone: this.homey.clock.getTimezone() },
      );

      this.log(`[Sleep Mode] ${colorize(LOG_COLORS.INFO, `Sending PATCH request to robot ${robotId} with payload: ${JSON.stringify(payload)}`)}`);
      await this.homey.app.session.patchLR3Robot(robotId, payload);
      this.log(`[Sleep Mode] ${colorize(LOG_COLORS.SUCCESS, 'Sleep mode PATCH request completed')}`);
    });

    this.registerCapabilityListener('night_light_enabled', async (value) => {
      const command = value ? LitterRobot3Data.Commands.NIGHT_LIGHT_ON : LitterRobot3Data.Commands.NIGHT_LIGHT_OFF;
      if (!this.robot) await this._fetchRobotData();
      const { robotId } = this.getData();
      await this.homey.app.session.sendCommand(this.robot.litterRobotSerial, command, null, 'litter_robot_3', robotId);
    });

    this.registerCapabilityListener('cycle_delay', async (value) => {
      if (!this.robot) await this._fetchRobotData();
      const { robotId } = this.getData();
      const minutes = parseInt(String(value), 10);
      if (!LitterRobot3Data.Defaults.VALID_WAIT_TIMES.includes(minutes)) {
        throw new Error('Invalid wait time value');
      }
      const hex = minutes.toString(16).toUpperCase();
      const command = `${LitterRobot3Data.Commands.WAIT_TIME}${hex}`;
      await this.homey.app.session.sendCommand(this.robot.litterRobotSerial, command, null, 'litter_robot_3', robotId);
    });

    this.registerCapabilityListener('onoff', async (value) => {
      const command = value ? LitterRobot3Data.Commands.POWER_ON : LitterRobot3Data.Commands.POWER_OFF;
      if (!this.robot) await this._fetchRobotData();
      const { robotId } = this.getData();
      await this.homey.app.session.sendCommand(this.robot.litterRobotSerial, command, null, 'litter_robot_3', robotId);
    });
  }

  /**
   * Processes incoming robot state updates from WebSocket or API calls.
   * Merges partial updates with existing robot data to preserve fields not
   * included in the update.
   * @param {Object} data - Robot state data (may be partial)
   * @private
   */
  async _handleRobotUpdate(data) {
    this.log(colorize(LOG_COLORS.INFO, 'Received robot update:'), JSON.stringify(data, null, 2));

    // Merge partial updates to preserve fields not included in this update
    this.robot = { ...this.robot, ...data };

    try {
      await this._updateCapabilities(this.robot);
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to update capabilities:'), err);
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

    const settings = this._getSettingsForRobotData();

    // Always recreate robotData with current settings to ensure it uses the latest preferences
    // This ensures settings changes (time format, threshold) are immediately reflected
    try {
      this.robotData = new LitterRobot3Data({
        robot: data,
        settings,
      });
    } catch (err) {
      this.error(colorize(LOG_COLORS.WARNING, 'Failed to create robotData instance:'), err);
      return;
    }

    const { robotData } = this;
    const use12hFormat = settings.use_12h_format === '12h';

    // Compute sleep schedule using current user preferences for consistent formatting
    const sleepSchedule = LitterRobot3Data.computeSleepSchedule(data, {
      use12hFormat,
      timezone: this.homey.clock.getTimezone(),
    });

    const updates = [
      ['onoff', robotData.isOnOff],
      ['clean_cycle_status', robotData.cycleStateDescription],
      ['litter_robot_status', robotData.statusDescription],
      ['alarm_cat_detected', robotData.isCatDetected],
      ['alarm_waste_drawer_full', robotData.wasteDrawerLevelPercentage >= settings.waste_drawer_threshold],
      ['measure_waste_drawer_level_percentage', robotData.wasteDrawerLevelPercentage],
      ['measure_odometer_clean_cycles', robotData.totalCleanCycles],
      ['measure_clean_cycles_since_empty', robotData.cycleCount],
      ['measure_scoops_saved_count', robotData.scoopsSavedCount],
      ['cycle_delay', String(robotData.cleanCycleWaitTimeMinutes)],
      ['alarm_sleep_mode_active', robotData.isSleepActive],
      ['alarm_sleep_mode_scheduled', robotData.isSleepScheduled],
      ['sleep_mode_start_time', sleepSchedule?.startString || 'Not set'],
      ['sleep_mode_end_time', sleepSchedule?.endString || 'Not set'],
      ['alarm_problem', robotData.hasProblems],
      ['alarm_connectivity', !robotData.isOnline],
      ['last_seen', robotData.isOnline ? 'Currently connected' : (robotData.lastSeenFormatted || 'Unknown')],
      ['key_pad_lock_out', robotData.isKeypadLocked],
      ['sleep_mode_enabled', robotData.isSleepModeEnabled],
      ['night_light_enabled', robotData.isNightLightActive],
    ];

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
    const sleepSchedule = LitterRobot3Data.computeSleepSchedule(this.robot, {
      use12hFormat,
      timezone: this.homey.clock.getTimezone(),
    });

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
    const robotData = new LitterRobot3Data({
      robot: this.robot,
      settings: this._getSettingsForRobotData(),
    });

    const alarmValue = robotData.wasteDrawerLevelPercentage >= settings.waste_drawer_threshold;
    await this.setCapabilityValue('alarm_waste_drawer_full', alarmValue);
  }

  /**
   * Triggers Homey flow cards based on capability changes to enable user
   * automation. Only triggers for capabilities that actually changed to avoid
   * unnecessary flow executions.
   * @param {Set<string>} changes - Set of changed capability names
   * @param {LitterRobot3Data} robotData - Current robot data instance
   * @private
   */
  _triggerFlowCards(changes, robotData) {
    if (changes.has('clean_cycle_status')) {
      const status = this.getCapabilityValue('clean_cycle_status');
      this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [clean_cycle_status_changed] (${status})`)}`);

      this.homey.flow.getDeviceTriggerCard('LR3_clean_cycle_status_changed')
        .trigger(this, { clean_cycle_status: status })
        .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger clean_cycle_status_changed:'), err));
    }

    if (changes.has('litter_robot_status')) {
      const status = this.getCapabilityValue('litter_robot_status');
      this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [litter_robot_status_changed] (${status})`)}`);

      this.homey.flow.getDeviceTriggerCard('LR3_litter_robot_status_changed')
        .trigger(this, { litter_robot_status: status })
        .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger litter_robot_status_changed:'), err));
    }

    if (changes.has('alarm_cat_detected')) {
      const catDetected = this.getCapabilityValue('alarm_cat_detected');
      if (catDetected) {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, 'Triggering [LR3_alarm_cat_detected_true]')}`);
        this.homey.flow.getDeviceTriggerCard('LR3_alarm_cat_detected_true')
          .trigger(this)
          .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger LR3_alarm_cat_detected_true:'), err));
      } else {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, 'Triggering [LR3_alarm_cat_detected_false]')}`);
        this.homey.flow.getDeviceTriggerCard('LR3_alarm_cat_detected_false')
          .trigger(this)
          .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger LR3_alarm_cat_detected_false:'), err));
      }
    }

    if (changes.has('alarm_waste_drawer_full')) {
      const wasteDrawerFull = this.getCapabilityValue('alarm_waste_drawer_full');
      if (wasteDrawerFull) {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, 'Triggering [LR3_alarm_waste_drawer_full_true]')}`);
        this.homey.flow.getDeviceTriggerCard('LR3_alarm_waste_drawer_full_true')
          .trigger(this)
          .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger LR3_alarm_waste_drawer_full_true:'), err));
      } else {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, 'Triggering [LR3_alarm_waste_drawer_full_false]')}`);
        this.homey.flow.getDeviceTriggerCard('LR3_alarm_waste_drawer_full_false')
          .trigger(this)
          .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger LR3_alarm_waste_drawer_full_false:'), err));
      }
    }

    if (changes.has('alarm_sleep_mode_active')) {
      const sleepActive = this.getCapabilityValue('alarm_sleep_mode_active');
      if (sleepActive) {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, 'Triggering [LR3_alarm_sleep_mode_active_true]')}`);
        this.homey.flow.getDeviceTriggerCard('LR3_alarm_sleep_mode_active_true')
          .trigger(this)
          .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger LR3_alarm_sleep_mode_active_true:'), err));
      } else {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, 'Triggering [LR3_alarm_sleep_mode_active_false]')}`);
        this.homey.flow.getDeviceTriggerCard('LR3_alarm_sleep_mode_active_false')
          .trigger(this)
          .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger LR3_alarm_sleep_mode_active_false:'), err));
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

    // Track clean cycle milestones to enable automation triggers
    if (changes.has('measure_odometer_clean_cycles')) {
      const totalCycles = this.getCapabilityValue('measure_odometer_clean_cycles');
      if (typeof totalCycles === 'number' && totalCycles > 0) {
        const previousCycles = this.getStoreValue('previous_clean_cycles') || 0;

        if (totalCycles > previousCycles) {
          this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [clean_cycle_multiple] (${previousCycles} → ${totalCycles})`)}`);

          this.homey.flow.getDeviceTriggerCard('LR3_clean_cycle_multiple')
            .trigger(this, { total_cycles: totalCycles })
            .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger LR3_clean_cycle_multiple:'), err));

          this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [LR3_clean_cycle_finished] (${totalCycles})`)}`);
          this.homey.flow.getDeviceTriggerCard('LR3_clean_cycle_finished')
            .trigger(this, { total_clean_cycles: totalCycles })
            .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger LR3_clean_cycle_finished:'), err));
        }

        this.setStoreValue('previous_clean_cycles', totalCycles).catch((err) => {
          this.error(colorize(LOG_COLORS.ERROR, 'Failed to update store value for previous_clean_cycles:'), err);
        });
      }
    }

  }

  /**
   * Handles device settings changes, directly updating affected capabilities
   * when time format or waste drawer threshold changes.
   * @param {Object} oldSettings - Previous settings object
   * @param {Object} newSettings - New settings object
   */
  async onSettings({ oldSettings, newSettings }) {
    this.log(colorize(LOG_COLORS.SYSTEM, 'Device settings updated'));

    const timeFormatChanged = oldSettings?.use_12h_format !== newSettings?.use_12h_format;
    const thresholdChanged = oldSettings?.waste_drawer_threshold !== newSettings?.waste_drawer_threshold;

    if (!timeFormatChanged && !thresholdChanged) {
      return;
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
  async onDeleted() {
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
  }
};
