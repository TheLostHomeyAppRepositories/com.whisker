/**
 * Data wrapper for Litter-Robot 3 devices that processes robot state data,
 * derives status codes, and formats values for display. Uses caching to avoid
 * recomputing derived values when the underlying robot data hasn't changed.
 */
class LitterRobot3Data {
  // ============================================================================
  // CONSTANTS AND CONFIGURATION
  // ============================================================================

  /** Default configuration values for data processing and formatting */
  static Defaults = Object.freeze({
    DEFAULT_WASTE_DRAWER_THRESHOLD: 80,
    WEBSOCKET_INIT_DELAY: 3000,
    MINIMUM_CYCLES_LEFT_DEFAULT: 3,
    CYCLE_CAPACITY_DEFAULT: 30,
    VALID_WAIT_TIMES: [3, 7, 15],
    SLEEP_DURATION_HOURS: 8,
  });

  // ============================================================================
  // ENUM DEFINITIONS
  // ============================================================================

  /** LR3 Status Codes */
  static StatusCodes = Object.freeze({
    BONNET_REMOVED: 'BR',
    CLEAN_CYCLE_COMPLETE: 'CCC',
    CLEAN_CYCLE: 'CCP',
    CAT_DETECTED: 'CD',
    CAT_SENSOR_FAULT: 'CSF',
    CAT_SENSOR_INTERRUPTED: 'CSI',
    CAT_SENSOR_TIMING: 'CST',
    DRAWER_FULL_1: 'DF1',
    DRAWER_FULL_2: 'DF2',
    DRAWER_FULL: 'DFS',
    DUMP_HOME_POSITION_FAULT: 'DHF',
    DUMP_POSITION_FAULT: 'DPF',
    EMPTY_CYCLE: 'EC',
    HOME_POSITION_FAULT: 'HPF',
    OFF: 'OFF',
    OFFLINE: 'OFFLINE',
    OVER_TORQUE_FAULT: 'OTF',
    PAUSED: 'P',
    PINCH_DETECT: 'PD',
    POWER_DOWN: 'PWRD',
    POWER_UP: 'PWRU',
    READY: 'RDY',
    STARTUP_CAT_SENSOR_FAULT: 'SCF',
    STARTUP_DRAWER_FULL: 'SDF',
    STARTUP_PINCH_DETECT: 'SPF',
    UNKNOWN: 'UNKNOWN',
  });

  /** LR3 Commands */
  static Commands = Object.freeze({
    CLEAN: 'C',
    DEFAULT_SETTINGS: 'D',
    LOCK_OFF: 'L0',
    LOCK_ON: 'L1',
    NIGHT_LIGHT_OFF: 'N0',
    NIGHT_LIGHT_ON: 'N1',
    POWER_OFF: 'P0',
    POWER_ON: 'P1',
    WAIT_TIME: 'W',
    // Command prefix and endpoint
    PREFIX: '<',
    ENDPOINT: 'dispatch-commands',
  });

  /** Unit Status Enum - from LR3 API */
  static UnitStatus = Object.freeze({
    READY: 'RDY',
    CLEAN_CYCLE: 'CCP',
    CAT_DETECT: 'CD',
    DRAWER_FULL: 'DFS',
    POWER_OFF: 'OFF',
    POWER_UP: 'PWRU',
    POWER_DOWN: 'PWRD',
  });

  /** Power Status Enum - from LR3 API */
  static PowerStatus = Object.freeze({
    AC: 'AC',
    DC: 'DC',
  });

  /** Device Type Enum - from LR3 API */
  static DeviceType = Object.freeze({
    IOT: 'iot',
  });

  // ============================================================================
  // DATA FIELD MAPPINGS
  // ============================================================================

  /** Data field mappings */
  static DataFields = Object.freeze({
    CYCLE_CAPACITY: 'cycleCapacity',
    CYCLE_CAPACITY_DEFAULT: 'cycleCapacityDefault',
    CYCLE_COUNT: 'cycleCount',
    DRAWER_FULL_CYCLES: 'cyclesAfterDrawerFull',
    ID: 'litterRobotId',
    NAME: 'litterRobotNickname',
    POWER_STATUS: 'powerStatus',
    SERIAL: 'litterRobotSerial',
    SETUP_DATE: 'setupDate',
  });

  // ============================================================================
  // STATUS MAPPINGS
  // ============================================================================

  /** Maps derived status codes to human-readable descriptions */
  static StatusDescriptions = Object.freeze({
    BR: 'Bonnet removed',
    CCC: 'Cleaning cycle complete',
    CCP: 'Cleaning cycle in progress',
    CD: 'Cat detected',
    CSF: 'Cat sensor fault',
    CSI: 'Cat sensor interrupted',
    CST: 'Cat sensor timing',
    DF1: 'Drawer almost full', // 2 cycles left
    DF2: 'Drawer almost full', // 1 cycle left
    DFS: 'Drawer full',
    DHF: 'Dump + home position fault',
    DPF: 'Dump position fault',
    EC: 'Emptying cycle',
    HPF: 'Home position fault',
    OFF: 'Off',
    OFFLINE: 'Offline',
    OTF: 'Over torque fault',
    P: 'Clean cycle paused',
    PD: 'Pinch detected',
    PPD: 'Potential pinch detected',
    PWRD: 'Powering down',
    PWRU: 'Powering up',
    RDY: 'Ready',
    SCF: 'Cat sensor fault at startup',
    SDF: 'Drawer full at startup',
    SPF: 'Pinch detect at startup',
    UNKNOWN: 'Unknown status',
  });

  /** Maps problem codes to descriptions for error reporting and troubleshooting */
  static ProblemDescriptions = Object.freeze({
    PD: 'Pinch detected',
    PF: 'Pinch detect fault',
    PFR: 'Pinch detect fault during retract',
    MTR: 'Globe motor fault',
    MTRB: 'Globe motor fault (backwards)',
    MTRH: 'Globe motor fault (home)',
    OTF: 'Over torque fault',
    OTFTO: 'Over torque fault timeout',
    CSF: 'Cat sensor fault',
    SCF: 'Cat sensor fault at startup',
    DPF: 'Dump position fault',
    HPF: 'Home position fault',
    DHF: 'Dump + home position fault',
  });

  /** Centralized error messages for consistent error handling */
  static ErrorMessages = Object.freeze({
    INVALID_ROBOT_DATA: 'Invalid robot data provided. Robot data must be an object.',
    MISSING_ROBOT_ID: 'Robot data is missing required litterRobotId field.',
    INVALID_SETTINGS: 'Invalid device settings. Please repair device.',
    INVALID_WAIT_TIME: 'Invalid wait time value',
  });

  // ============================================================================
  // CONSTRUCTOR AND INITIALIZATION
  // ============================================================================

  /**
   * Creates a new LitterRobot3Data instance for processing robot state data.
   * Validates input parameters and initializes caching to avoid recomputing derived values.
   * @param {Object} params
   * @param {Object} params.robot - Robot state object from API
   * @param {Object} [params.settings={}] - Optional settings for data formatting
   * @throws {Error} If required parameters are missing or invalid
   */
  constructor({ robot, settings = {} } = {}) {
    if (!robot || typeof robot !== 'object') {
      throw new Error(LitterRobot3Data.ErrorMessages.INVALID_ROBOT_DATA);
    }

    this._robot = robot;
    this._settings = {
      use12hFormat: false,
      useUSDate: false,
      waste_drawer_threshold: LitterRobot3Data.Defaults.DEFAULT_WASTE_DRAWER_THRESHOLD,
      ...settings,
    };

    // Normalize time format settings to boolean to support both string and boolean inputs
    if (this._settings.use_12h_format === '12h') {
      this._settings.use12hFormat = true;
    } else if (this._settings.use_12h_format === '24h') {
      this._settings.use12hFormat = false;
    } else if (typeof this._settings.use_12h_format === 'boolean') {
      // Handle legacy boolean values for backward compatibility
      this._settings.use12hFormat = this._settings.use_12h_format;
    }

    // Initialize caching to avoid recomputing derived values when robot data hasn't changed
    this._cachedStatusCode = null;
    this._cachedSleepSchedule = null;
    this._cachedProblemAnalysis = null;
    this._lastRobotHash = this._computeRobotHash();
    this._lastSettingsHash = this._computeSettingsHash();

    // Initialize status-driven minimum cycles left
    this._minimumCyclesLeft = LitterRobot3Data.Defaults.MINIMUM_CYCLES_LEFT_DEFAULT;
    this._updateMinimumCyclesLeft();
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Computes a hash of key robot properties to detect when data has changed.
   * Used by the caching system to determine when to invalidate cached values.
   * @private
   * @returns {string} Hash string for change detection
   */
  _computeRobotHash() {
    const keyProps = [
      'unitStatus', 'isDfsTriggered', 'isDf1Triggered', 'isDf2Triggered',
      'isDFITriggered', 'isOnline', 'powerStatus',
    ];
    return keyProps.map((prop) => this._robot[prop]).join('|');
  }

  /**
   * Computes a hash of key settings properties to detect when settings have changed.
   * Used by the caching system to determine when to invalidate cached values.
   * @private
   * @returns {string} Hash string for change detection
   */
  _computeSettingsHash() {
    const keyProps = [
      'use12hFormat', 'homeyTimezone',
    ];
    return keyProps.map((prop) => this._settings[prop]).join('|');
  }

  /**
   * Checks if robot data or settings have changed and invalidates cache when necessary.
   * Prevents returning stale cached values after data updates.
   * @private
   */
  _invalidateCacheIfNeeded() {
    const currentRobotHash = this._computeRobotHash();
    const currentSettingsHash = this._computeSettingsHash();

    if (currentRobotHash !== this._lastRobotHash) {
      this._cachedStatusCode = null;
      this._cachedProblemAnalysis = null;
      this._lastRobotHash = currentRobotHash;
    }

    if (currentSettingsHash !== this._lastSettingsHash) {
      this._cachedSleepSchedule = null;
      this._lastSettingsHash = currentSettingsHash;
    }
  }

  /**
   * Maps LR3 unitStatus to minimum cycles left.
   * DF1 -> 2, DF2 -> 1, DFS -> 0, RDY/others -> default (3).
   * @private
   * @returns {number}
   */
  _statusMinimumCyclesLeft() {
    const status = this._robot?.unitStatus;
    if (status === 'DF1') return 2;
    if (status === 'DF2') return 1;
    if (status === 'DFS') return 0;
    // READY or any other status falls back to default
    return LitterRobot3Data.Defaults.MINIMUM_CYCLES_LEFT_DEFAULT;
  }

  /**
   * Updates internal minimum cycles left. Lowers value on DF1/DF2/DFS; resets on READY.
   * @private
   */
  _updateMinimumCyclesLeft() {
    const status = this._robot?.unitStatus;
    const mapped = this._statusMinimumCyclesLeft();
    if (status === 'RDY' || this._minimumCyclesLeft > mapped) {
      this._minimumCyclesLeft = mapped;
    }
  }

  // ============================================================================
  // FORMATTING METHODS
  // ============================================================================

  /**
   * Formats Date objects with consistent options for display.
   * Used to standardize date/time formatting across the application.
   * @param {Date} dateObj - A valid Date instance
   * @param {Object} opts - Formatting options
   * @param {boolean} [opts.use12hFormat=false] - When true, output 12-hour with AM/PM
   * @param {boolean} [opts.forceUSDate=false] - When true, forces MM-DD-YYYY ordering
   * @returns {string} Formatted date string or 'Invalid date'
   */
  static formatDateForDisplay(dateObj, { use12hFormat = false } = {}) {
    if (!(dateObj instanceof Date) || Number.isNaN(dateObj.getTime())) {
      return 'Invalid date';
    }

    return dateObj.toLocaleString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: use12hFormat,
    });
  }

  /**
   * Formats time values from ISO string timestamps.
   * Handles timezone conversion and user preference settings for consistent display.
   * @param {string} timeInput - ISO string timestamp
   * @param {Object} opts - Formatting options
   * @param {boolean} [opts.use12hFormat=false] - When true, output 12-hour with AM/PM
   * @param {string} [opts.timezone] - Timezone for conversion
   * @returns {string|null} Formatted time string or null if invalid
   */
  static formatTime(timeInput, { use12hFormat = false, timezone = null } = {}) {
    if (!timeInput) return null;

    const dateObj = new Date(timeInput);
    if (Number.isNaN(dateObj.getTime())) return null;

    if (timezone) {
      return dateObj.toLocaleString('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: use12hFormat,
      });
    }

    return LitterRobot3Data.formatDateForDisplay(dateObj, { use12hFormat });
  }

  // ============================================================================
  // STATUS CODE DERIVATION
  // ============================================================================

  /**
   * Derives the official LR3 status code from raw robot payload using priority-based logic.
   * @param {Object} robot - Raw robot state object
   * @returns {string} Two/three-letter status code
   */
  static deriveStatusCode(robot) {
    if (!robot || typeof robot !== 'object') return 'UNKNOWN';

    // Destructure robot properties once to avoid repeated property access
    const {
      unitStatus, powerStatus, isManualReset,
    } = robot;

    // Priority 1: HARD faults (motor/mechanical issues)
    if (unitStatus === 'DHF') return 'DHF';
    if (unitStatus === 'DPF') return 'DPF';
    if (unitStatus === 'HPF') return 'HPF';
    if (unitStatus === 'OTF') return 'OTF';

    // Priority 2: Pinch detect issues
    if (unitStatus === 'SPF') return 'SPF';
    if (unitStatus === 'PD') return 'PD';
    if (unitStatus === 'PPD') return 'PPD';

    // Priority 3: Cat sensor faults
    if (unitStatus === 'SCF') return 'SCF';
    if (unitStatus === 'SDF') return 'SDF';
    if (unitStatus === 'CSF') return 'CSF';
    if (unitStatus === 'CSI') return 'CSI';

    // Priority 4: Connectivity / power
    if (powerStatus === 'NC') return 'OFFLINE';
    if (powerStatus === 'OFF') return 'OFF';
    if (unitStatus === 'PWRD') return 'PWRD';
    if (unitStatus === 'PWRU') return 'PWRU';

    // Priority 5: Drawer full states
    if (unitStatus === 'DFS') return 'DFS';
    // if (isDf1Triggered === '1') return 'DF1';
    // if (isDf2Triggered === '1') return 'DF2';

    // Priority 6: Cat detection
    if (unitStatus === 'CST') return 'CST';
    if (unitStatus === 'CD') return 'CD';

    // Priority 7: Cycle states
    if (unitStatus === 'CCP') return 'CCP';
    if (unitStatus === 'CCC') return 'CCC';
    if (unitStatus === 'EC') return 'EC';
    if (unitStatus === 'P') return 'P';
    if (unitStatus === 'RDY') return 'RDY';

    // Priority 8: Bonnet removed
    if (unitStatus === 'BR') return 'BR';

    // Priority 9: Manual reset indicator
    if (isManualReset === true) return 'RDY';

    // Default fallback
    return unitStatus || 'UNKNOWN';
  }

  // ============================================================================
  // STATIC HELPER METHODS
  // ============================================================================

  /**
   * Derives a clean cycle status string for display.
   * Converts technical robot states into readable descriptions.
   * @param {Object} robot - Robot status payload
   * @returns {string} Human-readable status
   */
  static getCleanCycleStatus(robot) {
    if (!robot) return 'Unknown Status';

    const { unitStatus } = robot;

    switch (unitStatus) {
      case 'CST': return 'Waiting to start';
      case 'CCP': return 'Cleaning';
      case 'CCC': return 'Cleaning complete';
      case 'EC': return 'Emptying';
      case 'P': return 'Paused';
      case 'RDY': return 'Idle';
      // Fault conditions that affect cleaning
      case 'DHF': return 'Fault';
      case 'DPF': return 'Fault';
      case 'HPF': return 'Fault';
      case 'OTF': return 'Fault';
      case 'SPF': return 'Fault';
      case 'PD': return 'Fault';
      case 'PPD': return 'Fault';
      case 'SCF': return 'Fault';
      case 'SDF': return 'Fault';
      case 'CSF': return 'Fault';
      case 'CSI': return 'Fault';
      // All other states (OFF, OFFLINE, PWRU, PWRD, CD, DFS, DF1, DF2, BR) show as Idle
      default:
        return 'Idle';
    }
  }

  /**
   * Determines if a cat is detected based on robot data by checking unit status.
   * @param {Object} robot - Robot data object
   * @returns {boolean} True if cat is detected
   */
  static isCatDetected(robot) {
    if (!robot) return false;
    return robot.unitStatus === 'CD';
  }

  /**
   * Determines if there is a connectivity problem with the robot.
   * Checks online status to identify network or communication issues.
   * @param {Object} robot - Robot data object
   * @returns {boolean} True if robot is offline
   */
  static hasConnectivityProblem(robot) {
    if (!robot) return false;
    return robot.powerStatus === 'NC' || LitterRobot3Data.deriveStatusCode(robot) === 'OFFLINE';
  }

  /**
   * Analyzes robot status for problems and returns problem information.
   * @param {Object} robot - Robot data object
   * @returns {Object} Problem analysis object
   */
  static analyzeProblem(robot) {
    const statusCode = LitterRobot3Data.deriveStatusCode(robot);
    const problemDescriptions = LitterRobot3Data.ProblemDescriptions;
    const activeCodes = Object.keys(problemDescriptions).filter((c) => c === statusCode);

    return {
      hasProblems: activeCodes.length > 0,
      codes: activeCodes,
      description: activeCodes.length ? problemDescriptions[activeCodes[0]] : null,
    };
  }

  /**
   * Gets cached problem analysis, computing it if needed.
   * Ensures analyzeProblem() is only called once per data update cycle.
   * @private
   * @returns {Object} Problem analysis object
   */
  _getProblemAnalysis() {
    this._invalidateCacheIfNeeded();
    if (this._cachedProblemAnalysis === null) {
      this._cachedProblemAnalysis = LitterRobot3Data.analyzeProblem(this._robot);
    }
    return this._cachedProblemAnalysis;
  }

  // ============================================================================
  // INSTANCE GETTERS (Basic Properties)
  // ============================================================================

  /** @returns {Object} Raw robot data object */
  get robot() {
    return this._robot;
  }

  /** @returns {string} Robot ID */
  get id() {
    return this._robot.litterRobotId;
  }

  /** @returns {string} Robot serial number */
  get serial() {
    return this._robot.litterRobotSerial;
  }

  /** @returns {string} Robot name */
  get name() {
    return this._robot.litterRobotNickname || 'Litter-Robot 3';
  }

  /** @returns {boolean} True if robot is onboarded */
  get isOnboarded() {
    return this._robot.isOnboarded === true;
  }

  // ============================================================================
  // INSTANCE GETTERS (Status and State)
  // ============================================================================

  /**
   * @returns {string} Derived status code, cached to avoid recomputation when data hasn't changed
   */
  get statusCode() {
    this._invalidateCacheIfNeeded();
    if (this._cachedStatusCode === null) {
      this._cachedStatusCode = LitterRobot3Data.deriveStatusCode(this._robot);
    }
    return this._cachedStatusCode;
  }

  /**
   * @returns {string} Status description for interface display
   */
  get statusDescription() {
    const code = this.statusCode;
    const description = LitterRobot3Data.StatusDescriptions[code];
    return description || 'Unknown Status';
  }

  /**
   * @returns {string} Description of the current robot cycle state
   */
  get cycleStateDescription() {
    return LitterRobot3Data.getCleanCycleStatus(this._robot);
  }

  // ============================================================================
  // INSTANCE GETTERS (Boolean States)
  // ============================================================================

  /** @returns {boolean} True if cat is detected */
  get isCatDetected() {
    return LitterRobot3Data.isCatDetected(this._robot);
  }

  /** @returns {boolean} True if waste drawer is full */
  get isDrawerFull() {
    return (this._robot.isDfsTriggered === '1' && this.totalCleanCycles > 9)
           || this._robot.unitStatus === 'DFS'
           || this._minimumCyclesLeft < LitterRobot3Data.Defaults.MINIMUM_CYCLES_LEFT_DEFAULT;
  }

  /** @returns {boolean} True if waste drawer is almost full */
  get isDrawerAlmostFull() {
    return this._robot.isDf1Triggered === '1' || this._robot.isDf2Triggered === '1';
  }

  /** @returns {boolean} True if drawer full indicator is triggered */
  get isDrawerFullIndicatorTriggered() {
    return this._robot.isDFITriggered === '1';
  }

  /** @returns {boolean} True if robot is online */
  get isOnline() {
    return this._robot.powerStatus !== 'NC' && this.statusCode !== 'OFFLINE';
  }

  /** @returns {boolean} True if there are known problems */
  get hasProblems() {
    return this._getProblemAnalysis().hasProblems;
  }

  /** @returns {boolean} True if keypad is locked */
  get isKeypadLocked() {
    return this._robot.panelLockActive === '1';
  }

  /** @returns {boolean} True if night light is active */
  get isNightLightActive() {
    return this._robot.nightLightActive === '1';
  }

  /** @returns {boolean} True if robot is turned on (not OFF) */
  get isOnOff() {
    return this._robot.unitStatus !== 'OFF';
  }

  /** @returns {boolean} True if sleep mode is enabled (not "0") */
  get isSleepModeEnabled() {
    return this._robot.sleepModeActive !== '0';
  }

  /** @returns {boolean} True if currently sleeping */
  get isSleeping() {
    if (!this.isSleepModeEnabled) return false;

    // Parse hours from SLEEP_MODE_ACTIVE string (characters 1:3)
    const hoursStr = this._robot.sleepModeActive?.slice(1, 3) || '0';
    const hours = parseInt(hoursStr, 10) || 0;

    return hours < LitterRobot3Data.Defaults.SLEEP_DURATION_HOURS;
  }

  /** @returns {boolean} True if sleep mode is active (currently sleeping) */
  get isSleepActive() {
    return this.isSleeping;
  }

  /** @returns {boolean} True if sleep mode is scheduled */
  get isSleepScheduled() {
    return this.isSleepModeEnabled;
  }

  /**
   * Parses sleep mode start and end times
   * @returns {Object|null} Sleep schedule with start/end times or null if not enabled
   */
  get sleepSchedule() {
    this._invalidateCacheIfNeeded();
    if (this._cachedSleepSchedule === null) {
      this._cachedSleepSchedule = LitterRobot3Data.computeSleepSchedule(this._robot, {
        use12hFormat: this._settings.use12hFormat,
        timezone: this._settings.homeyTimezone,
      });
    }
    return this._cachedSleepSchedule;
  }

  /**
   * Computes today's sleep mode start/end times and formatted strings based on robot settings.
   * Handles timezone conversion and cross-day sleep schedules.
   * @param {Object} robot - Robot payload containing sleep settings
   * @param {Object} opts - Formatting options
   * @param {boolean} [opts.use12hFormat=false] - 12-hour time display
   * @param {string} [opts.timezone] - Timezone for conversion
   * @returns {Object|null} Sleep schedule object or null if not enabled
   */
  static computeSleepSchedule(robot, { use12hFormat = false, timezone = null } = {}) {
    if (!robot?.sleepModeActive || robot.sleepModeActive === '0') {
      return null;
    }

    try {
      const now = new Date();
      let startTime;

      // Check if we have SLEEP_MODE_TIME timestamp (newer API)
      if (robot.sleepModeTime && robot.sleepModeTime !== '0') {
        const timestamp = parseInt(robot.sleepModeTime, 10);
        if (!Number.isNaN(timestamp)) {
          const sleepTime = new Date(timestamp * 1000);
          startTime = new Date(now);
          startTime.setHours(sleepTime.getHours(), sleepTime.getMinutes(), sleepTime.getSeconds(), 0);

          // If start time is in the past, assume it's from yesterday
          if (startTime <= new Date(now.getTime() - LitterRobot3Data.Defaults.SLEEP_DURATION_HOURS * 60 * 60 * 1000)) {
            startTime.setDate(startTime.getDate() + 1);
          }
        }
      } else if (robot.sleepModeActive && robot.sleepModeActive !== '0') {
        // Parse SLEEP_MODE_ACTIVE string (legacy API)
        const timeStr = robot.sleepModeActive.slice(1); // Skip first character
        const [hours, minutes, seconds] = timeStr.split(':').map((s) => parseInt(s, 10) || 0);

        startTime = new Date(now);
        startTime.setHours(hours, minutes, seconds, 0);

        // If start time is in the past, assume it's from yesterday
        if (startTime <= new Date(now.getTime() - LitterRobot3Data.Defaults.SLEEP_DURATION_HOURS * 60 * 60 * 1000)) {
          startTime.setDate(startTime.getDate() + 1);
        }
      }

      if (!startTime) return null;

      // Calculate end time (8 hours after start)
      const endTime = new Date(startTime.getTime() + LitterRobot3Data.Defaults.SLEEP_DURATION_HOURS * 60 * 60 * 1000);

      return {
        startTime,
        endTime,
        startString: LitterRobot3Data.formatTime(startTime.toISOString(), {
          use12hFormat,
          timezone,
        }),
        endString: LitterRobot3Data.formatTime(endTime.toISOString(), {
          use12hFormat,
          timezone,
        }),
      };
    } catch (err) {
      return null;
    }
  }

  /** @returns {boolean} True if night light mode is enabled */
  get isNightLightModeEnabled() {
    return this._robot.nightLightActive === '1';
  }

  /** @returns {boolean} True if panel lock is enabled */
  get isPanelLockEnabled() {
    return this._robot.panelLockActive === '1';
  }

  // ============================================================================
  // INSTANCE GETTERS (Numeric Values)
  // ============================================================================

  /** @returns {number} Total clean cycles performed (odometer - never resets) */
  get totalCleanCycles() {
    return parseInt(this._robot.totalCycleCount, 10) || 0;
  }

  /** @returns {number|null} Number of scoops saved */
  get scoopsSavedCount() {
    return parseInt(this._robot.scoopsSavedCount, 10) || null;
  }

  /** @returns {number} Total number of problems present with the robot */
  get problemCount() {
    return this._getProblemAnalysis().codes.length;
  }

  /** @returns {string[]} Array of all problem codes present */
  get problemCodes() {
    return this._getProblemAnalysis().codes;
  }

  /** @returns {string|null} Primary problem description or null */
  get problemDescription() {
    return this._getProblemAnalysis().description;
  }

  /** @returns {number|null} Clean cycle wait time in minutes */
  get cleanCycleWaitTime() {
    return this.cleanCycleWaitTimeMinutes || null;
  }

  /** @returns {number} DFI cycle count */
  get dfiCycleCount() {
    return parseInt(this._robot.DFICycleCount, 10) || 0;
  }

  /** @returns {number} Cycle capacity */
  get cycleCapacity() {
    const apiCapacity = parseInt(this._robot.cycleCapacity || LitterRobot3Data.Defaults.CYCLE_CAPACITY_DEFAULT, 10);
    const minimumCapacity = this.cycleCount + this._minimumCyclesLeft;
    if (this._minimumCyclesLeft < LitterRobot3Data.Defaults.MINIMUM_CYCLES_LEFT_DEFAULT) {
      return minimumCapacity;
    }
    return Math.max(apiCapacity, minimumCapacity);
  }

  /** @returns {number} Cycle count since last drawer reset (resets when drawer emptied) */
  get cycleCount() {
    return parseInt(this._robot.cycleCount || '0', 10);
  }

  /** @returns {number} Odometer - total lifetime cycles (never resets) */
  get odometer() {
    return this.totalCleanCycles;
  }

  /** @returns {number} Cycles after drawer full */
  get cyclesAfterDrawerFull() {
    return parseInt(this._robot.cyclesAfterDrawerFull || '0', 10);
  }

  /** @returns {number} Waste drawer level percentage */
  get wasteDrawerLevel() {
    const capacity = this.cycleCapacity;
    if (capacity === 0) return 100;
    // Round to one decimal
    return Math.floor(((this.cycleCount / capacity) * 1000 + 0.5)) / 10;
  }

  /** @returns {number} Waste drawer level percentage with one decimal precision */
  get wasteDrawerLevelPercentageRaw() {
    return this.wasteDrawerLevel;
  }

  /** @returns {number} Waste drawer level percentage (integer for capability publishing) */
  get wasteDrawerLevelPercentage() {
    return Math.round(this.wasteDrawerLevelPercentageRaw);
  }

  /** @returns {number} Clean cycle wait time in minutes (hex parsing) */
  get cleanCycleWaitTimeMinutes() {
    return parseInt(this._robot.cleanCycleWaitTimeMinutes || '7', 16);
  }

  // ============================================================================
  // INSTANCE GETTERS (String Values)
  // ============================================================================

  /** @returns {string|null} Clean cycle wait time as string */
  get cleanCycleWaitTimeString() {
    return this._robot.cleanCycleWaitTimeMinutes ? String(this._robot.cleanCycleWaitTimeMinutes) : null;
  }

  /** @returns {string|null} Homey timezone */
  get timezone() {
    return this._settings.homeyTimezone || null;
  }

  /** @returns {string|null} Unit time */
  get unitTime() {
    return this._robot.unitTime || null;
  }

  /** @returns {string|null} Setup date */
  get setupDate() {
    return this._robot.setupDate || null;
  }

  /** @returns {string|null} Last seen timestamp */
  get lastSeen() {
    return this._robot.lastSeen || null;
  }

  /** @returns {string|null} Power status */
  get powerStatus() {
    return this._robot.powerStatus || null;
  }

  /** @returns {string|null} Device type */
  get deviceType() {
    return this._robot.deviceType || null;
  }

  /** @returns {string|null} Unit status */
  get unitStatus() {
    return this._robot.unitStatus || null;
  }

  /** @returns {string|null} Status text description */
  get statusText() {
    return this.statusDescription;
  }

  // ============================================================================
  // INSTANCE GETTERS (Complex Objects)
  // ============================================================================

  /**
   * @returns {string|null} Formatted last seen timestamp
   */
  get lastSeenFormatted() {
    return LitterRobot3Data.formatTime(this._robot.lastSeen, {
      use12hFormat: this._settings.use12hFormat,
      timezone: this._settings.homeyTimezone,
    });
  }

  /**
   * @returns {string|null} Formatted setup date/time
   */
  get setupDateTimeFormatted() {
    return LitterRobot3Data.formatTime(this._robot.setupDate, {
      use12hFormat: this._settings.use12hFormat,
      timezone: this._settings.homeyTimezone,
    });
  }

  // ============================================================================
  // INSTANCE METHODS
  // ============================================================================

  /**
   * Updates robot data directly for WebSocket updates while maintaining cache consistency.
   * Ensures cached values are invalidated when new data arrives to prevent stale information.
   * @param {Object} newRobotData - New robot data from API
   */
  updateRobotData(newRobotData) {
    if (!newRobotData || typeof newRobotData !== 'object') {
      throw new Error('Invalid robot data provided');
    }

    this._robot = newRobotData;
    this._updateMinimumCyclesLeft();
    this._invalidateCacheIfNeeded();
  }

  /**
   * Static helper to build reset payload without needing an instance upstream.
   * @param {Object} robot - Raw LR3 robot data
   * @param {Object} [settings={}] - Optional settings used by data wrapper
   * @returns {Object} PATCH payload for LR3 REST API
   */
  static buildResetPatch(robot, settings = {}) {
    const data = new LitterRobot3Data({ robot, settings });
    return {
      cycleCount: 0,
      cycleCapacity: data.cycleCapacity,
      cyclesAfterDrawerFull: 0,
    };
  }

  /**
   * Static helper to build sleep mode payload without needing an instance upstream.
   * @param {Object} robot - Raw LR3 robot data
   * @param {boolean} enable - Desired sleep mode state
   * @param {Object} [settings={}] - Optional settings used by data wrapper
   * @param {number} [nowSeconds] - Optional unix seconds to use when enabling without existing time
   * @returns {Object} PATCH payload for LR3 REST API
   */
  static buildSleepModePatch(robot, enable, settings = {}, nowSeconds = Math.floor(Date.now() / 1000)) {
    const data = new LitterRobot3Data({ robot, settings });
    const payload = { sleepModeEnable: enable };
    if (enable) {
      const existing = data._robot && data._robot.sleepModeTime ? parseInt(data._robot.sleepModeTime, 10) : NaN;
      if (data._robot && data._robot.sleepModeTime && data._robot.sleepModeTime !== '0' && !Number.isNaN(existing)) {
        payload.sleepModeTime = existing;
      } else {
        payload.sleepModeTime = nowSeconds;
      }
    }
    return payload;
  }
}

module.exports = LitterRobot3Data;
