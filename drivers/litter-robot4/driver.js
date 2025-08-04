'use strict';

/**
 * LitterRobotDriver integrates Homey.Driver for Litter-Robot 4 pairing and repair flows.
 * Provides comprehensive Flow automation integration with centralized session management.
 * @class
 */

const Homey = require('homey');
const LR4Data = require('../../lib/litterrobot4data');
const { colorize, LOG_COLORS } = require('../../lib/utils');

module.exports = class LitterRobotDriver extends Homey.Driver {

  /**
   * Initializes the driver and registers all Flow automation cards.
   * Establishes condition, action, and trigger cards for comprehensive device automation.
   * @returns {void}
   */
  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing LitterRobotDriver...'));

    // Register condition cards for Flow automation logic
    this.homey.flow.getConditionCard('is_cat_detected')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device or robot data not available for cat detection check'));
          return false;
        }
        const deviceSettings = device.getSettings();
        const lr4Data = new LR4Data({ robot: device.robot, settings: deviceSettings });
        const result = lr4Data.isCatDetected;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_cat_detected]: result=${result}`)}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_sleep_mode_active')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device or robot data not available for sleep mode check'));
          return false;
        }
        const deviceSettings = device.getSettings();
        const lr4Data = new LR4Data({ robot: device.robot, settings: deviceSettings });
        const result = lr4Data.isSleepActive;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_sleep_mode_active]: result=${result}`)}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_waste_drawer_full')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for waste drawer check'));
          return false;
        }
        const isDrawerFull = device.getCapabilityValue('alarm_waste_drawer_full');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_waste_drawer_full]: result=${isDrawerFull}`)}`);
        return isDrawerFull;
      });

    this.homey.flow.getConditionCard('is_sleep_mode_scheduled')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device or robot data not available for sleep schedule check'));
          return false;
        }
        const deviceSettings = device.getSettings();
        const lr4Data = new LR4Data({ 
          robot: device.robot,
          settings: deviceSettings
        });
        const result = lr4Data.isSleepScheduled;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_sleep_mode_scheduled]: result=${result}`)}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_cleaning_status')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device or robot data not available for cleaning status check'));
          return false;
        }
        const deviceSettings = device.getSettings();
        const lr4Data = new LR4Data({ robot: device.robot, settings: deviceSettings });
        const current = lr4Data.cycleStateDescription;
        const expected = args.status;
        const result = current === expected;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [clean_cycle_status]: current=${current}, expected=${expected}, result=${result}`)}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_litter_hopper_empty')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for hopper empty check'));
          return false;
        }
        
        const isHopperEmpty = device.getCapabilityValue('alarm_litter_hopper_empty');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_litter_hopper_empty]: result=${isHopperEmpty}`)}`);
        return isHopperEmpty;
      });
      
    this.homey.flow.getConditionCard('is_litter_hopper_enabled')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for hopper enabled check'));
          return false;
        }
        
        const isHopperEnabled = device.getCapabilityValue('litter_hopper_enabled');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [litter_hopper_enabled]: result=${isHopperEnabled}`)}`);
        return isHopperEnabled;
      });

    this.homey.flow.getConditionCard('is_litter_robot_status')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device or robot data not available for Litter-Robot status check'));
          return false;
        }
        const deviceSettings = device.getSettings();
        const lr4Data = new LR4Data({ robot: device.robot, settings: deviceSettings });
        const current = lr4Data.statusDescription;
        const expected = args.status;
        const result = current === expected;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [litter_robot_status]: current=${current}, expected=${expected}, result=${result}`)}`);
        return result;
      });

    // Register action cards for device control
    this.homey.flow.getActionCard('lock_keypad')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [lock_keypad] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('key_pad_lock_out', true);
      });

    this.homey.flow.getActionCard('unlock_keypad')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [unlock_keypad] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('key_pad_lock_out', false);
      });

    this.homey.flow.getActionCard('set_night_light_mode')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [set_night_light_mode] executed for device: ${device.getName()} with mode: ${args.mode}`)}`);
        await device.triggerCapabilityListener('night_light_mode', args.mode);
      });

    this.homey.flow.getActionCard('start_clean_cycle')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [start_clean_cycle] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('start_clean_cycle', true);
      });

    this.homey.flow.getActionCard('short_reset_press')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [short_reset_press] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('short_reset_press', true);
      });

    this.homey.flow.getActionCard('start_empty_cycle')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [start_empty_cycle] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('start_empty_cycle', true);
      });

    this.homey.flow.getActionCard('set_clean_cycle_wait_time')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [set_clean_cycle_wait_time] executed for device: ${device.getName()} with wait time: ${args.wait_time} minutes`)}`);
        await device.triggerCapabilityListener('clean_cycle_wait_time', args.wait_time);
      });

    this.homey.flow.getActionCard('set_panel_brightness')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [set_panel_brightness] executed for device: ${device.getName()} with brightness: ${args.brightness}`)}`);
        await device.triggerCapabilityListener('panel_brightness', args.brightness);
      });

    // Register trigger cards for event-driven automation
    
    // Manual triggers for state changes
    this.homey.flow.getDeviceTriggerCard('litter_hopper_empty');
    this.homey.flow.getDeviceTriggerCard('litter_hopper_not_empty');
    
    // Smart trigger for clean cycle milestones
    this.homey.flow.getDeviceTriggerCard('clean_cycle_multiple')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for clean cycle multiple check'));
          return false;
        }
        
        const totalCycles = device.getCapabilityValue('measure_odometer_clean_cycles');
        const requestedCount = args.count;
        
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [measure_odometer_clean_cycles]: total=${totalCycles}, requested count=${requestedCount}, remainder=${totalCycles % requestedCount}`)}`);
        
        // Trigger only when total cycles reach exact multiples of the user-defined count
        const shouldTrigger = requestedCount > 0 && totalCycles % requestedCount === 0;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition decision [clean_cycle_multiple]: trigger condition met? ${shouldTrigger}`)}`);
        
        return shouldTrigger;
      });
      
    this.homey.flow.getDeviceTriggerCard('problem_details_provided');

    this.log(colorize(LOG_COLORS.SUCCESS, 'LitterRobotDriver initialization completed successfully'));
  }

  /**
   * Handles device pairing by authenticating user credentials and discovering available robots.
   * Uses centralized session management to avoid storing tokens per device.
   * @param {object} session Homey pairing session
   * @returns {Promise<void>}
   */
  async onPair(session) {
    // Discover available robots for the authenticated account
    let robots = [];

    // Require fresh authentication for pairing
    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for pairing');
      }
      this.log(colorize(LOG_COLORS.INFO, `Attempting login for user: ${username}`));
      try {
        // Initialize centralized session for all device operations
        const apiSession = await this.homey.app.initializeSession(username, password);
        
        // Discover robots associated with the authenticated account
        robots = await apiSession.getRobots();
        this.log(colorize(LOG_COLORS.SUCCESS, `Found ${robots.length} robot(s) for account`));
      } catch (err) {
        this.error(colorize(LOG_COLORS.ERROR, `Login or fetching robots failed: ${err.message}`));
        throw new Error('Login failed: ' + err.message);
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!robots.length) {
        throw new Error('No robots found for this account');
      }
      return robots.map(robotData => {
        const nickname = robotData.nickname || 'Litter-Robot 4';
        const serial = robotData.serial || 'Unknown';
        const deviceName = `${nickname} (${serial})`;
        
        return {
          name: deviceName,
          data: { id: robotData.serial },
          // Tokens managed centrally, no device-level storage needed
        };
      });
    });
  }

  /**
   * Handles device repair by refreshing authentication and validating robot connectivity.
   * Ensures device can still access the robot through centralized session management.
   * @param {object} session Homey pairing session
   * @param {object} device Homey device instance
   * @returns {Promise<void>}
   */
  async onRepair(session, device) {
    const { id } = device.getData();
    this.log(colorize(LOG_COLORS.INFO, `Repairing device with ID: ${id}`));

    // Require fresh authentication to validate current credentials
    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for repair');
      }
      this.log(colorize(LOG_COLORS.INFO, `Repair login with username: ${username}`));
      try {
        // Clear existing session to ensure fresh authentication
        await this.homey.app.signOut();
        
        // Establish new session with provided credentials
        const apiSession = await this.homey.app.initializeSession(username, password);
        
        // Validate robot still exists in the authenticated account
        const robots = await apiSession.getRobots();
        const robot = robots.find(r => String(r.serial) === String(id));
        if (!robot) {
          throw new Error(`Robot with ID ${id} not found`);
        }
        
        this.log(colorize(LOG_COLORS.SUCCESS, 'Re-authentication successful'));
      } catch (err) {
        this.error(colorize(LOG_COLORS.ERROR, `Repair login failed: ${err.message}`));
        throw new Error('Repair login failed: ' + err.message);
      }
      return true;
    });
  }
}