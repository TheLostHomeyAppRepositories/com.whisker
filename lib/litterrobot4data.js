'use strict';

/**
 * LitterRobot4Data is a comprehensive data wrapper for Litter-Robot 4 devices.
 * Focuses purely on data interpretation, formatting, and status mapping.
 * Based on pylitterbot patterns and GraphQL schema.
 * 
 * This class handles all data transformation, status interpretation,
 * and formatting for Litter-Robot 4 devices without any API calls.
 */
class LitterRobot4Data {
  // ============================================================================
  // CONSTANTS AND CONFIGURATION
  // ============================================================================

  /** Default configuration values */
  static Defaults = Object.freeze({
    DEBOUNCE_DELAY: 100,
    WEBSOCKET_INIT_DELAY: 3000,
    LBS_TO_GRAMS: 453.59237,
    DEFAULT_WASTE_DRAWER_THRESHOLD: 80,
    DEFAULT_TIMEZONE: 'UTC',
    VALID_WAIT_TIMES: [3, 5, 7, 15, 30]
  });

  // ============================================================================
  // COMPREHENSIVE ENUM DEFINITIONS (from GraphQL schema and pylitterbot)
  // ============================================================================

  /** Robot Status Enum - from GraphQL RobotStatusEnum */
  static RobotStatus = Object.freeze({
    NONE: 'NONE',
    ROBOT_POWER_OFF: 'ROBOT_POWER_OFF',
    ROBOT_POWER_UP: 'ROBOT_POWER_UP',
    ROBOT_POWER_DOWN: 'ROBOT_POWER_DOWN',
    ROBOT_IDLE: 'ROBOT_IDLE',
    ROBOT_BONNET: 'ROBOT_BONNET',
    ROBOT_CAT_DETECT: 'ROBOT_CAT_DETECT',
    ROBOT_CAT_DETECT_DELAY: 'ROBOT_CAT_DETECT_DELAY',
    ROBOT_SET_CLUMP_TIME: 'ROBOT_SET_CLUMP_TIME',
    ROBOT_SET_NIGHT_LIGHT: 'ROBOT_SET_NIGHT_LIGHT',
    ROBOT_CLEAN: 'ROBOT_CLEAN',
    ROBOT_EMPTY: 'ROBOT_EMPTY',
    ROBOT_CAT_RELEASE: 'ROBOT_CAT_RELEASE',
    ROBOT_FIND_DUMP: 'ROBOT_FIND_DUMP',
    ROBOT_CHANGE_FILTER: 'ROBOT_CHANGE_FILTER',
    ROBOT_SCALE_CAL: 'ROBOT_SCALE_CAL',
    ROBOT_SCALE_RECAL: 'ROBOT_SCALE_RECAL',
    ROBOT_SCALE_TOF_OTA: 'ROBOT_SCALE_TOF_OTA',
    ROBOT_SCALE_AUX_MOR: 'ROBOT_SCALE_AUX_MOR',
    ROBOT_OPS_AUDIT_MODE: 'ROBOT_OPS_AUDIT_MODE',
    ROBOT_KEYPAD_TEST: 'ROBOT_KEYPAD_TEST'
  });

  /** Robot Cycle Status Enum - from GraphQL RobotCycleStatusEnum */
  static RobotCycleStatus = Object.freeze({
    NONE: 'NONE',
    CYCLE_PENDING: 'CYCLE_PENDING',
    CYCLE_IDLE: 'CYCLE_IDLE',
    CYCLE_DUMP: 'CYCLE_DUMP',
    CYCLE_DFI: 'CYCLE_DFI',
    CYCLE_LEVEL: 'CYCLE_LEVEL',
    CYCLE_HOME: 'CYCLE_HOME',
    CYCLE_EMPTY: 'CYCLE_EMPTY',
    CYCLE_EMPTY_HOME: 'CYCLE_EMPTY_HOME',
    CYCLE_EMPTY_ABORT: 'CYCLE_EMPTY_ABORT',
    CYCLE_CAT_RELEASE: 'CYCLE_CAT_RELEASE',
    CYCLE_CAT_REL_DFI: 'CYCLE_CAT_REL_DFI',
    CYCLE_CAT_REL_LEVEL: 'CYCLE_CAT_REL_LEVEL',
    CYCLE_FIND_DUMP: 'CYCLE_FIND_DUMP',
    CYCLE_COMPLETE: 'CYCLE_COMPLETE',
    CYCLE_CHANGE_FILTER: 'CYCLE_CHANGE_FILTER',
    CYCLE_CHANGE_FILTER2: 'CYCLE_CHANGE_FILTER2'
  });

  /** Robot Cycle State Enum - from GraphQL RobotCycleStateEnum */
  static RobotCycleState = Object.freeze({
    NONE: 'NONE',
    CYCLE_STATE_NONE: 'CYCLE_STATE_NONE',
    CYCLE_STATE_WAIT_ON: 'CYCLE_STATE_WAIT_ON',
    CYCLE_STATE_PROCESS: 'CYCLE_STATE_PROCESS',
    CYCLE_STATE_WAIT_OFF: 'CYCLE_STATE_WAIT_OFF',
    CYCLE_STATE_CAT_DETECT: 'CYCLE_STATE_CAT_DETECT',
    CYCLE_STATE_CAT_DETECT_DWR: 'CYCLE_STATE_CAT_DETECT_DWR',
    CYCLE_STATE_BONNET: 'CYCLE_STATE_BONNET',
    CYCLE_STATE_INIT: 'CYCLE_STATE_INIT',
    CYCLE_STATE_IDLE: 'CYCLE_STATE_IDLE',
    CYCLE_STATE_PAUSE: 'CYCLE_STATE_PAUSE',
    CYCLE_STATE_RESET: 'CYCLE_STATE_RESET',
    CYCLE_STATE_FAULT_RETRY: 'CYCLE_STATE_FAULT_RETRY',
    CYCLE_STATE_DELAY_1: 'CYCLE_STATE_DELAY_1',
    CYCLE_STATE_DELAY_2: 'CYCLE_STATE_DELAY_2',
    CYCLE_STATE_DELAY_3: 'CYCLE_STATE_DELAY_3',
    CYCLE_STATE_FAULT_1: 'CYCLE_STATE_FAULT_1',
    CYCLE_STATE_FAULT_2: 'CYCLE_STATE_FAULT_2',
    CYCLE_STATE_FAULT_3: 'CYCLE_STATE_FAULT_3',
    CYCLE_STATE_FAULT_UV: 'CYCLE_STATE_FAULT_UV',
    CYCLE_STATE_FAULT_OT_AMP: 'CYCLE_STATE_FAULT_OT_AMP',
    CYCLE_STATE_FAULT_OT_SLOPE: 'CYCLE_STATE_FAULT_OT_SLOPE',
    CYCLE_STATE_FAULT_PINCH: 'CYCLE_STATE_FAULT_PINCH',
    CYCLE_STATE_FAULT_PAUSE: 'CYCLE_STATE_FAULT_PAUSE'
  });

  /** Display Code Enum - from GraphQL DisplayCodeEnum */
  static DisplayCode = Object.freeze({
    NONE: 'NONE',
    DC_BD_SCALE_CAL: 'DC_BD_SCALE_CAL',
    DC_BD_PINCH: 'DC_BD_PINCH',
    DC_BD_MOTOR: 'DC_BD_MOTOR',
    DC_BD_GM_TOF: 'DC_BD_GM_TOF',
    DC_BD_HALL: 'DC_BD_HALL',
    DC_BD_DRAWER: 'DC_BD_DRAWER',
    DC_BONNET_OFF: 'DC_BONNET_OFF',
    DC_CAT_DETECT_30M: 'DC_CAT_DETECT_30M',
    DC_CAT_DETECT: 'DC_CAT_DETECT',
    DC_CAT_DETECT_DWR: 'DC_CAT_DETECT_DWR',
    DC_CAT_DETECT_PINCH: 'DC_CAT_DETECT_PINCH',
    DC_USER_PAUSE: 'DC_USER_PAUSE',
    DC_MTR_FAULT_PINCH: 'DC_MTR_FAULT_PINCH',
    DC_MTR_FAULT_UV: 'DC_MTR_FAULT_UV',
    DC_MTR_FAULT_OT_AMP: 'DC_MTR_FAULT_OT_AMP',
    DC_MTR_FAULT_OT_SLP: 'DC_MTR_FAULT_OT_SLP',
    DC_CYCLE_TIMEOUT: 'DC_CYCLE_TIMEOUT',
    DC_SET_CLUMP_TIME: 'DC_SET_CLUMP_TIME',
    DC_SET_NIGHT_LIGHT: 'DC_SET_NIGHT_LIGHT',
    DC_TOF_CAL: 'DC_TOF_CAL',
    DC_TOF_CAL_FAIL: 'DC_TOF_CAL_FAIL',
    DC_TOF_CAL_PASS: 'DC_TOF_CAL_PASS',
    DC_MODE_CYCLE: 'DC_MODE_CYCLE',
    DC_DFI_FULL: 'DC_DFI_FULL',
    DC_MODE_IDLE: 'DC_MODE_IDLE',
    DC_EST_TOF_LIMITS: 'DC_EST_TOF_LIMITS',
    DC_KEYPAD_TEST: 'DC_KEYPAD_TEST',
    DC_USB_FAULT: 'DC_USB_FAULT',
    DC_BD_SCALE_ZERO: 'DC_BD_SCALE_ZERO',
    DCX_SUSPEND: 'DCX_SUSPEND',
    DCX_REFRESH: 'DCX_REFRESH',
    DCX_LAMP_TEST: 'DCX_LAMP_TEST',
    DCX_ESP_FW_UPDATE: 'DCX_ESP_FW_UPDATE',
    DCX_CONFIRM: 'DCX_CONFIRM',
    DCX_LOCKOUT_KEYHIT: 'DCX_LOCKOUT_KEYHIT',
    DCX_CAL_SCALE: 'DCX_CAL_SCALE'
  });

  /** Night Light Mode Enum - from GraphQL NightLightModeEnum */
  static NightLightMode = Object.freeze({
    OFF: 'OFF',
    ON: 'ON',
    AUTO: 'AUTO'
  });

  /** Sleep Status Enum - from GraphQL SleepStatusEnum */
  static SleepStatus = Object.freeze({
    NONE: 'NONE',
    WAKE: 'WAKE',
    SLEEPING: 'SLEEPING'
  });

  /** Unit Power Status Enum - from GraphQL UnitPowerStatusEnum */
  static UnitPowerStatus = Object.freeze({
    NONE: 'NONE',
    ON: 'ON',
    OFF: 'OFF'
  });

  /** Unit Power Type Enum - from GraphQL UnitPowerTypeEnum */
  static UnitPowerType = Object.freeze({
    NONE: 'NONE',
    AC: 'AC',
    DC: 'DC'
  });

  /** Cat Detect Enum - from GraphQL CatDetectEnum */
  static CatDetect = Object.freeze({
    CAT_DETECT_CLEAR: 'CAT_DETECT_CLEAR',
    CAT_DETECT_LASER_CLEAR: 'CAT_DETECT_LASER_CLEAR',
    CAT_DETECT_LASER_SET: 'CAT_DETECT_LASER_SET',
    CAT_DETECT_SCALE_CLEAR: 'CAT_DETECT_SCALE_CLEAR',
    CAT_DETECT_SCALE_SET: 'CAT_DETECT_SCALE_SET',
    CAT_DETECT_DRAWER_CLEAR: 'CAT_DETECT_DRAWER_CLEAR',
    CAT_DETECT_DRAWER_SET: 'CAT_DETECT_DRAWER_SET',
    CAT_DETECT_RESET_CANCELLED: 'CAT_DETECT_RESET_CANCELLED',
    CAT_DETECT_RESET_PAUSED: 'CAT_DETECT_RESET_PAUSED',
    CAT_DETECT_RESET_HOME: 'CAT_DETECT_RESET_HOME',
    CAT_DETECT_STUCK: 'CAT_DETECT_STUCK',
    CAT_DETECT_STUCK_LASER: 'CAT_DETECT_STUCK_LASER',
    CAT_DETECT_STUCK_WEIGHT: 'CAT_DETECT_STUCK_WEIGHT'
  });

  /** Litter Level State Enum - from GraphQL LitterLevelStateEnum */
  static LitterLevelState = Object.freeze({
    OVERFILL: 'OVERFILL',
    OPTIMAL: 'OPTIMAL',
    REFILL: 'REFILL',
    LOW: 'LOW',
    EMPTY: 'EMPTY'
  });

  /** Hopper Status Enum - from GraphQL HopperStatusEnum */
  static HopperStatus = Object.freeze({
    ENABLED: 'ENABLED',
    DISABLED: 'DISABLED',
    MOTOR_FAULT_SHORT: 'MOTOR_FAULT_SHORT',
    MOTOR_OT_AMPS: 'MOTOR_OT_AMPS',
    MOTOR_DISCONNECTED: 'MOTOR_DISCONNECTED',
    EMPTY: 'EMPTY'
  });

  /** Days of week for sleep schedule calculations */
  static DAYS_OF_WEEK = Object.freeze([
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
  ]);

  // ============================================================================
  // STATUS MAPPINGS (from pylitterbot patterns)
  // ============================================================================

  /** Mapping of raw robotStatus codes to LitterBoxStatus (from pylitterbot) */
  static LR4_STATUS_MAP = Object.freeze({
    "ROBOT_CAT_DETECT": "CD",
    "ROBOT_CAT_DETECT_DELAY": "CST",
    "ROBOT_CLEAN": "CCP",
    "ROBOT_IDLE": "RDY",
    "ROBOT_POWER_DOWN": "PWRD",
    "ROBOT_POWER_OFF": "OFF",
    "ROBOT_POWER_UP": "PWRU"
  });

  /** Mapping of hopper status codes to short letter codes */
  static HOPPER_STATUS_MAP = Object.freeze({
    "ENABLED": "HE",
    "DISABLED": "HD",
    "MOTOR_FAULT_SHORT": "HMS",
    "MOTOR_OT_AMPS": "HMO",
    "MOTOR_DISCONNECTED": "HMD",
    "EMPTY": "HEM"
  });

  /** Mapping of derived status codes to human-readable descriptions */
  static StatusDescriptions = Object.freeze({
    BR: "Bonnet removed",
    CCC: "Cleaning cycle complete",
    CCP: "Cleaning cycle in progress",
    CD: "Cat detected",
    CSF: "Cat sensor fault",
    CSI: "Cat sensor interrupted",
    CST: "Cat sensor timing",
    DF1: "Drawer almost full - 2 cycles left",
    DF2: "Drawer almost full - 1 cycle left",
    DF3: "Drawer almost full - 3+ cycles left",
    DFS: "Drawer full",
    DHF: "Dump + home position fault",
    DPF: "Dump position fault",
    EC: "Emptying cycle",
    HPF: "Home position fault",
    OFF: "Off",
    OFFLINE: "Offline",
    OTF: "Over torque fault",
    P: "Clean cycle paused",
    PD: "Pinch detected",
    PPD: "Potential pinch detected",
    PWRD: "Powering down",
    PWRU: "Powering up",
    RDY: "Ready",
    SCF: "Cat sensor fault at startup",
    SDF: "Drawer full at startup",
    SPF: "Pinch detect at startup",
    UNKNOWN: "Unknown status",
    //LitterHopper status descriptions
    HD: "Disabled",
    HE: "Enabled",
    HEM: "Empty",
    HMD: "Motor disconnected",
    HMO: "Motor overload",
    HMS: "Motor fault (short circuit)"
  });

  /** Problem code → description map */
  static ProblemDescriptions = Object.freeze({
    PD: 'Pinch detected',
    PF: 'Pinch detect fault',
    PFR: 'Pinch detect fault during retract',
    MTR: 'Globe motor fault',
    MTRB: 'Globe motor fault (backwards)',
    MTRH: 'Globe motor fault (home)',
    OTF: 'Over torque fault',
    OTFTO: 'Over torque fault timeout',
    LSD: 'Laser dirty',
    USB: 'USB fault',
    // LitterHopper problems
    HOPPER_MOTOR_FAULT_SHORT: 'Hopper motor fault (short)',
    HOPPER_MOTOR_OT_AMPS: 'Hopper motor overload',
    HOPPER_MOTOR_DISCONNECTED: 'Hopper motor disconnected',
    HOPPER_EMPTY: 'Hopper empty'
  });

  /** Command mappings for Litter-Robot 4 (from pylitterbot LitterRobot4Command) */
  static Commands = Object.freeze({
    CLEAN_CYCLE: 'cleanCycle',
    KEY_PAD_LOCK_OUT_OFF: 'keyPadLockOutOff',
    KEY_PAD_LOCK_OUT_ON: 'keyPadLockOutOn',
    NIGHT_LIGHT_MODE_AUTO: 'nightLightModeAuto',
    NIGHT_LIGHT_MODE_OFF: 'nightLightModeOff',
    NIGHT_LIGHT_MODE_ON: 'nightLightModeOn',
    PANEL_BRIGHTNESS_LOW: 'panelBrightnessLow',
    PANEL_BRIGHTNESS_MEDIUM: 'panelBrightnessMed',
    PANEL_BRIGHTNESS_HIGH: 'panelBrightnessHigh',
    POWER_OFF: 'powerOff',
    POWER_ON: 'powerOn',
    REQUEST_STATE: 'requestState',
    SET_CLUMP_TIME: 'setClumpTime',
    SET_NIGHT_LIGHT_VALUE: 'setNightLightValue',
    SHORT_RESET_PRESS: 'shortResetPress',
    // LitterHopper commands
    ENABLE_HOPPER: 'enableHopper',
    DISABLE_HOPPER: 'disableHopper'
  });

  /** Error messages for better consistency and maintenance */
  static ErrorMessages = Object.freeze({
    INVALID_ROBOT_DATA: 'Invalid robot data provided. Robot data must be an object.',
    MISSING_ROBOT_ID: 'Robot data is missing required unitId field.',
    INVALID_SETTINGS: 'Invalid device settings. Please repair device.',
    INVALID_WAIT_TIME: 'Invalid wait time value',
    INVALID_PANEL_BRIGHTNESS: 'Invalid panel brightness value',
    INVALID_NIGHT_LIGHT_MODE: 'Invalid night light mode value'
  });

  // ============================================================================
  // CONSTRUCTOR AND INITIALIZATION
  // ============================================================================

  /**
   * Creates a new LitterRobot4Data instance
   * @param {Object} params
   * @param {Object} params.robot - Robot state object from API
   * @param {Object} [params.settings={}] - Optional settings for formatting
   * @throws {Error} If required parameters are missing or invalid
   */
  constructor({ robot, settings = {} } = {}) {
    // Validate required parameters
    if (!robot || typeof robot !== 'object') {
      throw new Error(LitterRobot4Data.ErrorMessages.INVALID_ROBOT_DATA);
    }

    this._robot = robot;
    this._settings = {
      use12hFormat: false,
      useUSDate: false,
      waste_drawer_threshold: LitterRobot4Data.Defaults.DEFAULT_WASTE_DRAWER_THRESHOLD,
      ...settings
    };

    // Convert dropdown value to boolean for backward compatibility
    if (this._settings.use_12h_format === '12h') {
      this._settings.use12hFormat = true;
    } else if (this._settings.use_12h_format === '24h') {
      this._settings.use12hFormat = false;
    } else if (typeof this._settings.use_12h_format === 'boolean') {
      // Handle legacy boolean values for backward compatibility
      this._settings.use12hFormat = this._settings.use_12h_format;
    }

    // Cache frequently accessed values for performance
    this._cachedStatusCode = null;
    this._cachedSleepSchedule = null;
    this._lastRobotHash = this._computeRobotHash();
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Computes a simple hash of robot data for change detection
   * @private
   * @returns {string} Hash string
   */
  _computeRobotHash() {
    const keyProps = [
      'robotStatus', 'displayCode', 'catDetect', 'isOnline', 
      'robotCycleStatus', 'pinchStatus', 'hopperStatus', 'isHopperRemoved'
    ];
    return keyProps.map(prop => this._robot[prop]).join('|');
  }

  /**
   * Checks if robot data has changed and invalidates cache if needed
   * @private
   */
  _invalidateCacheIfNeeded() {
    const currentHash = this._computeRobotHash();
    if (currentHash !== this._lastRobotHash) {
      this._cachedStatusCode = null;
      this._cachedSleepSchedule = null;
      this._lastRobotHash = currentHash;
    }
  }

  // ============================================================================
  // FORMATTING METHODS
  // ============================================================================

  /**
   * Generic formatter for Date objects with consistent options
   * @param {Date} dateObj - A valid Date instance
   * @param {Object} opts - Formatting options
   * @param {boolean} [opts.use12hFormat=false] - When true, output 12-hour with AM/PM
   * @param {boolean} [opts.forceUSDate=false] - When true, forces MM-DD-YYYY ordering
   * @returns {string} Formatted date string or 'Invalid date'
   */
  static formatDateForDisplay(dateObj, { use12hFormat = false } = {}) {
    if (!(dateObj instanceof Date) || isNaN(dateObj)) {
      return 'Invalid date';
    }

    return dateObj.toLocaleString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: use12hFormat
    });
  }

  /**
   * Primary time formatter that handles both ISO strings and minutes from midnight
   * This is the main method for all time/date formatting in the app.
   * @param {string|number} timeInput - Either ISO string or minutes from midnight
   * @param {Object} opts - Formatting options
   * @param {boolean} [opts.use12hFormat=false] - When true, output 12-hour with AM/PM
   * @param {boolean} [opts.forceUSDate=false] - When true, forces MM-DD-YYYY ordering
   * @param {string} [opts.timezone] - Timezone for conversion
   * @param {Date} [opts.baseDate] - Base date for minutes-from-midnight conversion
   * @returns {string|null} Formatted time string or null if invalid
   */
  static formatTime(timeInput, { 
    use12hFormat = false, 
    timezone = null, 
    baseDate = null 
  } = {}) {
    if (!timeInput) return null;
    
    let dateObj;
    
    if (typeof timeInput === 'string') {
      // Handle ISO string (like lastSeen) - these are in UTC
      dateObj = new Date(timeInput);
      if (isNaN(dateObj)) return null;

      // If timezone is provided, format in that timezone
      if (timezone) {
        return dateObj.toLocaleString('en-US', {
          timeZone: timezone,
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: use12hFormat
        });
      }
    } else if (typeof timeInput === 'number') {
      // Handle minutes from midnight (like sleep times)
      const minutes = Math.floor(timeInput);
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      
      const base = baseDate || new Date();
      
      if (timezone) {
        // Create date in the specified timezone
        const tzDate = new Date(base.toLocaleString('en-US', { timeZone: timezone }));
        dateObj = new Date(tzDate);
        dateObj.setHours(hours, mins, 0, 0);
      } else {
        // No timezone specified, use local time
        dateObj = new Date(base);
        dateObj.setHours(hours, mins, 0, 0);
      }
    } else {
      return null;
    }
    
    return LitterRobot4Data.formatDateForDisplay(dateObj, { use12hFormat });
  }

  /**
   * Format firmware version to match Whisker app format
   * @param {Object} robot - Robot data object
   * @returns {string} Formatted firmware version (e.g., "1175.5021.292")
   */
  static formatFirmwareVersion(robot) {
    try {
      const { espFirmware, picFirmwareVersion, laserBoardFirmwareVersion } = robot;
      
      if (!espFirmware || !picFirmwareVersion || !laserBoardFirmwareVersion) {
        return 'Loading...';
      }

      // Extract version numbers from firmware strings
      const espVersion = espFirmware.replace(/\./g, ''); // "1.1.75" -> "1175"
      
      // Extract from PIC firmware: "10500.3072.2.92" -> "292" (last two parts combined)
      const picParts = picFirmwareVersion.split('.');
      const picVersion = picParts.length >= 2 ? 
        picParts[picParts.length - 2] + picParts[picParts.length - 1] : 
        picParts[picParts.length - 1]; // "2" + "92" = "292"
      
      // Extract from laser board firmware: "5.0.2.1" -> "5021"
      const laserVersion = laserBoardFirmwareVersion.replace(/\./g, ''); // "5.0.2.1" -> "5021"
      
      // Combine in Whisker app format: "1175.5021.292"
      return `${espVersion}.${laserVersion}.${picVersion}`;
    } catch (err) {
      return 'Error parsing firmware';
    }
  }

  // ============================================================================
  // STATUS CODE DERIVATION
  // ============================================================================

  /**
   * Derive the official Whisker status code from raw robot payload
   * Uses priority-based logic matching the native Whisker app
   * @param {Object} robot - Raw robot state object
   * @returns {string} Two/three-letter status code
   */
  static deriveStatusCode(robot) {
    if (!robot || typeof robot !== 'object') return 'UNKNOWN';

    // Destructure once for performance
    const {
      robotStatus, displayCode, globeMotorFaultStatus, pinchStatus,
      isBonnetRemoved, isDFIFull, isCatDetectPending, catDetect, 
      isOnline, robotCycleStatus, unitPowerStatus, isLaserDirty, USBFaultStatus
    } = robot;

    // Priority 1: HARD faults (motor/mechanical issues)
    if (globeMotorFaultStatus === 'FAULT_DUMP_POSITION' || 
        globeMotorFaultStatus === 'DUMP_POSITION_FAULT') return 'DPF';
    if (globeMotorFaultStatus === 'FAULT_HOME_POSITION' || 
        globeMotorFaultStatus === 'HOME_POSITION_FAULT') return 'HPF';
    if (typeof globeMotorFaultStatus === 'string' && 
        globeMotorFaultStatus.includes('FAULT') && 
        globeMotorFaultStatus !== 'FAULT_CLEAR') return 'DHF';
    if (globeMotorFaultStatus === 'FAULT_OVER_TORQUE') return 'OTF';

    // Priority 2: Pinch detect issues
    if (pinchStatus === 'PINCH_DETECT_STARTUP') return 'SPF';
    if (pinchStatus === 'PINCH_DETECT' || pinchStatus === 'PINCH_DETECT_FAULT') return 'PD';
    if (pinchStatus === 'SWITCH_1_SET' || pinchStatus === 'SWITCH_2_SET') return 'PPD';
    if (pinchStatus === 'SWITCH_FAULT_1' || pinchStatus === 'SWITCH_FAULT_2') return 'PD';

    // Priority 3: Cat sensor faults
    if (catDetect === 'CAT_SENSOR_FAULT_STARTUP') return 'SCF';
    if (isDFIFull && robotCycleStatus === 'CYCLE_STARTUP') return 'SDF';
    if (isCatDetectPending || catDetect === 'CAT_DETECT_FAULT' || 
        catDetect === 'CAT_SENSOR_FAULT') return 'CSF';
    if (typeof catDetect === 'string' && catDetect.includes('FAULT')) return 'CSF';

    // Priority 4: Cat detected / timing
    if (catDetect === 'CAT_DETECT_INTERRUPTED') return 'CSI';
    if (catDetect === 'CAT_DETECT_TIMING') return 'CST';
    if (catDetect === 'CAT_DETECT') return 'CD';

    // Priority 5: Connectivity / power
    if (isOnline === false) return 'OFFLINE';
    if (unitPowerStatus === 'OFF') return 'OFF';
    if (unitPowerStatus === 'POWERING_DOWN') return 'PWRD';
    if (unitPowerStatus === 'POWERING_UP') return 'PWRU';

    // Priority 6: Misc single-flag faults
    if (isLaserDirty === true) return 'LSD';
    if (typeof USBFaultStatus === 'string' && USBFaultStatus !== 'CLEAR') return 'USB';

    // Priority 7: Drawer / bonnet states
    if (isBonnetRemoved) return 'BR';
    if (isDFIFull) return 'DFS';

    // Priority 8: Cycle / cleaning
    if (robotCycleStatus === 'CYCLE_DUMP' || 
        robotCycleStatus === 'CYCLE_DFI' || 
        robotCycleStatus === 'CYCLE_LEVEL') return 'CCP';
    if (robotStatus === 'ROBOT_CYCLE_COMPLETE' || 
        robotCycleStatus === 'CYCLE_HOME') return 'CCC';
    if (robotCycleStatus === 'CYCLE_PAUSED') return 'P';

    // Priority 9: Idle fallback with displayCode tweaks
    if (robotStatus === 'ROBOT_IDLE') {
      if (displayCode === 'DC_BONNET_REMOVED') return 'BR';
      if (displayCode === 'DC_DRAWER_FULL') return 'DFS';
      if (displayCode === 'DC_CAT_DETECT') return 'CD';
      return 'RDY';
    }

    // Priority 10: Display-code specific
    if (displayCode === 'DC_MODE_CYCLE') return 'EC';

    // Default fallback
    return 'RDY';
  }

  // ============================================================================
  // STATIC HELPER METHODS
  // ============================================================================

  /**
   * Derive a user-friendly clean cycle status string
   * @param {Object} robot - Robot status payload
   * @returns {string} Human-readable status
   */
  static getCleanCycleStatus(robot) {
    if (!robot) return 'Unknown Status';
    
    const { robotStatus, robotCycleStatus } = robot;
    
    if (robotStatus === 'ROBOT_CAT_DETECT_DELAY') {
      return 'Waiting to start';
    }
    
    switch (robotCycleStatus) {
      case 'CYCLE_DUMP': return 'Scooping';
      case 'CYCLE_DFI': return 'Dumping';
      case 'CYCLE_LEVEL': return 'Leveling';
      case 'CYCLE_HOME': return 'Completed';
      case 'CYCLE_IDLE': return 'Idle';
      default:
        return LitterRobot4Data.StatusDescriptions[robotStatus] || 'Unknown Status';
    }
  }

  /**
   * Determine if a cat is detected based on robot data
   * @param {Object} robot - Robot data object
   * @returns {boolean} True if cat is detected
   */
  static isCatDetected(robot) {
    if (!robot) return false;
    
    const statusCode = LitterRobot4Data.deriveStatusCode(robot);
    return robot.catDetect === 'CAT_DETECT' ||
           robot.displayCode === 'DC_CAT_DETECT' ||
           statusCode === 'CD';
  }

  /**
   * Determine if there is a connectivity problem
   * @param {Object} robot - Robot data object
   * @returns {boolean} True if robot is offline
   */
  static hasConnectivityProblem(robot) {
    return typeof robot?.isOnline === 'boolean' ? !robot.isOnline : false;
  }

  /**
   * Analyze problem status and return meta info
   * @param {Object} robot - Robot data object
   * @returns {Object} Problem analysis object
   */
  static analyzeProblem(robot) {
    const statusCode = LitterRobot4Data.deriveStatusCode(robot);
    const problemDescriptions = LitterRobot4Data.ProblemDescriptions;
    const activeCodes = Object.keys(problemDescriptions).filter(c => c === statusCode);
    
    // Check for hopper-related problems
    const hopperStatus = robot.hopperStatus;
    if (hopperStatus) {
      switch (hopperStatus) {
        case LitterRobot4Data.HopperStatus.MOTOR_FAULT_SHORT:
          activeCodes.push('HOPPER_MOTOR_FAULT_SHORT');
          break;
        case LitterRobot4Data.HopperStatus.MOTOR_OT_AMPS:
          activeCodes.push('HOPPER_MOTOR_OT_AMPS');
          break;
        case LitterRobot4Data.HopperStatus.MOTOR_DISCONNECTED:
          activeCodes.push('HOPPER_MOTOR_DISCONNECTED');
          break;
        case LitterRobot4Data.HopperStatus.EMPTY:
          activeCodes.push('HOPPER_EMPTY');
          break;
      }
    }
    
    return {
      hasProblem: activeCodes.length > 0,
      codes: activeCodes,
      description: activeCodes.length ? problemDescriptions[activeCodes[0]] : null
    };
  }

  /**
   * Compute today's sleep mode start/end times and formatted strings
   * @param {Object} robot - Robot payload containing timezone & sleep settings
   * @param {Object} opts - Formatting options
   * @param {boolean} [opts.use12hFormat=false] - 12-hour time display
   * @param {boolean} [opts.useUSDate=false] - US date format
   * @returns {Object|null} Sleep schedule object or null if not enabled
   */
  static computeSleepSchedule(robot, { use12hFormat = false } = {}) {
    if (!robot?.unitTimezone || typeof robot.weekdaySleepModeEnabled !== 'object') {
      return null;
    }

    try {
      const schedule = robot.weekdaySleepModeEnabled;
      const tz = robot.unitTimezone;
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const todayName = LitterRobot4Data.DAYS_OF_WEEK[now.getDay()];
      const todayConfig = schedule[todayName];
      
      if (!todayConfig || !todayConfig.isEnabled) return null;

      const sleepMin = parseInt(todayConfig.sleepTime, 10);
      const wakeMin = parseInt(todayConfig.wakeTime, 10);

      // Format start time
      const startString = LitterRobot4Data.formatTime(sleepMin, {
        use12hFormat,
        timezone: tz,
        baseDate: now
      });

      // Format end time (check if it's tomorrow)
      let endBaseDate = new Date(now);
      if (wakeMin < sleepMin) {
        endBaseDate.setDate(endBaseDate.getDate() + 1);
      }

      const endString = LitterRobot4Data.formatTime(wakeMin, {
        use12hFormat,
        timezone: tz,
        baseDate: endBaseDate
      });

      // Create Date objects for Flow triggers
      const startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      startDate.setMinutes(sleepMin);
      
      const endDate = new Date(startDate);
      if (wakeMin < sleepMin) endDate.setDate(endDate.getDate() + 1);
      endDate.setHours(0, 0, 0, 0);
      endDate.setMinutes(wakeMin);

      return { startString, endString, startDate, endDate };
    } catch (err) {
      console.error('Error computing sleep schedule:', err);
      return null;
    }
  }

  // ============================================================================
  // INSTANCE GETTERS (Basic Properties)
  // ============================================================================

  /** @returns {string} Robot ID */
  get id() { return this._robot.unitId; }

  /** @returns {string} Robot serial number */
  get serial() { return this._robot.serial; }

  /** @returns {string} Robot name */
  get name() { return this._robot.name; }

  /** @returns {string} User ID */
  get userId() { return this._robot.userId; }

  // ============================================================================
  // INSTANCE GETTERS (Status and State)
  // ============================================================================

  /**
   * @returns {string} Derived status code with caching for performance
   */
  get statusCode() {
    this._invalidateCacheIfNeeded();
    if (this._cachedStatusCode === null) {
      this._cachedStatusCode = LitterRobot4Data.deriveStatusCode(this._robot);
    }
    return this._cachedStatusCode;
  }

  /**
   * @returns {string} User-friendly status description
   */
  get statusDescription() {
    const code = this.statusCode;
    const description = LitterRobot4Data.StatusDescriptions[code];
    return description || "Unknown Status";
  }

  /**
   * @returns {string} Detailed description for the current robot cycle state
   */
  get cycleStateDescription() {
    const status = this._robot.robotCycleStatus;
    return LitterRobot4Data.getCleanCycleStatus(this._robot);
  }

  /**
   * @returns {string} User-friendly night light mode
   */
  get nightLightMode() {
    const mode = this._robot.nightLightMode;
    
    switch (mode) {
      case 'OFF': return 'off';
      case 'ON': return 'on';
      case 'AUTO': return 'auto';
      default:
        // Return 'off' as default for unknown or undefined values
        return 'off';
    }
  }



  // ============================================================================
  // INSTANCE GETTERS (Boolean States)
  // ============================================================================

  /** @returns {boolean} True if cat is detected */
  get isCatDetected() {
    return LitterRobot4Data.isCatDetected(this._robot);
  }

  /** @returns {boolean} True if waste drawer is full (based on threshold) */
  get isDrawerFull() {
    const drawerLevel = this._robot.DFILevelPercent || 0;
    const threshold = this._settings.waste_drawer_threshold;
    return drawerLevel >= threshold;
  }

  /** @returns {boolean} True if sleep mode is active */
  get isSleepActive() {
    return this._robot.sleepStatus === LitterRobot4Data.SleepStatus.SLEEPING;
  }

  /** @returns {boolean} True if robot is online */
  get isOnline() {
    return this._robot.isOnline === true;
  }

  /** @returns {boolean} True if sleep mode is scheduled for the current day */
  get isSleepScheduled() {
    return !!this.sleepSchedule;
  }

  /** @returns {boolean} True if keypad is locked */
  get isKeypadLocked() {
    return this._robot.isKeypadLockout === true;
  }

  /** @returns {boolean} True if there is a known problem */
  get hasProblem() {
    return !!this.problemDescription;
  }

  /** @returns {boolean} True if bonnet is removed */
  get isBonnetRemoved() {
    return this._robot.isBonnetRemoved === true;
  }



  /** @returns {boolean} True if laser is dirty */
  get isLaserDirty() {
    return this._robot.isLaserDirty === true;
  }

  /** @returns {boolean} True if smart weight is enabled */
  get isSmartWeightEnabled() {
    return this._robot.smartWeightEnabled === true;
  }

  // ============================================================================
  // INSTANCE GETTERS (Numeric Values)
  // ============================================================================

  /** @returns {number|null} Litter level as percentage (0-100) */
  get litterLevelPercentage() {
    const level = this._robot.litterLevelPercentage;
    return typeof level === 'number' ? Math.round(level * 100) : null;
  }

  /** @returns {number|null} Waste drawer level as percentage */
  get wasteDrawerLevelPercentage() {
    return this._robot.DFILevelPercent !== undefined ? this._robot.DFILevelPercent : null;
  }

  /** @returns {number} Total clean cycles performed */
  get totalCleanCycles() {
    return this._robot.odometerCleanCycles || 0;
  }

  /** @returns {number|null} Number of scoops saved */
  get scoopsSavedCount() {
    return this._robot.scoopsSavedCount || null;
  }

  /** @returns {number|null} Cat weight in grams */
  get weightInGrams() {
    const weight = this._robot.catWeight;
    return weight ? Math.round(weight * LitterRobot4Data.Defaults.LBS_TO_GRAMS) : null;
  }

  /** @returns {number} Total number of problems present with the robot */
  get problemCount() {
    const analysis = LitterRobot4Data.analyzeProblem(this._robot);
    return analysis.codes.length;
  }

  /** @returns {string[]} Array of all problem codes present */
  get problemCodes() {
    const analysis = LitterRobot4Data.analyzeProblem(this._robot);
    return analysis.codes;
  }

  /** @returns {string|null} Primary problem description or null */
  get problemDescription() {
    const analysis = LitterRobot4Data.analyzeProblem(this._robot);
    return analysis.description;
  }

  /** @returns {number|null} Minutes until sleep ends, or null if not available */
  get sleepEndsInMinutes() {
    if (!this.sleepSchedule?.endDate) return null;
    
    const robotTimezone = this._robot?.unitTimezone;
    const now = robotTimezone
      ? new Date(new Date().toLocaleString('en-US', { timeZone: robotTimezone }))
      : new Date();

    const end = new Date(this.sleepSchedule.endDate);
    const msLeft = end - now;
    return msLeft > 0 ? Math.round(msLeft / 60000) : null;
  }

  /** @returns {number|null} Clean cycle wait time in minutes */
  get cleanCycleWaitTime() {
    return this._robot.cleanCycleWaitTime || null;
  }

  /** @returns {number|null} Night light brightness level */
  get nightLightBrightness() {
    return this._robot.nightLightBrightness || null;
  }

  /** @returns {number|null} Panel brightness high setting */
  get panelBrightnessHigh() {
    return this._robot.panelBrightnessHigh || null;
  }

  /** @returns {number|null} Panel brightness low setting */
  get panelBrightnessLow() {
    return this._robot.panelBrightnessLow || null;
  }

  /** @returns {number|null} WiFi signal strength */
  get wifiRssi() {
    return this._robot.wifiRssi || null;
  }

  /** @returns {number|null} Weight sensor reading */
  get weightSensor() {
    return this._robot.weightSensor || null;
  }

  // ============================================================================
  // LITTERHOPPER GETTERS
  // ============================================================================

  /** @returns {string|null} Hopper status from API */
  get hopperStatus() {
    return this._robot.hopperStatus || null;
  }

  /** @returns {boolean|null} Whether hopper is removed/disabled */
  get isHopperRemoved() {
    return this._robot.isHopperRemoved || false;
  }

  /** @returns {boolean} Whether hopper is empty */
  get isHopperEmpty() {
    return this._robot.hopperStatus === LitterRobot4Data.HopperStatus.EMPTY;
  }

  /** @returns {boolean} Whether hopper is enabled */
  get isHopperEnabled() {
    return this._robot.hopperStatus === LitterRobot4Data.HopperStatus.ENABLED;
  }

  /** @returns {boolean} Whether hopper has a motor fault */
  get hasHopperMotorFault() {
    const status = this._robot.hopperStatus;
    return status === LitterRobot4Data.HopperStatus.MOTOR_FAULT_SHORT ||
           status === LitterRobot4Data.HopperStatus.MOTOR_OT_AMPS ||
           status === LitterRobot4Data.HopperStatus.MOTOR_DISCONNECTED;
  }

  /** @returns {string|null} Human-readable hopper status description */
  get hopperStatusDescription() {
    const status = this._robot.hopperStatus;
    if (!status) return null;
    
    // Map to short letter code first
    const shortCode = LitterRobot4Data.HOPPER_STATUS_MAP[status];
    if (shortCode) {
      return LitterRobot4Data.StatusDescriptions[shortCode] || 'Unknown hopper status';
    }
    
    return 'Unknown hopper status';
  }

  // ============================================================================
  // INSTANCE GETTERS (String Values)
  // ============================================================================

  /** @returns {string|null} Clean cycle wait time as string */
  get cleanCycleWaitTimeString() {
    return this._robot.cleanCycleWaitTime ? String(this._robot.cleanCycleWaitTime) : null;
  }

  /** @returns {string|null} Formatted firmware version */
  get firmwareVersion() {
    return LitterRobot4Data.formatFirmwareVersion(this._robot);
  }

  /** @returns {string|null} Unit timezone */
  get timezone() {
    return this._robot.unitTimezone || null;
  }

  /** @returns {string|null} Unit time */
  get unitTime() {
    return this._robot.unitTime || null;
  }

  /** @returns {string|null} Surface type */
  get surfaceType() {
    return this._robot.surfaceType || null;
  }

  // ============================================================================
  // INSTANCE GETTERS (Complex Objects)
  // ============================================================================

  /**
   * @returns {Object|null} Sleep schedule information with caching
   */
  get sleepSchedule() {
    this._invalidateCacheIfNeeded();
    if (this._cachedSleepSchedule === null) {
      this._cachedSleepSchedule = LitterRobot4Data.computeSleepSchedule(this._robot, {
        use12hFormat: this._settings.use12hFormat
      });
    }
    return this._cachedSleepSchedule;
  }

  /**
   * @returns {string|null} Formatted last seen timestamp
   */
  get lastSeenFormatted() {
    return LitterRobot4Data.formatTime(this._robot.lastSeen, {
      use12hFormat: this._settings.use12hFormat,
      timezone: this._robot.unitTimezone
    });
  }

  /**
   * @returns {string|null} Formatted setup date/time
   */
  get setupDateTimeFormatted() {
    return LitterRobot4Data.formatTime(this._robot.setupDateTime, {
      use12hFormat: this._settings.use12hFormat
    });
  }

  // ============================================================================
  // INSTANCE METHODS
  // ============================================================================

  /**
   * Update robot data directly (for WebSocket updates)
   * @param {Object} newRobotData - Updated robot data
   */
  updateRobotData(newRobotData) {
    if (!newRobotData || typeof newRobotData !== 'object') {
      throw new Error(LitterRobot4Data.ErrorMessages.INVALID_ROBOT_DATA);
    }
    
    this._robot = { ...this._robot, ...newRobotData };
    this._invalidateCacheIfNeeded();
  }

  /**
   * Get raw robot data (for debugging or advanced usage)
   * @returns {Object} Raw robot data object
   */
  getRawData() {
    return { ...this._robot };
  }

  /**
   * Get settings used for formatting
   * @returns {Object} Settings object
   */
  getSettings() {
    return { ...this._settings };
  }

  /**
   * Update formatting settings
   * @param {Object} newSettings - New settings to apply
   */
  updateSettings(newSettings) {
    if (newSettings && typeof newSettings === 'object') {
      this._settings = { ...this._settings, ...newSettings };
      // Invalidate cache since settings affect formatting
      this._cachedSleepSchedule = null;
    }
  }
}

module.exports = LitterRobot4Data; 