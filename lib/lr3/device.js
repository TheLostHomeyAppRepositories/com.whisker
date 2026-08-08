const WhiskerLitterRobotDevice = require('../WhiskerLitterRobotDevice');
const lr3Api = require('./api');
const { Commands, Defaults, ProblemCodes } = require('./constants');
const lr3State = require('./state');

const {
  buildResetUpdate,
  buildSleepModeUpdate,
  computeSleepSchedule,
  deriveStatusCode,
  formatTime,
  getCleanCycleStatus,
  getCleanCycleWaitTimeMinutes,
  getCycleCount,
  getTotalCleanCycles,
  getWasteDrawerLevelPercentage,
  isCatDetected,
  isOnline,
  isSleepModeEnabled,
  isSleeping,
  resolveDisplaySettings,
} = lr3State;
const { notifyRobotFault } = require('../common/notifications');
const { getRobotDisplayName } = require('../common/utils');

/**
 * Litter-Robot 3 Homey device: REST commands and nested WebSocket envelopes normalized by `_unwrapWsRobotPayload`.
 */
module.exports = class WhiskerLitterRobot3Device extends WhiskerLitterRobotDevice {

  static DEVICE_TYPE = 'litter_robot_3';

  /** Fields that jointly determine status codes and alarm capabilities via `deriveStatusCode`. */
  static STATUS_UPDATE_FIELDS = ['unitStatus', 'powerStatus', 'isManualReset'];

  /**
   * @returns {Promise<void>}
   */
  async onInit() {
    await super.onInit();
    if (this._initSucceeded) {
      this.log('Litter-Robot 3 device initialization completed successfully');
    }
  }

  /**
   * Loads robot state via Litter-Robot 3 REST using the paired `robotId` stored on the device.
   *
   * @param {import('../common/session')} session
   * @returns {Promise<Object>}
   */
  async _fetchRobotSnapshot(session) {
    const { robotId } = this.getData();
    if (!robotId) {
      throw new Error(this.homey.__('errors.invalid_device_data_missing_robot_id'));
    }

    return lr3Api.getRobot(session, robotId);
  }

  /**
   * Routes Homey capability UI changes to Litter-Robot 3 REST commands.
   *
   * @returns {Promise<void>}
   */
  async _registerCapabilityListeners() {
    this.registerCapabilityListener('start_clean_cycle', async () => {
      await this._ensureRobot();
      const { robotId } = this.getData();
      await lr3Api.sendCommand(this.homey.app.session, this.robot.litterRobotSerial, Commands.CLEAN, robotId);
    });

    this.registerCapabilityListener('reset_waste_drawer', async () => {
      await this._ensureRobot();
      const { robotId } = this.getData();

      const payload = buildResetUpdate(
        this.robot,
        { ...this.getSettings(), homeyTimezone: this.homey.clock.getTimezone() },
      );

      this.log(`[Drawer Reset] Sending update to robot ${robotId} with payload: ${JSON.stringify(payload)}`);
      await lr3Api.updateRobot(this.homey.app.session, robotId, payload);
      this.log('[Drawer Reset] Waste drawer reset update completed');

      await this._syncRobot();
      if (this.robot) {
        await this._handleRobotUpdate(this.robot);
      }
    });

    this.registerCapabilityListener('key_pad_lock_out', async (value) => {
      const command = value ? Commands.LOCK_ON : Commands.LOCK_OFF;
      await this._ensureRobot();
      const { robotId } = this.getData();
      await lr3Api.sendCommand(this.homey.app.session, this.robot.litterRobotSerial, command, robotId);
    });

    this.registerCapabilityListener('sleep_mode_enabled', async (value) => {
      await this._ensureRobot();
      const { robotId } = this.getData();

      const payload = buildSleepModeUpdate(
        this.robot,
        value,
        { ...this.getSettings(), homeyTimezone: this.homey.clock.getTimezone() },
      );

      this.log(`[Sleep Mode] Sending update request to robot ${robotId} with payload: ${JSON.stringify(payload)}`);
      await lr3Api.updateRobot(this.homey.app.session, robotId, payload);
      this.log('[Sleep Mode] Sleep mode update request completed');
    });

    this.registerCapabilityListener('night_light_enabled', async (value) => {
      const command = value ? Commands.NIGHT_LIGHT_ON : Commands.NIGHT_LIGHT_OFF;
      await this._ensureRobot();
      const { robotId } = this.getData();
      await lr3Api.sendCommand(this.homey.app.session, this.robot.litterRobotSerial, command, robotId);
    });

    this.registerCapabilityListener('cycle_delay', async (value) => {
      await this._ensureRobot();
      const { robotId } = this.getData();
      const minutes = parseInt(String(value), 10);
      if (!Defaults.VALID_WAIT_TIMES.includes(minutes)) {
        throw new Error(this.homey.__('errors.invalid_wait_time'));
      }
      const hex = minutes.toString(16).toUpperCase();
      const command = `${Commands.WAIT_TIME}${hex}`;
      await lr3Api.sendCommand(this.homey.app.session, this.robot.litterRobotSerial, command, robotId);
    });

    this.registerCapabilityListener('onoff', async (value) => {
      const command = value ? Commands.POWER_ON : Commands.POWER_OFF;
      await this._ensureRobot();
      const { robotId } = this.getData();
      await lr3Api.sendCommand(this.homey.app.session, this.robot.litterRobotSerial, command, robotId);
    });
  }

  /**
   * Refreshes capabilities once after WebSocket connect when live updates may lag.
   *
   * @returns {Promise<void>}
   */
  async _requestInitialState() {
    try {
      await this._ensureRobot();
      await this._handleRobotUpdate(this.robot);
      this.log('Successfully refreshed initial state from robot');
    } catch (err) {
      this.error('Failed to request initial state:', err);
    }
  }

  /**
   * Mirrors robot metadata into device settings for the info panel.
   *
   * @param {Object} robot
   * @param {Object} [settings]
   * @returns {Promise<void>}
   */
  async _syncDeviceSettings(robot, settings = this.getSettings()) {
    const { use12hFormat } = resolveDisplaySettings(settings);

    await this.setSettings({
      device_serial: robot.litterRobotSerial || this.homey.__('state.loading'),
      device_setup_date: formatTime(robot.setupDate, {
        use12hFormat,
        includeDate: true,
        includeTime: true,
      }) || this.homey.__('state.loading'),
    });

    this.log('Device settings updated with robot information');
  }

  /**
   * Litter-Robot 3 WebSocket frames are full envelopes ({ type, data }); unwrap before merging state.
   *
   * @param {Object} update
   * @returns {Promise<void>}
   */
  async _handleRobotUpdate(update) {
    return super._handleRobotUpdate(this._unwrapWsRobotPayload(update));
  }

  /**
   * Normalizes nested Litter-Robot 3 WebSocket envelopes before the shared merge path runs.
   *
   * @param {{ data?: { data?: Object } | Object } | Object} payload
   * @returns {Object|undefined}
   */
  _unwrapWsRobotPayload(payload) {
    if (payload && typeof payload === 'object' && 'data' in payload && !('litterRobotSerial' in payload)) {
      const d = payload.data;
      return d?.data ?? d;
    }
    return payload;
  }

  /**
   * Applies capability updates only for fields present in a partial WebSocket payload.
   *
   * @param {Object} context
   * @param {Object} context.robot
   * @param {Object} context.update
   * @param {Object} [context.from]
   * @returns {Promise<void>}
   */
  async _applyRobotUpdate({ robot, update, from }) {
    const ctx = this._buildRobotUpdateContext(robot);

    for (const handler of this._robotUpdateHandlers()) {
      if (handler.fields.some((field) => field in update)) {
        await handler.apply(robot, ctx, update, from);
      }
    }
  }

  /**
   * Computes shared formatting inputs once per update so handlers avoid repeated schedule math.
   *
   * @param {Object} robot
   * @returns {{ use12hFormat: boolean, wasteDrawerThreshold: number, homeyTimezone: string, sleepSchedule: Object|null, wastePct: number, scoopsSaved: number|null }}
   */
  _buildRobotUpdateContext(robot) {
    const { use12hFormat, wasteDrawerThreshold, homeyTimezone } = resolveDisplaySettings({
      ...this.getSettings(),
      homeyTimezone: this.homey.clock.getTimezone(),
    });
    const scoops = parseInt(robot.scoopsSavedCount, 10);

    return {
      use12hFormat,
      wasteDrawerThreshold,
      homeyTimezone,
      sleepSchedule: computeSleepSchedule(robot, { use12hFormat, timezone: homeyTimezone }),
      wastePct: getWasteDrawerLevelPercentage(robot),
      scoopsSaved: Number.isNaN(scoops) ? null : scoops,
    };
  }

  /**
   * Declarative map from robot payload fields to capability refresh handlers.
   *
   * @returns {Array<{ fields: string[], apply: Function }>}
   */
  _robotUpdateHandlers() {
    return [
      {
        fields: this.constructor.STATUS_UPDATE_FIELDS,
        apply: async (robot) => {
          await this._setCapability('onoff', robot.unitStatus !== 'OFF');
          await this._setCapability('clean_cycle_status', getCleanCycleStatus(robot));
          await this._setCapability('litter_robot_status', deriveStatusCode(robot));
          await this._setCapability('alarm_cat_detected', isCatDetected(robot));
          await this._refreshAlarmProblem(robot);
        },
      },
      {
        fields: ['sleepModeActive', 'sleepModeTime'],
        apply: async (robot, ctx) => {
          await this._setCapability('alarm_sleep_mode_active', isSleeping(robot));
          await this._setCapability('alarm_sleep_mode_scheduled', isSleepModeEnabled(robot));
          await this._setCapability(
            'sleep_mode_start_time',
            ctx.sleepSchedule?.startString || this.homey.__('state.not_set'),
          );
          await this._setCapability(
            'sleep_mode_end_time',
            ctx.sleepSchedule?.endString || this.homey.__('state.not_set'),
          );
          await this._setCapability('sleep_mode_enabled', isSleepModeEnabled(robot));
        },
      },
      {
        fields: ['cycleCount', 'cycleCapacity', 'unitStatus', 'scoopsSavedCount'],
        apply: async (robot, ctx, update) => {
          await this._setCapability('measure_waste_drawer_level_percentage', ctx.wastePct);
          await this._setCapability('alarm_waste_drawer_full', ctx.wastePct >= ctx.wasteDrawerThreshold);
          if ('scoopsSavedCount' in update) {
            await this._setCapability('measure_scoops_saved_count', ctx.scoopsSaved);
          }
        },
      },
      {
        fields: ['cycleCount'],
        apply: async (robot) => {
          await this._setCapability('measure_clean_cycles_since_empty', getCycleCount(robot));
        },
      },
      {
        fields: ['powerStatus', 'lastSeen'],
        apply: async (robot, ctx) => {
          await this._setCapability('alarm_connectivity', !isOnline(robot));
          await this._setCapability(
            'last_seen',
            isOnline(robot)
              ? this.homey.__('state.currently_connected')
              : (formatTime(robot.lastSeen, {
                use12hFormat: ctx.use12hFormat,
                timezone: ctx.homeyTimezone,
              }) || this.homey.__('state.unknown')),
          );
        },
      },
      {
        fields: ['panelLockActive'],
        apply: async (robot) => {
          await this._setCapability('key_pad_lock_out', robot.panelLockActive === '1');
        },
      },
      {
        fields: ['nightLightActive'],
        apply: async (robot) => {
          await this._setCapability('night_light_enabled', robot.nightLightActive === '1');
        },
      },
      {
        fields: ['cleanCycleWaitTimeMinutes'],
        apply: async (robot) => {
          await this._setCapability('cycle_delay', String(getCleanCycleWaitTimeMinutes(robot)));
        },
      },
      {
        fields: ['totalCycleCount'],
        apply: async (robot) => {
          if (await this._setCapability('measure_odometer_clean_cycles', getTotalCleanCycles(robot))) {
            this._triggerCleanCycleFlowCards();
          }
        },
      },
    ];
  }

  /**
   * Re-runs sleep handlers after 12h/24h change because formatted time strings depend on the setting.
   *
   * @returns {Promise<void>}
   */
  async _refreshSleepCapabilities() {
    if (!this.robot) return;

    await this._applyRobotUpdate({
      robot: this.robot,
      update: {
        sleepModeActive: this.robot.sleepModeActive,
        sleepModeTime: this.robot.sleepModeTime,
        powerStatus: this.robot.powerStatus,
        lastSeen: this.robot.lastSeen,
      },
    });
  }

  /**
   * Re-runs drawer handlers after threshold change because the full alarm compares against user setting.
   *
   * @returns {Promise<void>}
   */
  async _refreshWasteDrawerCapabilities() {
    if (!this.robot) return;

    await this._applyRobotUpdate({
      robot: this.robot,
      update: {
        cycleCount: this.robot.cycleCount,
        cycleCapacity: this.robot.cycleCapacity,
        unitStatus: this.robot.unitStatus,
      },
    });
  }

  /**
   * Refreshes alarm_problem and posts a timeline notification when a new fault appears.
   *
   * @param {Object} robot
   * @returns {Promise<void>}
   */
  async _refreshAlarmProblem(robot) {
    const statusCode = deriveStatusCode(robot);
    const isProblem = ProblemCodes.includes(statusCode);

    if (await this._setCapability('alarm_problem', isProblem) && isProblem) {
      notifyRobotFault({
        robotName: getRobotDisplayName(robot, this.getName()),
        faultCode: statusCode,
        homey: this.homey,
        enabled: this.getSettings().robot_fault_timeline_notifications !== false,
      }).catch((err) => this.error('Failed to create robot fault notification:', err));
    }
  }

  /**
   * Refreshes derived capabilities when display settings change because formatting
   * depends on user preferences rather than robot payload alone.
   *
   * @param {Object} args
   * @returns {Promise<void>}
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('use_12h_format')) {
      this.log(`Time format changed: ${oldSettings?.use_12h_format} → ${newSettings.use_12h_format}`);

      if (this.robot) {
        try {
          await this._refreshSleepCapabilities();
          const { robot } = this;
          this.homey.setTimeout(() => {
            this._syncDeviceSettings(robot).catch((err) => {
              this.error('Failed to update device settings after time format change:', err);
            });
          }, 0);
        } catch (err) {
          this.error('Failed to refresh capabilities after time format change:', err);
        }
      }
    }

    if (changedKeys.includes('waste_drawer_threshold')) {
      this.log(`Waste drawer threshold changed: ${oldSettings?.waste_drawer_threshold}% → ${newSettings.waste_drawer_threshold}%`);

      if (this.robot) {
        try {
          await this._refreshWasteDrawerCapabilities();
        } catch (err) {
          this.error('Failed to refresh capabilities after threshold change:', err);
        }
      }
    }
  }
};
