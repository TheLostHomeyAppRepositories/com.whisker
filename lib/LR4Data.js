'use strict';

/**
 * LR4Data is a wrapper around the robot data and API, providing
 * methods to interpret status codes and manage the robot lifecycle.
 */
class LR4Data {
  /**
   * @param {Object} params
   * @param {Object} params.robot - Robot state object from API.
   * @param {Object} params.api - API client instance for fetching robots.
   */
  constructor({ robot, api }) {
    this._robot = robot;
    this._api = api;
  }

  /**
   * Mapping of raw robotStatus codes to human-readable descriptions.
   */
  static RobotStatusDescriptions = Object.freeze({
    ROBOT_IDLE: "Idle",
    ROBOT_CLEANING: "Cleaning",
    ROBOT_CLEAN: "Cleaning",
    ROBOT_CAT_DETECT_DELAY: "Waiting to start",
    ROBOT_CYCLE_PAUSED: "Paused",
    ROBOT_CYCLE_COMPLETE: "Completed",
    ROBOT_CYCLE_ERROR: "Error",
    ROBOT_WAITING: "Waiting",
    ROBOT_OFFLINE: "Offline",
    ROBOT_ERROR: "Error",
    ROBOT_DUMP_POSITION: "Dump position",
    ROBOT_HOME_POSITION: "Home position",
    IDLE: "Idle", // Added mapping for IDLE
  });

  /**
   * Mapping of robotCycleStatus codes to high-level cycle descriptions.
   */
  static CycleStateDescriptions = Object.freeze({
    CYCLE_IDLE: "Idle",
    CYCLE_DUMP: "Scooping",
    CYCLE_DFI: "Dumping",
    CYCLE_LEVEL: "Leveling",
    CYCLE_HOME: "Completed"
  });

  /**
   * Mapping of robotCycleState codes to detailed state descriptions.
   */
  static CycleStateStateDescriptions = Object.freeze({
    CYCLE_STATE_CAT_DETECT: "Cat Detect",
    CYCLE_STATE_WAIT_ON: "Waiting to start",
    CYCLE_STATE_WAIT_OFF: "Not waiting",
    CYCLE_STATE_PROCESS: "Processing",
  });

  /**
   * Mapping of displayCode values to litter box status descriptions.
   */
  static LitterBoxStatusDescriptions = Object.freeze({
    DC_MODE_CYCLE: "Cycle Mode", 
    DC_CAT_DETECT: "Cat Detected", 
    DC_DRAWER_FULL: "Drawer Full", 
    DC_BONNET_REMOVED: "Bonnet Removed", 
    DC_ERROR: "Error", 
  });

  /**
   * Mapping of derived status codes to human-readable descriptions.
   */
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
    PD: "Pinch detect",
    PWRD: "Powering down",
    PWRU: "Powering up",
    RDY: "Ready",
    SCF: "Cat sensor fault at startup",
    SDF: "Drawer full at startup",
    SPF: "Pinch detect at startup",
    UNKNOWN: "Unknown status",
  });

  get api() {
    return this._api;
  }

  get id() {
    return this._robot.id;
  }

  get serial() {
    return this._robot.serial;
  }

  get name() {
    return this._robot.name;
  }

  /**
   * Derive the overall status code based on multiple robot properties.
   * Priority:
   *  1. Motor faults (dump/home/over torque)
   *  2. Pinch detect faults
   *  3. Cat sensor faults
   *  4. Offline/power states
   *  5. Clean cycle/pause states
   *  6. Idle state interpretations (bonnet removed, drawer full, etc.)
   *  7. Display code mappings
   *  8. Default to "RDY"
   */
  get statusCode() {
    const {
      robotStatus, displayCode, globeMotorFaultStatus, pinchStatus,
      isBonnetRemoved, isDFIFull, DFILevelPercent, isDFIPartialFull,
      isCatDetectPending, catDetect, isOnline, robotCycleStatus,
      unitPowerStatus
    } = this._robot;

    // Faults and error conditions first
    // Globe Motor Faults
    if (
      globeMotorFaultStatus === "FAULT_DUMP_POSITION" ||
      globeMotorFaultStatus === "DUMP_POSITION_FAULT"
    ) {
      return "DPF"; // Dump Position Fault
    }
    if (
      globeMotorFaultStatus === "FAULT_HOME_POSITION" ||
      globeMotorFaultStatus === "HOME_POSITION_FAULT"
    ) {
      return "HPF"; // Home Position Fault
    }
    if (
      typeof globeMotorFaultStatus === "string" &&
      globeMotorFaultStatus.includes("FAULT") &&
      globeMotorFaultStatus !== "FAULT_CLEAR"
    ) {
      if (
        globeMotorFaultStatus !== "FAULT_DUMP_POSITION" &&
        globeMotorFaultStatus !== "DUMP_POSITION_FAULT" &&
        globeMotorFaultStatus !== "FAULT_HOME_POSITION" &&
        globeMotorFaultStatus !== "HOME_POSITION_FAULT"
      ) {
        return "DHF";
      }
    }
    if (globeMotorFaultStatus === "FAULT_OVER_TORQUE") {
      return "OTF"; // Over Torque Fault
    }
    // Pinch Detect Faults
    if (pinchStatus === "PINCH_DETECT_STARTUP") {
      return "SPF"; // Pinch Detect At Startup
    }
    if (pinchStatus === "PINCH_DETECT" || pinchStatus === "PINCH_DETECT_FAULT") {
      return "PD"; // Pinch Detect
    }
    // Cat Sensor Faults
    if (catDetect === "CAT_SENSOR_FAULT_STARTUP") {
      return "SCF"; // Cat Sensor Fault At Startup
    }
    if (isDFIFull && robotCycleStatus === "CYCLE_STARTUP") {
      return "SDF"; // Drawer Full At Startup
    }
    // Cat Sensor Faults (pending/fault)
    if (isCatDetectPending || catDetect === "CAT_DETECT_FAULT") {
      return "CSF"; // Cat Sensor Fault
    }
    // Cat Sensor Faults (explicit)
    if (catDetect === "CAT_SENSOR_FAULT") {
      return "CSF";
    }
    // Fallback: any catDetect string that contains "FAULT"
    if (typeof catDetect === "string" && catDetect.includes("FAULT")) {
      // Only if not already matched above
      if (
        catDetect !== "CAT_SENSOR_FAULT_STARTUP" &&
        catDetect !== "CAT_DETECT_FAULT" &&
        catDetect !== "CAT_SENSOR_FAULT"
      ) {
        return "CSF";
      }
    }
    // Cat Detected/Interrupt/Timing
    if (catDetect === "CAT_DETECT_INTERRUPTED") {
      return "CSI"; // Cat Sensor Interrupted
    }
    if (catDetect === "CAT_DETECT_TIMING") {
      return "CST"; // Cat Sensor Timing
    }
    if (catDetect === "CAT_DETECT") {
      return "CD"; // Cat Detected
    }

    // Offline and power states (prioritize offline at the top, like pylitterbot)
    if (!isOnline) {
      return "OFFLINE";
    }
    if (unitPowerStatus === "OFF") {
      return "OFF";
    }
    if (unitPowerStatus === "POWERING_DOWN") {
      return "PWRD";
    }
    if (unitPowerStatus === "POWERING_UP") {
      return "PWRU";
    }

    // Clean Cycle Paused/Idle
    if (robotCycleStatus === "CYCLE_PAUSED") {
      return "P";
    }
    // if (robotCycleStatus === "CYCLE_IDLE") {
    //   return "IDLE";
    // }

    // Clean Cycle In Progress
    if (robotStatus === "ROBOT_CLEAN") {
      return "CCP";
    }
    // Clean Cycle Complete
    if (robotStatus === "ROBOT_CYCLE_COMPLETE" || robotCycleStatus === "CYCLE_HOME") {
      return "CCC";
    }

    // If robotStatus maps to RDY, check displayCode or drawer full conditions
    if (robotStatus === "ROBOT_IDLE") {
      if (displayCode === "DC_BONNET_REMOVED" || isBonnetRemoved === true) {
        return "BR";
      }
      // Only return DFS if isDFIFull is true and status is RDY
      if (displayCode === "DC_DRAWER_FULL" || isDFIFull) {
        return "DFS";
      }
      if (displayCode === "DC_CAT_DETECT") {
        return "CD";
      }
      return "RDY";
    }

    // Commented out: Partial drawer full codes are not prioritized for now
    // if (isDFIPartialFull && DFILevelPercent >= 85) {
    //   return "DF2"; // Drawer Almost Full - 1 Cycle Left
    // }
    // if (isDFIPartialFull && DFILevelPercent >= 80) {
    //   return "DF1"; // Drawer Almost Full - 2 Cycles Left
    // }
    // if (isDFIPartialFull && DFILevelPercent >= 70) {
    //   return "DF3"; // Drawer Almost Full - 3+ Cycles Left
    // }
    // TODO: Re-enable partial drawer full thresholds if required by firmware versions

    // Display code mappings (outside of RDY context)
    if (displayCode === "DC_MODE_CYCLE") {
      return "EC"; // Empty Cycle
    }

    // Default fallback
    return "RDY";
  }

  /**
   * @returns {string} Human-readable description for the derived status code.
   */
  get statusDescription() {
    const code = this.statusCode;
    const description = LR4Data.StatusDescriptions[code];
    if (!description) {
      console.log(`Unknown status code mapping for: ${code}`);
    }
    return description || "Unknown Status";
  }

  /**
   * @returns {string} Detailed description for the current robot cycle state.
   */
  get cycleStateDescription() {
    const state = this._robot.robotCycleState;
    return LR4Data.CycleStateStateDescriptions[state] || "Unknown Status";
  }

  async refresh() {
    try {
      const robots = await this._api.getRobots();
      const updated = robots.find(r => r.id === this.id);
      if (!updated) {
        throw new Error(`Robot with id ${this.id} not found during refresh`);
      }
      this._robot = updated;
    } catch (err) {
      console.error('Failed to refresh robot:', err);
      throw err;
    }
  }
}

module.exports = LR4Data;
