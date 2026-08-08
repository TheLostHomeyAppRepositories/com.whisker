const WhiskerLitterRobotDevice = require('../WhiskerLitterRobotDevice');
const lr4Api = require('./api');
const {
  Commands, HopperProblemStatuses, HopperStatus, ProblemCodes, SleepStatus,
} = require('./constants');
const lr4State = require('./state');

const {
  computeSleepSchedule,
  deriveStatusCode,
  formatFirmwareVersion,
  formatTime,
  getCleanCycleStatus,
  getCleanCycleWaitTimeString,
  getHopperStatusCode,
  getLitterLevelPercentage,
  getWeightInGrams,
  isCatDetected,
  mapNightLightBrightnessLevel,
  mapNightLightMode,
  mapPanelBrightness,
  resolveDisplaySettings,
} = lr4State;
const {
  notifyCatVisit,
  notifyRobotFault,
  notifyWasteDrawerFull,
} = require('../common/notifications');
const { getRobotDisplayName } = require('../common/utils');

/**
 * Litter-Robot 4 Homey device: GraphQL commands, optional hopper capabilities, and timeline notifications.
 */
module.exports = class WhiskerLitterRobot4Device extends WhiskerLitterRobotDevice {

  static DEVICE_TYPE = 'litter_robot_4';

  /** Fields that jointly determine status codes and alarm capabilities via `deriveStatusCode`. */
  static STATUS_UPDATE_FIELDS = [
    'robotStatus', 'displayCode', 'globeMotorFaultStatus', 'pinchStatus',
    'isBonnetRemoved', 'isDFIFull', 'isCatDetectPending', 'catDetect',
    'isOnline', 'robotCycleStatus', 'unitPowerStatus', 'isLaserDirty', 'USBFaultStatus',
  ];

  /**
   * Migrates capabilities on existing devices before shared init runs.
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    await this._ensureCapabilities();
    await super.onInit();
    if (this._initSucceeded) {
      this.log('Litter-Robot 4 device initialization completed successfully');
    }
  }

  /**
   * Adds capabilities introduced after initial release so existing devices upgrade in place.
   *
   * @returns {Promise<void>}
   */
  async _ensureCapabilities() {
    const migrationCapabilities = [
      'alarm_connectivity',
      'last_seen',
      'onoff',
      'night_light_brightness',
      'measure_weight',
    ];

    for (const capability of migrationCapabilities) {
      if (this.hasCapability(capability)) {
        continue;
      }
      this.log(`Adding migrated capability: [${capability}]`);
      await this.addCapability(capability).catch((err) => {
        this.error(`[Capability] Failed to add capability ${capability}:`, err);
      });
    }
  }

  /**
   * Syncs hopper capability visibility before full refresh because optional capabilities depend on robot state.
   *
   * @param {Object} robot
   * @returns {Promise<void>}
   */
  async _refreshAllCapabilities(robot) {
    await this._syncHopperCapabilities();
    await super._refreshAllCapabilities(robot);
  }

  /**
   * Loads robot state via Litter-Robot 4 GraphQL using the device serial.
   *
   * @param {import('../common/session')} session
   * @returns {Promise<Object>}
   */
  async _fetchRobotSnapshot(session) {
    const snapshot = await lr4Api.getState(session, this.robotSerial);
    if (!snapshot) {
      throw new Error(this.homey.__('errors.robot_not_found', { serial: this.robotSerial }));
    }
    return snapshot;
  }

  /**
   * Routes Homey capability UI changes to Litter-Robot 4 GraphQL commands.
   *
   * @returns {Promise<void>}
   */
  async _registerCapabilityListeners() {
    this.registerCapabilityListener('start_clean_cycle', async () => {
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, Commands.CLEAN_CYCLE, null);
    });

    this.registerCapabilityListener('start_empty_cycle', async () => {
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, Commands.EMPTY_CYCLE, null);
    });

    this.registerCapabilityListener('short_reset_press', async () => {
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, Commands.SHORT_RESET_PRESS, null);
    });

    this.registerCapabilityListener('clean_cycle_wait_time', async (value) => {
      const clumpTime = parseInt(value, 10);
      if (Number.isNaN(clumpTime)) throw new Error(this.homey.__('errors.invalid_wait_time'));
      const payload = JSON.stringify({ clumpTime });
      this.log(`Sending ${Commands.SET_CLUMP_TIME} with payload: ${payload}`);
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, Commands.SET_CLUMP_TIME, payload);
    });

    this.registerCapabilityListener('night_light_mode', async (value) => {
      let command;
      switch (value) {
        case 'off': command = Commands.NIGHT_LIGHT_MODE_OFF; break;
        case 'on': command = Commands.NIGHT_LIGHT_MODE_ON; break;
        case 'auto': command = Commands.NIGHT_LIGHT_MODE_AUTO; break;
        default: throw new Error(this.homey.__('errors.invalid_night_light_mode'));
      }
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, command, null);
    });

    this.registerCapabilityListener('panel_brightness', async (value) => {
      let command;
      switch (value) {
        case 'low': command = Commands.PANEL_BRIGHTNESS_LOW; break;
        case 'medium': command = Commands.PANEL_BRIGHTNESS_MEDIUM; break;
        case 'high': command = Commands.PANEL_BRIGHTNESS_HIGH; break;
        default: throw new Error(this.homey.__('errors.invalid_panel_brightness'));
      }
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, command, null);
    });

    this.registerCapabilityListener('night_light_brightness', async (value) => {
      let brightness;
      switch (value) {
        case 'low': brightness = 25; break;
        case 'medium': brightness = 50; break;
        case 'high': brightness = 100; break;
        default: throw new Error(this.homey.__('errors.invalid_night_light_brightness'));
      }
      await this._ensureRobot();

      const payload = JSON.stringify({ nightLightPower: brightness });
      this.log(`Sending ${Commands.SET_NIGHT_LIGHT_VALUE} with payload: ${payload}`);
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, Commands.SET_NIGHT_LIGHT_VALUE, payload);
    });

    this.registerCapabilityListener('key_pad_lock_out', async (value) => {
      const command = value ? Commands.KEY_PAD_LOCK_OUT_ON : Commands.KEY_PAD_LOCK_OUT_OFF;
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, command, null);
    });

    this.registerCapabilityListener('litter_hopper_enabled', async (value) => {
      this.log(`[Capability] LitterHopper enabled capability changed to: ${value}`);
      const command = value ? Commands.ENABLE_HOPPER : Commands.DISABLE_HOPPER;
      this.log(`Sending command: ${command}`);
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, command, null);
    });

    this.registerCapabilityListener('onoff', async (value) => {
      const command = value ? Commands.POWER_ON : Commands.POWER_OFF;
      await this._ensureRobot();
      await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, command, null);
    });

    this.log('Capability listeners registered');
  }

  /**
   * Requests a fresh GraphQL snapshot after WebSocket connect because subscription payloads
   * can arrive before the first full state frame.
   *
   * @returns {Promise<void>}
   */
  async _requestInitialState() {
    try {
      await lr4Api.sendCommand(
        this.homey.app.session,
        this.robotSerial,
        Commands.REQUEST_STATE,
        null,
      );
      this.log('Requested fresh state from robot after WebSocket connect');
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
      device_serial: robot.serial || this.homey.__('state.loading'),
      device_user_id: robot.userId || this.homey.__('state.loading'),
      device_firmware: formatFirmwareVersion(robot) ?? this.homey.__('state.loading'),
      device_setup_date: robot.setupDateTime
        ? formatTime(robot.setupDateTime, { use12hFormat })
        : this.homey.__('state.loading'),
      device_timezone: robot.unitTimezone || this.homey.__('state.loading'),
    }).catch((err) => this.error('Failed to update device settings:', err));

    this.log('Device settings updated with robot information');
  }

  /**
   * Keeps optional hopper capabilities aligned with user mode and whether hardware reports a hopper.
   *
   * @param {string} [hopperMode]
   * @returns {Promise<void>}
   */
  async _syncHopperCapabilities(hopperMode) {
    const mode = hopperMode ?? this.getSettings().litter_hopper_mode;

    try {
      const hasHopper = Boolean(
        this.robot
        && this.robot.hopperStatus != null
        && !this.robot.isHopperRemoved,
      );

      let shouldShowHopper = false;
      switch (mode) {
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
          this.log(`[Capability] Adding hopper capability: [${capability}]`);
          await this.addCapability(capability).catch((err) => {
            this.error(`[Capability] Failed to add capability ${capability}:`, err);
          });

          if (capability === 'alarm_litter_hopper_empty' || capability === 'litter_hopper_enabled') {
            await this.setCapabilityValue(capability, false).catch((err) => {
              this.error(`[Capability] Failed to initialize capability ${capability}:`, err);
            });
          }

          changesMade = true;

        } else if (!shouldShowHopper && hasCapability) {
          this.log(`[Capability] Removing hopper capability: [${capability}]`);
          await this.removeCapability(capability).catch((err) => {
            this.error(`[Capability] Failed to remove capability ${capability}:`, err);
          });
          changesMade = true;
        }
      }

      if (changesMade) {
        this.log(`[Capability] Hopper capability management completed (mode: ${mode})`);
      }
    } catch (err) {
      this.error('Failed to manage hopper capabilities:', err);
    }
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

    await this._refreshFirmwareSetting(robot, update, from);
  }

  /**
   * Computes shared formatting inputs once per update so handlers avoid repeated schedule math.
   *
   * @param {Object} robot
   * @returns {{ use12hFormat: boolean, wasteDrawerThreshold: number, sleepSchedule: Object|null, wasteDrawerLevel: number|null }}
   */
  _buildRobotUpdateContext(robot) {
    const { use12hFormat, wasteDrawerThreshold } = resolveDisplaySettings(this.getSettings());
    return {
      use12hFormat,
      wasteDrawerThreshold,
      sleepSchedule: computeSleepSchedule(robot, { use12hFormat }),
      wasteDrawerLevel: robot.DFILevelPercent !== undefined ? robot.DFILevelPercent : null,
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
          await this._setCapability('clean_cycle_status', getCleanCycleStatus(robot));
          await this._setCapability('litter_robot_status', deriveStatusCode(robot));
          await this._setCapability('alarm_cat_detected', isCatDetected(robot));
          await this._refreshAlarmProblem(robot);
        },
      },
      {
        fields: ['unitPowerStatus'],
        apply: async (robot) => {
          await this._setCapability('onoff', robot.unitPowerStatus !== 'OFF');
        },
      },
      {
        fields: ['sleepStatus', 'weekdaySleepModeEnabled', 'unitTimezone'],
        apply: async (robot, ctx) => {
          await this._setCapability('alarm_sleep_mode_active', robot.sleepStatus === SleepStatus.SLEEPING);
          await this._setCapability('alarm_sleep_mode_scheduled', !!ctx.sleepSchedule);
          await this._setCapability(
            'sleep_mode_start_time',
            ctx.sleepSchedule?.startString || this.homey.__('state.not_set'),
          );
          await this._setCapability(
            'sleep_mode_end_time',
            ctx.sleepSchedule?.endString || this.homey.__('state.not_set'),
          );
        },
      },
      {
        fields: ['DFILevelPercent', 'isDFIFull'],
        apply: async (robot, ctx) => {
          const { wasteDrawerLevel, wasteDrawerThreshold } = ctx;
          const isFull = typeof wasteDrawerLevel === 'number' && wasteDrawerLevel >= wasteDrawerThreshold;

          if (await this._setCapability('alarm_waste_drawer_full', isFull) && isFull) {
            notifyWasteDrawerFull({
              robotName: (robot.name && String(robot.name).trim()) || this.getName(),
              homey: this.homey,
              enabled: this.getSettings().waste_drawer_full_timeline_notifications !== false,
            }).catch((err) => this.error('Failed to create waste drawer full notification:', err));
          }

          await this._setCapability('measure_waste_drawer_level_percentage', wasteDrawerLevel);
        },
      },
      {
        fields: ['isOnline', 'lastSeen'],
        apply: async (robot, ctx) => {
          await this._setCapability('alarm_connectivity', robot.isOnline !== true);
          await this._setCapability(
            'last_seen',
            robot.isOnline === true
              ? this.homey.__('state.currently_connected')
              : (formatTime(robot.lastSeen, {
                use12hFormat: ctx.use12hFormat,
                timezone: robot.unitTimezone,
              }) || this.homey.__('state.unknown')),
          );
        },
      },
      {
        fields: ['catWeight'],
        apply: async (robot, ctx, update, from) => {
          await this._setCapability('measure_weight', getWeightInGrams(robot));
          notifyCatVisit({
            weight: update.catWeight,
            previousWeight: from?.catWeight,
            robotName: (robot.name && String(robot.name).trim()) || this.getName(),
            homey: this.homey,
            session: this.homey.app.session,
            hasPetDevices: this.homey.app.polling?.hasRegistrants('pets') ?? false,
            enabled: this.getSettings().cat_visit_timeline_notifications !== false,
          }).catch((err) => this.error('Failed to create cat visit notification:', err));
        },
      },
      {
        fields: ['litterLevelPercentage'],
        apply: async (robot) => {
          await this._setCapability('measure_litter_level_percentage', getLitterLevelPercentage(robot));
        },
      },
      {
        fields: ['odometerCleanCycles'],
        apply: async (robot) => {
          if (await this._setCapability('measure_odometer_clean_cycles', robot.odometerCleanCycles || 0)) {
            this._triggerCleanCycleFlowCards();
          }
        },
      },
      {
        fields: ['scoopsSavedCount'],
        apply: async (robot) => {
          await this._setCapability('measure_scoops_saved_count', robot.scoopsSavedCount || null);
        },
      },
      {
        fields: ['cleanCycleWaitTime'],
        apply: async (robot) => {
          await this._setCapability('clean_cycle_wait_time', getCleanCycleWaitTimeString(robot));
        },
      },
      {
        fields: ['isKeypadLockout'],
        apply: async (robot) => {
          await this._setCapability('key_pad_lock_out', robot.isKeypadLockout === true);
        },
      },
      {
        fields: ['nightLightMode'],
        apply: async (robot) => {
          await this._setCapability('night_light_mode', mapNightLightMode(robot));
        },
      },
      {
        fields: ['nightLightBrightness'],
        apply: async (robot) => {
          await this._setCapability('night_light_brightness', mapNightLightBrightnessLevel(robot));
        },
      },
      {
        fields: ['panelBrightnessHigh'],
        apply: async (robot) => {
          await this._setCapability('panel_brightness', mapPanelBrightness(robot));
        },
      },
      {
        fields: ['hopperStatus', 'isHopperRemoved'],
        apply: async (robot) => {
          await this._syncHopperCapabilities();
          await this._refreshAlarmProblem(robot);

          if (!this.hasCapability('alarm_litter_hopper_empty')) {
            return;
          }

          if (await this._setCapability('alarm_litter_hopper_empty', robot.hopperStatus === HopperStatus.EMPTY)) {
            this._triggerFlowCard(
              this.getCapabilityValue('alarm_litter_hopper_empty') ? 'litter_hopper_empty' : 'litter_hopper_not_empty',
            );
          }

          const hopperCode = getHopperStatusCode(robot);
          await this._setCapability('litter_hopper_status', hopperCode || 'UNKNOWN');
          await this._setCapability('litter_hopper_enabled', robot.hopperStatus === HopperStatus.ENABLED);
        },
      },
    ];
  }

  /**
   * Updates the firmware device setting when OTA versions change because firmware is shown in settings, not capabilities.
   *
   * @param {Object} robot
   * @param {Object} update
   * @param {Object} [from]
   * @returns {Promise<void>}
   */
  async _refreshFirmwareSetting(robot, update, from) {
    if (!from) {
      return;
    }

    const hasFirmwareUpdate = (
      (update.espFirmware && update.espFirmware !== from.espFirmware)
      || (update.picFirmwareVersion && update.picFirmwareVersion !== from.picFirmwareVersion)
      || (update.laserBoardFirmwareVersion && update.laserBoardFirmwareVersion !== from.laserBoardFirmwareVersion)
    );

    if (hasFirmwareUpdate) {
      await this._syncDeviceSettings(robot);
    }
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
        sleepStatus: this.robot.sleepStatus,
        weekdaySleepModeEnabled: this.robot.weekdaySleepModeEnabled,
        unitTimezone: this.robot.unitTimezone,
        isOnline: this.robot.isOnline,
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
        DFILevelPercent: this.robot.DFILevelPercent,
        isDFIFull: this.robot.isDFIFull,
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
    const hopperCode = getHopperStatusCode(robot);
    const isProblem = ProblemCodes.includes(statusCode)
      || HopperProblemStatuses.includes(robot.hopperStatus);

    const isHopperFault = hopperCode === 'HMS' || hopperCode === 'HMO' || hopperCode === 'HMD';
    let faultCode = null;
    if (ProblemCodes.includes(statusCode)) {
      faultCode = statusCode;
    } else if (isHopperFault) {
      faultCode = hopperCode;
    }

    if (await this._setCapability('alarm_problem', isProblem) && faultCode) {
      notifyRobotFault({
        robotName: getRobotDisplayName(robot, this.getName()),
        faultCode,
        homey: this.homey,
        enabled: this.getSettings().robot_fault_timeline_notifications !== false,
      }).catch((err) => this.error('Failed to create robot fault notification:', err));
    }
  }

  /**
   * Refreshes derived capabilities when display or hopper settings change because
   * formatting and visible capabilities depend on user preferences and hardware detection.
   *
   * @param {Object} args
   * @returns {Promise<void>}
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('litter_hopper_mode')) {
      this.log(`Hopper mode changed: ${oldSettings?.litter_hopper_mode} → ${newSettings.litter_hopper_mode}`);
      await this._syncHopperCapabilities(newSettings.litter_hopper_mode);

      try {
        this.log('Requesting fresh device state after hopper mode change...');
        await this._ensureRobot();
        await lr4Api.sendCommand(this.homey.app.session, this.robot.serial, Commands.REQUEST_STATE, null);
      } catch (err) {
        this.error('Failed to request state after hopper mode change:', err);
      }
    }

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
