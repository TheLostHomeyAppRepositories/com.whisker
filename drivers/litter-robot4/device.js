'use strict';

/**
 * LitterRobotDevice integrates with WhiskerApi to manage robot state and real-time updates.
 * @extends Device
 */

const { Device } = require('homey');
const WhiskerApi = require('../../lib/WhiskerApi');
const WhiskerRobot = require('../../lib/WhiskerRobot'); // Import WhiskerRobot for mappings

module.exports = class LitterRobotDevice extends Device {

  /**
   * Initialize device: validate settings, connect to CognitoRobot, and subscribe to updates.
   * @returns {Promise<void>}
   */
  async onInit() {
    this.log('Litter-Robot device initialized');

    const settings = this.getSettings();
    if (!settings || typeof settings !== 'object') {
      throw new Error('Invalid device settings. Please repair device.');
    }
    const { tokens } = settings;
    if (!tokens) {
      throw new Error('Missing authentication tokens or refresh token. Please repair device.');
    }

    this.log('Loaded tokens from settings'); // token values are not logged for security

    this.api = new WhiskerApi({ tokens: { ...tokens } });

    const data = this.getData();
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid device data. Missing robot ID.');
    }
    this.robotId = data.id;
    if (!this.robotId) throw new Error('Missing robot ID');

    try {
      this.robot = await this.api.getRobot(this.robotId);
    } catch (err) {
      this.error('Failed to fetch robot details:', err);
      throw err; // prevent continuing without robot data
    }
    const refreshedTokens = this.api.getTokens();
    if (refreshedTokens) {
      await this.setSettings({ tokens: refreshedTokens });
    }
    this.log('Connected to robot:', this.robot.nickname || this.robot.serial);

    this.updateCapabilities(this.robot);

    // Register capability listeners with explanatory comments
    // Delegate all listeners to helper methods to reduce code duplication and improve error handling
    this.registerCapabilityListener('start_clean_cycle', async () => {
      return this._safeSendCommand('cleanCycle', this.robot.serial, undefined, 'Could not start clean cycle');
    });
    this.registerCapabilityListener('short_reset_press', async () => {
      return this._safeSendCommand('shortResetPress', this.robot.serial, undefined, 'Could not send short reset press');
    });
    this.registerCapabilityListener('start_empty_cycle', async () => {
      return this._safeSendCommand('emptyCycle', this.robot.serial, undefined, 'Could not start empty cycle');
    });
    this.registerCapabilityListener('clean_cycle_wait_time', async (value) => {
      const clumpTime = parseInt(value, 10);
      if (isNaN(clumpTime)) throw new Error('Invalid wait time value');
      const payload = JSON.stringify({ clumpTime });
      this.log('Sending setClumpTime with payload:', payload);
      return this._safeSendCommand('setClumpTime', this.robot.serial, payload, 'Could not set clean cycle wait time');
    });
    this.registerCapabilityListener('panel_brightness', async (value) => {
      let command;
      switch (value) {
        case 'low':    command = 'panelBrightnessLow'; break;
        case 'medium': command = 'panelBrightnessMed'; break;
        case 'high':   command = 'panelBrightnessHigh'; break;
        default: throw new Error('Invalid panel brightness value');
      }
      return this._safeSendCommand(command, this.robot.serial, undefined, 'Could not set panel brightness');
    });
    this.registerCapabilityListener('night_light_mode', async (value) => {
      let command;
      switch (value) {
        case 'off':  command = 'nightLightModeOff'; break;
        case 'on':   command = 'nightLightModeOn'; break;
        case 'auto': command = 'nightLightModeAuto'; break;
        default: throw new Error('Invalid night light mode value');
      }
      return this._safeSendCommand(command, this.robot.serial, undefined, 'Could not set night light mode');
    });
    this.registerCapabilityListener('key_pad_lock_out', async (value) => {
      const command = value ? 'keyPadLockOutOn' : 'keyPadLockOutOff';
      return this._safeSendCommand(command, this.robot.serial, undefined, 'Could not set key pad lock out');
    });

    // Register Flow cards (actions, triggers, and conditions) in a dedicated method for clarity
    this._registerFlowCards();
    
    // All flow card registration moved into _registerFlowCards for separation of concerns

    // (Moved flow trigger logic out of onInit; handled in updateCapabilities or elsewhere)

    try {
      // Subscribe to robot updates and keep handle for cleanup
      this._subscription = await this.api.subscribeToRobotUpdates(
        this.robotId,
        (update) => {
          if (!update) {
            this.error('Received undefined or null update from subscription');
            return;
          }
          this.log('Received update:', update);
          try {
            this.updateCapabilities(update);
          } catch (err) {
            this.error('Failed to update capabilities:', err);
          }
        }
      );

      // Delay sending requestState to ensure WebSocket is active
      setTimeout(() => {
        this.api.sendCommand('requestState', this.robot.serial)
          .then(() => this.log('Sent requestState command after init'))
          .catch(err => this.error('Failed to send requestState:', err));
      }, 3000);
    } catch (err) {
      this.error('Failed to subscribe to robot updates:', err);
      throw err;
    }
  }

  /**
   * Register Flow card listeners for actions, triggers, and conditions.
   * Separated from onInit for improved readability and maintenance.
   * Includes error handling for potentially unregistered cards.
   */
  _registerFlowCards() {
    // Helper to safely get a Flow card and log if not found
    const getCardSafe = (type, id) => {
      try {
        switch (type) {
          case 'action': return this.homey.flow.getActionCard(id);
          case 'trigger': return this.homey.flow.getDeviceTriggerCard(id);
          case 'condition': return this.homey.flow.getConditionCard(id);
        }
      } catch (err) {
        this.error(`Flow card not found: ${type} ${id}`, err);
        return null;
      }
    };

    // Start clean cycle flow card action
    const startCleanCycleCard = getCardSafe('action', 'start_clean_cycle');
    if (startCleanCycleCard) {
      startCleanCycleCard.registerRunListener(async () =>
        this._safeSendCommand('cleanCycle', this.robot.serial, undefined, 'Failed to start cleaning cycle')
      );
    }
    // Short reset press flow card action
    const shortResetPressCard = getCardSafe('action', 'short_reset_press');
    if (shortResetPressCard) {
      shortResetPressCard.registerRunListener(async () =>
        this._safeSendCommand('shortResetPress', this.robot.serial, undefined, 'Failed to send short reset press')
      );
    }
    // Start empty cycle flow card action
    const startEmptyCycleCard = getCardSafe('action', 'start_empty_cycle');
    if (startEmptyCycleCard) {
      startEmptyCycleCard.registerRunListener(async () =>
        this._safeSendCommand('emptyCycle', this.robot.serial, undefined, 'Failed to start empty cycle')
      );
    }

    // Set night light mode via Flow card
    const setNightLightModeCard = getCardSafe('action', 'set_night_light_mode');
    if (setNightLightModeCard) {
      setNightLightModeCard.registerRunListener(async (args) => {
        let command;
        switch (args.mode) {
          case 'off':  command = 'nightLightModeOff'; break;
          case 'on':   command = 'nightLightModeOn'; break;
          case 'auto': command = 'nightLightModeAuto'; break;
          default: throw new Error('Invalid night light mode');
        }
        this.log('Flow card: setting night light mode to', args.mode);
        return this._safeSendCommand(command, this.robot.serial, undefined, 'Failed to set night light mode');
      });
    }
    // Set clean cycle wait time via Flow card
    const setCleanCycleWaitCard = getCardSafe('action', 'set_clean_cycle_wait_time');
    if (setCleanCycleWaitCard) {
      setCleanCycleWaitCard.registerRunListener(async (args) => {
        const clumpTime = parseInt(args.wait_time, 10);
        if (isNaN(clumpTime)) throw new Error('Invalid wait time value');
        const payload = JSON.stringify({ clumpTime });
        this.log('Flow card: setting clean cycle wait time to', clumpTime);
        return this._safeSendCommand('setClumpTime', this.robot.serial, payload, 'Failed to set clean cycle wait time');
      });
    }
    // Set panel brightness via Flow card
    const setPanelBrightnessCard = getCardSafe('action', 'set_panel_brightness');
    if (setPanelBrightnessCard) {
      setPanelBrightnessCard.registerRunListener(async (args) => {
        let command;
        switch (args.brightness) {
          case 'low':    command = 'panelBrightnessLow'; break;
          case 'medium': command = 'panelBrightnessMed'; break;
          case 'high':   command = 'panelBrightnessHigh'; break;
          default: throw new Error('Invalid panel brightness value');
        }
        this.log('Flow card: setting panel brightness to', args.brightness);
        return this._safeSendCommand(command, this.robot.serial, undefined, 'Failed to set panel brightness');
      });
    }

    // Lock keypad via Flow card
    const lockKeypadCard = getCardSafe('action', 'lock_keypad');
    if (lockKeypadCard) {
      lockKeypadCard.registerRunListener(async () =>
        this._safeSendCommand('keyPadLockOutOn', this.robot.serial, undefined, 'Failed to lock keypad')
      );
    }

    // Unlock keypad via Flow card
    const unlockKeypadCard = getCardSafe('action', 'unlock_keypad');
    if (unlockKeypadCard) {
      unlockKeypadCard.registerRunListener(async () =>
        this._safeSendCommand('keyPadLockOutOff', this.robot.serial, undefined, 'Failed to unlock keypad')
      );
    }

    // Trigger flow card for waste drawer full
    const wasteDrawerFullCard = getCardSafe('trigger', 'waste_drawer_full');
    if (wasteDrawerFullCard) {
      wasteDrawerFullCard.registerRunListener(async () => {
        this.log('Flow card triggered: Waste drawer is full');
        return true;
      });
    }
    // Register condition cards with error handling
    const condCards = [
      ['is_cat_detected', () => this.getCapabilityValue('alarm_cat_detected') === true],
      ['is_sleep_mode_active', () => this.getCapabilityValue('alarm_sleep_mode_active') === true],
      ['is_waste_drawer_full', () => this.getCapabilityValue('alarm_waste_drawer_full') === true],
      ['is_sleep_mode_scheduled', () => this.getCapabilityValue('alarm_sleep_mode_scheduled') === true],
      ['is_cleaning_status', (args) => this.getCapabilityValue('clean_cycle_status') === args.status],
    ];
    for (const [cardId, fn] of condCards) {
      const card = getCardSafe('condition', cardId);
      if (card) card.registerRunListener(async (...args) => fn(...args));
    }
  }

  /**
   * Helper to safely send a command to the robot, with error logging and user-friendly error propagation.
   * @param {string} command
   * @param {string} serial
   * @param {any} [payload]
   * @param {string} [userError]
   */
  async _safeSendCommand(command, serial, payload, userError) {
    try {
      await this.api.sendCommand(command, serial, payload);
      this.log(`Sent command: ${command} to ${serial} with payload: ${payload || 'none'}`);
      return true;
    } catch (err) {
      this.error(`Failed to send command: ${command}`, err);
      throw new Error(userError || 'Failed to send command');
    }
  }

  /**
   * Retrieve the previously stored clean cycle count from the device store.
   * @returns {number}
   */
  getPreviousCleanCycleCount() {
    return this.getStoreValue('previous_clean_cycles') || 0;
  }

  /**
   * Store the current clean cycle count in the device store.
   * @param {number} count
   */
  setPreviousCleanCycleCount(count) {
    this.setStoreValue('previous_clean_cycles', count);
  }

  /**
   * Update Homey capabilities based on the robot status payload.
   * Handles undefined or null data gracefully.
   * @param {object} data Robot status information
   */
  updateCapabilities(data) {
    // Debounce/throttle updates if called in rapid succession
    if (this._capUpdateTimeout) clearTimeout(this._capUpdateTimeout);
    this._capUpdateTimeout = setTimeout(() => this._doUpdateCapabilities(data), 100);
  }

  /**
   * Internal implementation of capability update (debounced).
   */
  _doUpdateCapabilities(data) {
    if (!data || typeof data !== 'object') {
      this.error('Invalid data received in updateCapabilities:', data);
      return;
    }

    // Helper for setting capability if changed
    const _setCapabilityIfChanged = (cap, value) => {
      if (this.getCapabilityValue(cap) !== value) {
        this.setCapabilityValue(cap, value).catch(err => this.error(`Failed to set capability ${cap}:`, err));
      }
    };

    // Map measure_odometer_clean_cycles capability from data if present
    if (typeof data.odometerCleanCycles === 'number') {
      _setCapabilityIfChanged('measure_odometer_clean_cycles', data.odometerCleanCycles);
    }
    // Map measure_scoops_saved_count capability from data if present
    if (typeof data.scoopsSavedCount === 'number') {
      _setCapabilityIfChanged('measure_scoops_saved_count', data.scoopsSavedCount);
    }
    // Map measure_litter_level_percentage capability from data if present
    if (typeof data.litterLevelPercentage === 'number') {
      const percentage = Math.round(data.litterLevelPercentage * 100);
      _setCapabilityIfChanged('measure_litter_level_percentage', percentage);
    }
    // Map measure_waste_drawer_level_percentage capability from data if present
    if (typeof data.DFILevelPercent === 'number') {
      _setCapabilityIfChanged('measure_waste_drawer_level_percentage', data.DFILevelPercent);
    }
    // Add clean_cycle_wait_time capability update based on WebSocket data
    if (typeof data.cleanCycleWaitTime === 'number') {
      _setCapabilityIfChanged('clean_cycle_wait_time', String(data.cleanCycleWaitTime));
    }
    // Map panel_brightness capability from data if present
    if (typeof data.panelBrightness === 'string') {
      _setCapabilityIfChanged('panel_brightness', data.panelBrightness.toLowerCase());
    }
    // Map night_light_mode capability from data if present
    if (typeof data.nightLightMode === 'string') {
      _setCapabilityIfChanged('night_light_mode', data.nightLightMode.toLowerCase());
    }
    // Map key_pad_lock_out capability from data if present
    if (typeof data.isKeypadLockout === 'boolean') {
      _setCapabilityIfChanged('key_pad_lock_out', data.isKeypadLockout);
    }

    // Map clean_cycle_status using robotCycleStatus and robotStatus
    // Inline comment: Map robot's cycle status and status code to user-friendly string
    let cleanStatus;
    if (data.robotStatus === 'ROBOT_CAT_DETECT_DELAY') {
      cleanStatus = 'Waiting to start';
    } else if (data.robotCycleStatus === 'CYCLE_DUMP') {
      cleanStatus = 'Scooping';
    } else if (data.robotCycleStatus === 'CYCLE_DFI') {
      cleanStatus = 'Dumping';
    } else if (data.robotCycleStatus === 'CYCLE_LEVEL') {
      cleanStatus = 'Leveling';
    } else if (data.robotCycleStatus === 'CYCLE_HOME') {
      cleanStatus = 'Completed';
    } else if (data.robotCycleStatus === 'CYCLE_IDLE') {
      cleanStatus = 'Idle';
    } else {
      cleanStatus = WhiskerRobot.RobotStatusDescriptions[data.robotStatus] || 'Unknown Status';
    }
    this.log('Mapped clean_cycle_status from robotCycleStatus/robotStatus:', data.robotCycleStatus, data.robotStatus, '=>', cleanStatus);
    _setCapabilityIfChanged('clean_cycle_status', cleanStatus);

    // Map litter_robot_status capability using aggregated statusCode and statusDescription
    // Inline comment: Use WhiskerRobot class to derive status description for display
    if (typeof data === 'object') {
      try {
        const whiskerRobot = new WhiskerRobot({ robot: data, api: this.api });
        const statusCode = whiskerRobot.statusCode;
        const statusDescription = whiskerRobot.statusDescription;
        this.log('Mapped litter_robot_status:', statusCode, '=>', statusDescription);
        _setCapabilityIfChanged('litter_robot_status', statusDescription);
      } catch (err) {
        this.error('Failed to derive litter_robot_status:', err);
      }
    }

    // Check if sleep mode is scheduled for the current day and set alarm_sleep_mode_scheduled
    // Inline comment: Derive if sleep mode is scheduled for today based on robot config and timezone
    if (typeof data.weekdaySleepModeEnabled === 'object' && data.unitTimezone) {
      const daysOfWeek = [
        "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
      ];
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: data.unitTimezone }));
      const todayIdx = now.getDay();
      const todayName = daysOfWeek[todayIdx];
      const todaySchedule = data.weekdaySleepModeEnabled[todayName];
      const isSleepModeScheduled = todaySchedule && todaySchedule.isEnabled === true;
      this.log(`Mapped alarm_sleep_mode_scheduled for ${todayName}:`, isSleepModeScheduled);
      _setCapabilityIfChanged('alarm_sleep_mode_scheduled', isSleepModeScheduled);
    }
    // Map alarm_sleep_mode_active capability from sleepStatus if present
    // Inline comment: Set alarm if robot is currently in sleep mode
    if (typeof data.sleepStatus === 'string') {
      const isSleeping = data.sleepStatus !== 'WAKE';
      this.log('Mapped alarm_sleep_mode_active from sleepStatus:', data.sleepStatus, '=>', isSleeping);
      _setCapabilityIfChanged('alarm_sleep_mode_active', isSleeping);
      // Trigger the sleep_mode_activated flow card only on transition to SLEEPING
      const prevSleepStatus = this.getStoreValue('sleepStatus');
      if (prevSleepStatus !== 'SLEEPING' && data.sleepStatus === 'SLEEPING') {
        this.log('Triggering flow: sleep_mode_activated');
        this.homey.flow
          .getDeviceTriggerCard('sleep_mode_activated')
          .trigger(this, {}, {})
          .catch(err => this.error('Failed to trigger flow sleep_mode_activated:', err));
      }
      // Trigger the sleep_mode_deactivated flow card on transition from SLEEPING to not SLEEPING
      const wasSleeping = this.getStoreValue('sleepStatus');
      if (wasSleeping === 'SLEEPING' && data.sleepStatus !== 'SLEEPING') {
        this.log('Triggering flow: sleep_mode_deactivated');
        this.homey.flow
          .getDeviceTriggerCard('sleep_mode_deactivated')
          .trigger(this, {}, {})
          .catch(err => this.error('Failed to trigger flow sleep_mode_deactivated:', err));
      }
      this.setStoreValue('sleepStatus', data.sleepStatus);
    }

    // -- BEGIN: “Today's sleep start/end” calculation --
    // Inline comment: Calculate today's sleep mode start/end times for display and scheduling
    if (data.unitTimezone && typeof data.weekdaySleepModeEnabled === 'object') {
      try {
        const schedule = data.weekdaySleepModeEnabled;
        const tz = data.unitTimezone; // e.g. "Europe/Amsterdam"
        const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
        const daysOfWeek = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
        const todayName = daysOfWeek[now.getDay()];
        const todayConfig = schedule[todayName];

        if (todayConfig && todayConfig.isEnabled) {
          const sleepMin = parseInt(todayConfig.sleepTime, 10);
          const wakeMin  = parseInt(todayConfig.wakeTime, 10);

          // Use 12H format if user checked the box; otherwise default to 24H
          const use12h = this.getSetting('use_12h_format') === true;

          // Determine date format: US (MM-DD-YYYY) or Euro (DD-MM-YYYY) with '-' delimiter
          const useUSDate = this.getSetting('use_us_date_format') === true;
          // Extract year/month/day in the robot's timezone
          const yearNum  = parseInt(new Date(now.toLocaleString('en-US', { timeZone: tz })).getFullYear(), 10);
          const monthNum = parseInt(new Date(now.toLocaleString('en-US', { timeZone: tz })).getMonth(), 10) + 1;
          const dayNum   = parseInt(new Date(now.toLocaleString('en-US', { timeZone: tz })).getDate(), 10);
          const dayStr   = String(dayNum).padStart(2, '0');
          const monthStr = String(monthNum).padStart(2, '0');
          const yearStr  = String(yearNum);

          let todayDate;
          if (useUSDate) {
            // MM-DD-YYYY
            todayDate = `${monthStr}-${dayStr}-${yearStr}`;
          } else {
            // DD-MM-YYYY
            todayDate = `${dayStr}-${monthStr}-${yearStr}`;
          }
          // Helper to pad minutes
          const pad = (num) => String(num).padStart(2, '0');

          // Compute hour, minute, and period for sleep start
          const sleepHourNum = Math.floor(sleepMin / 60);
          const sleepMinuteNum = sleepMin % 60;
          let sleepHourStr, sleepPeriod;
          if (use12h) {
            sleepPeriod = sleepHourNum < 12 ? 'AM' : 'PM';
            const hour12 = sleepHourNum % 12 === 0 ? 12 : sleepHourNum % 12;
            sleepHourStr = String(hour12);
          } else {
            sleepHourStr = pad(sleepHourNum);
            sleepPeriod = '';
          }
          const sleepMinuteStr = pad(sleepMinuteNum);
          const startTimeStr = use12h
            ? `${sleepHourStr}:${sleepMinuteStr} ${sleepPeriod}`
            : `${sleepHourStr}:${sleepMinuteStr}`;
          const startString = `${todayDate} ${startTimeStr}`;

          // Compute end date
          let endDate;
          if (wakeMin < sleepMin) {
            const tomorrow = new Date(now);
            tomorrow.setDate(now.getDate() + 1);
            const yearNumT  = parseInt(new Date(tomorrow.toLocaleString('en-US', { timeZone: tz })).getFullYear(), 10);
            const monthNumT = parseInt(new Date(tomorrow.toLocaleString('en-US', { timeZone: tz })).getMonth(), 10) + 1;
            const dayNumT   = parseInt(new Date(tomorrow.toLocaleString('en-US', { timeZone: tz })).getDate(), 10);
            const dayStrT   = String(dayNumT).padStart(2, '0');
            const monthStrT = String(monthNumT).padStart(2, '0');
            const yearStrT  = String(yearNumT);

            if (useUSDate) {
              endDate = `${monthStrT}-${dayStrT}-${yearStrT}`;
            } else {
              endDate = `${dayStrT}-${monthStrT}-${yearStrT}`;
            }
          } else {
            endDate = todayDate;
          }

          // Compute hour, minute, and period for wake time
          const wakeHourNum = Math.floor(wakeMin / 60);
          const wakeMinuteNum = wakeMin % 60;
          let wakeHourStr, wakePeriod;
          if (use12h) {
            wakePeriod = wakeHourNum < 12 ? 'AM' : 'PM';
            const hour12 = wakeHourNum % 12 === 0 ? 12 : wakeHourNum % 12;
            wakeHourStr = String(hour12);
          } else {
            wakeHourStr = pad(wakeHourNum);
            wakePeriod = '';
          }
          const wakeMinuteStr = pad(wakeMinuteNum);
          const wakeTimeStr = use12h
            ? `${wakeHourStr}:${wakeMinuteStr} ${wakePeriod}`
            : `${wakeHourStr}:${wakeMinuteStr}`;
          const endString = `${endDate} ${wakeTimeStr}`;

          this.log('Mapped sleep_mode_start_time:', startString, 'sleep_mode_end_time:', endString);
          this.setCapabilityValue('sleep_mode_start_time', startString)
            .catch(err => this.error('Failed to set sleep_mode_start_time:', err));
          this.setCapabilityValue('sleep_mode_end_time', endString)
            .catch(err => this.error('Failed to set sleep_mode_end_time:', err));

          // --- TRIGGER FLOW CARDS for sleep_mode_starts_in and sleep_mode_ends_in ---
          // Store as Date objects for use elsewhere if needed
          this._sleepModeStartTime = new Date(`${todayDate} ${startTimeStr}`);
          this._sleepModeEndTime = new Date(`${endDate} ${wakeTimeStr}`);

          // Trigger sleep_mode_starts_in
          this.homey.flow.getDeviceTriggerCard('sleep_mode_starts_in')
            .trigger(this, {
              amount: Math.round((this._sleepModeStartTime - new Date()) / 60000), // minutes
              unit: 'minutes'
            })
            .catch(err => this.error('Failed to trigger sleep_mode_starts_in:', err));

          // Trigger sleep_mode_ends_in
          this.homey.flow.getDeviceTriggerCard('sleep_mode_ends_in')
            .trigger(this, {
              amount: Math.round((this._sleepModeEndTime - new Date()) / 60000), // minutes
              unit: 'minutes'
            })
            .catch(err => this.error('Failed to trigger sleep_mode_ends_in:', err));
          // --- END TRIGGER FLOW CARDS ---
        } else {
          this.setCapabilityValue('sleep_mode_start_time', 'Not set')
            .catch(err => this.error('Failed to set sleep_mode_start_time:', err));
          this.setCapabilityValue('sleep_mode_end_time', 'Not set')
            .catch(err => this.error('Failed to set sleep_mode_end_time:', err));
        }
      } catch (err) {
        this.error('Error mapping today\'s sleep start/end:', err);
      }
    }
    // -- END: “Today's sleep start/end” calculation --

    // Map alarm_cat_detected capability from status conditions
    // Inline comment: Use robot status and display code to determine if a cat is detected
    try {
      const whiskerRobot = new WhiskerRobot({ robot: data, api: this.api });
      const isCatDetected = data.catDetect === "CAT_DETECT"
        || data.displayCode === "DC_CAT_DETECT"
        || whiskerRobot.statusCode === "CD";
      this.log('Mapped alarm_cat_detected:', isCatDetected);
      _setCapabilityIfChanged('alarm_cat_detected', isCatDetected);
      // Retrieve previous cat detected state
      const prevCatDetected = this.getStoreValue('catDetectedStatus');
      // Trigger "cat_detected" when transitioning from false to true
      if (!prevCatDetected && isCatDetected) {
        this.log('Triggering flow: cat_detected');
        this.homey.flow.getDeviceTriggerCard('cat_detected')
          .trigger(this)
          .catch(err => this.error('Failed to trigger flow card "cat_detected":', err));
      }
      // Trigger "cat_not_detected" when transitioning from true to false
      if (prevCatDetected && !isCatDetected) {
        this.log('Triggering flow: cat_not_detected');
        this.homey.flow.getDeviceTriggerCard('cat_not_detected')
          .trigger(this)
          .catch(err => this.error('Failed to trigger flow card "cat_not_detected":', err));
      }
      // Store the current cat detected state for next update
      this.setStoreValue('catDetectedStatus', isCatDetected);
    } catch (err) {
      this.error('Failed to determine alarm_cat_detected:', err);
    }
    // Map alarm_waste_drawer_full capability based on user-defined threshold
    // Inline comment: Set alarm if drawer level exceeds user threshold and trigger flows on change
    try {
      const threshold = parseInt(this.getSetting('waste_drawer_threshold'), 10) || 85;
      const level = data.DFILevelPercent;
      const alarmWasteDrawerFull = typeof level === 'number' && level >= threshold;
      this.log('Mapped alarm_waste_drawer_full:', alarmWasteDrawerFull, `(Level: ${level}%, Threshold: ${threshold}%)`);
      // Use Homey's capability value as previous value
      const previousWasteDrawerFull = this.getCapabilityValue('alarm_waste_drawer_full');
      if (alarmWasteDrawerFull !== previousWasteDrawerFull) {
        _setCapabilityIfChanged('alarm_waste_drawer_full', alarmWasteDrawerFull);
        if (alarmWasteDrawerFull) {
          this.homey.flow
            .getDeviceTriggerCard('waste_drawer_full')
            .trigger(this)
            .catch(err => this.error('Failed to trigger flow card "waste_drawer_full":', err));
        } else {
          this.homey.flow
            .getDeviceTriggerCard('waste_drawer_not_full')
            .trigger(this)
            .catch(err => this.error('Failed to trigger flow card "waste_drawer_not_full":', err));
        }
      }
    } catch (err) {
      this.error('Failed to determine alarm_waste_drawer_full:', err);
    }

    // Map alarm_problem capability based on error-related status codes
    // Inline comment: Set alarm if robot status code indicates a problem
    try {
      const whiskerRobot = new WhiskerRobot({ robot: data, api: this.api });
      const problemDescriptions = {
        'PF': 'Pinch detect fault',
        'PFR': 'Pinch detect fault during retract',
        'MTR': 'Globe motor fault',
        'MTRB': 'Globe motor fault (backwards)',
        'MTRH': 'Globe motor fault (home)',
        'OTF': 'Over torque fault',
        'OTFTO': 'Over torque fault timeout',
        'LSD': 'Laser dirty',
        'USB': 'USB fault',
      };
      // Support for multiple problems at once (extensible)
      // For now, only whiskerRobot.statusCode is available; adapt if multiple codes are present in future
      const activeProblemCodes = Object.keys(problemDescriptions).filter(code => code === whiskerRobot.statusCode);
      const hasProblem = activeProblemCodes.length > 0;
      this.log('Mapped alarm_problem:', hasProblem, `(Status Code: ${whiskerRobot.statusCode})`);
      _setCapabilityIfChanged('alarm_problem', hasProblem);
      if (hasProblem) {
        const problem_description = problemDescriptions[activeProblemCodes[0]];
        const problem_codes = activeProblemCodes.join(',');
        const problem_count = activeProblemCodes.length;
        this.homey.flow.getDeviceTriggerCard('problem_occurred')
          .trigger(this, {
            problem_description,
            problem_codes,
            problem_count,
          })
          .then(() => {
            this.log('Triggered problem_occurred Flow card with tokens:', {
              problem_description,
              problem_codes,
              problem_count,
            });
          })
          .catch(err => this.error('Failed to trigger Flow card "problem_occurred":', err));
      }
    } catch (err) {
      this.error('Failed to determine alarm_problem:', err);
    }
    // Map measure_weight capability from catWeight (lbs) to grams
    // Inline comment: Convert cat weight from lbs to grams for display
    if (typeof data.catWeight === 'number') {
      const weightGrams = Math.round(data.catWeight * 453.592);
      this.log('Mapped measure_weight from catWeight:', data.catWeight, 'lbs =>', weightGrams, 'g');
      _setCapabilityIfChanged('measure_weight', weightGrams);
    }
  }

  /**
   * Cleanup when device is removed: unsubscribe from updates.
   * @returns {Promise<void>}
   */
  async onDeleted() {
    this.log('Litter-Robot device removed');
    await this.unsubscribeFromRobotUpdates();
  }

  /**
   * Unsubscribe from robot updates safely.
   */
  async unsubscribeFromRobotUpdates() {
    if (this._subscription && typeof this._subscription.unsubscribe === 'function') {
      try {
        this._subscription.unsubscribe();
        this.log('Unsubscribed from robot updates');
      } catch (err) {
        this.error('Error unsubscribing from updates:', err);
      }
    }
  }
};