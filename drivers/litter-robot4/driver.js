'use strict';

/**
 * LitterRobotDriver integrates Homey.Driver for Litter-Robot 4 pairing and repair flows.
 * Updated to use the new centralized session and data management architecture.
 * @class
 */

const Homey = require('homey');
const LR4Data = require('../../lib/litterrobot4data');

module.exports = class LitterRobotDriver extends Homey.Driver {

  /**
   * Log driver initialization and register all Flow cards.
   * @returns {void}
   */
  async onInit() {
    this.log('LitterRobotDriver has been initialized');

    // Register condition cards
    this.homey.flow.getConditionCard('is_cat_detected')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error('Device or robot data not available for cat detection check');
          return false;
        }
        const lr4Data = new LR4Data({ robot: device.robot });
        const result = lr4Data.isCatDetected;
        this.log(`Cat detection check: result=${result}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_sleep_mode_active')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error('Device or robot data not available for sleep mode check');
          return false;
        }
        const lr4Data = new LR4Data({ robot: device.robot });
        const result = lr4Data.isSleepActive;
        this.log(`Sleep mode check: result=${result}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_waste_drawer_full')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error('Device or robot data not available for waste drawer check');
          return false;
        }
        const lr4Data = new LR4Data({ robot: device.robot });
        const drawerLevel = lr4Data.wasteDrawerLevelPercentage || 0;
        const threshold = device.getSettings().waste_drawer_threshold || 80;
        const result = drawerLevel >= threshold;
        this.log(`Waste drawer check: level=${drawerLevel}%, threshold=${threshold}%, result=${result}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_sleep_mode_scheduled')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error('Device or robot data not available for sleep schedule check');
          return false;
        }
        const deviceSettings = device.getSettings();
        const lr4Data = new LR4Data({ 
          robot: device.robot,
          settings: deviceSettings
        });
        const result = lr4Data.isSleepScheduled;
        this.log(`Sleep schedule check: result=${result}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_cleaning_status')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.robot) {
          this.error('Device or robot data not available for cleaning status check');
          return false;
        }
        const lr4Data = new LR4Data({ robot: device.robot });
        const current = lr4Data.cycleStateDescription;
        const expected = args.status;
        const result = current === expected;
        this.log(`Cleaning status check: current=${current}, expected=${expected}, result=${result}`);
        return result;
      });

    // Register action cards
    this.homey.flow.getActionCard('lock_keypad')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        await device.setCapabilityValue('key_pad_lock_out', true);
      });

    this.homey.flow.getActionCard('unlock_keypad')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        await device.setCapabilityValue('key_pad_lock_out', false);
      });

    this.homey.flow.getActionCard('set_night_light_mode')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        await device.setCapabilityValue('night_light_mode', args.mode);
      });

    this.homey.flow.getActionCard('start_clean_cycle')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        await device.setCapabilityValue('start_clean_cycle', true);
      });

    this.homey.flow.getActionCard('short_reset_press')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        await device.setCapabilityValue('short_reset_press', true);
      });

    this.homey.flow.getActionCard('start_empty_cycle')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        await device.setCapabilityValue('start_empty_cycle', true);
      });

    this.homey.flow.getActionCard('set_clean_cycle_wait_time')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        await device.setCapabilityValue('clean_cycle_wait_time', args.wait_time);
      });

    this.homey.flow.getActionCard('set_panel_brightness')
      .registerRunListener(async (args) => {
        const device = args.device;
        if (!device) {
          throw new Error('Device not found');
        }
        await device.setCapabilityValue('panel_brightness', args.brightness);
      });

    // Register trigger cards (devices will trigger these directly)
    this.homey.flow.getDeviceTriggerCard('waste_drawer_full');
    this.homey.flow.getDeviceTriggerCard('waste_drawer_not_full');
    this.homey.flow.getDeviceTriggerCard('cat_detected');
    this.homey.flow.getDeviceTriggerCard('cat_not_detected');
    this.homey.flow.getDeviceTriggerCard('sleep_mode_activated');
    this.homey.flow.getDeviceTriggerCard('sleep_mode_deactivated');
    
    // Register clean_cycle_multiple trigger with run listener
    this.homey.flow.getDeviceTriggerCard('clean_cycle_multiple')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device) {
          this.error('Device not available for clean cycle multiple check');
          return false;
        }
        
        const totalCycles = device.getCapabilityValue('measure_odometer_clean_cycles');
        const requestedCount = args.count;
        
        this.log(`Flow check [clean_cycle_multiple]: total=${totalCycles}, requested count=${requestedCount}, remainder=${totalCycles % requestedCount}`);
        
        // Trigger only on exact multiples of the user-defined count
        const shouldTrigger = requestedCount > 0 && totalCycles % requestedCount === 0;
        this.log(`Flow decision [clean_cycle_multiple]: will trigger? ${shouldTrigger}`);
        
        return shouldTrigger;
      });
      
    this.homey.flow.getDeviceTriggerCard('problem_details_provided');
  }

  /**
   * Handle device pairing: authenticate user and list available robots.
   * Updated to use centralized session management.
   * @param {object} session Homey pairing session
   * @returns {Promise<void>}
   */
  async onPair(session) {
    // Pairing: handle user login and fetch available robots
    let robots = [];

    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for pairing');
      }
      this.log('Attempting login for user:', username);
      try {
        // Use centralized app session management
        const apiSession = await this.homey.app.initializeSession(username, password);
        // Get robots using the centralized API session
        const robotsResponse = await apiSession.lr4Graphql(`
          query GetLitterRobot4ByUser($userId: String!) {
            getLitterRobot4ByUser(userId: $userId) {
              unitId
              name
              serial
              userId
              robotStatus
              sleepStatus
              setupDateTime
              unitTimezone
            }
          }
        `, { userId: apiSession.getUserId() });
        robots = robotsResponse.data?.getLitterRobot4ByUser || [];
        this.log(`Found ${robots.length} robot(s) for account`);
      } catch (err) {
        this.error('Login or fetching robots failed:', err);
        throw new Error('Login failed: ' + err.message);
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!robots.length) {
        throw new Error('No Litter-Robot devices found for this account');
      }
      return robots.map(robotData => {
        const robotInstance = new LR4Data({ robot: robotData });
        const serialOrId = robotInstance.serial || robotData.unitId;
        return {
          name: robotInstance.name || `Litter-Robot ${serialOrId}`,
          data: { id: String(serialOrId) },
          // No need to store tokens in device settings - they're managed centrally
        };
      });
    });
    
    // Allow adding multiple robots in one pairing session
    session.setHandler('add_devices', async (selectedDevices) => {
      // Homey will pass an array of { name, data, settings } for each checked robot
      return selectedDevices;
    });
  }

  /**
   * Handle device repair: refresh authentication and validate robot connectivity.
   * Updated to use centralized session management.
   * @param {object} session Homey pairing session
   * @param {object} device Homey device instance
   * @returns {Promise<void>}
   */
  async onRepair(session, device) {
    const { id } = device.getData();
    this.log('Repairing device with ID:', id);

    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for repair');
      }
      this.log('Repair login with username:', username);
      
      try {
        // Initialize new session (this will handle both new login and existing session)
        const apiSession = await this.homey.app.initializeSession(username, password);
        
        // Get all robots and find by serial
        const robotsResponse = await apiSession.lr4Graphql(`
          query GetLitterRobot4ByUser($userId: String!) {
            getLitterRobot4ByUser(userId: $userId) {
              unitId
              name
              serial
              userId
              robotStatus
              sleepStatus
              setupDateTime
              unitTimezone
            }
          }
        `, { userId: apiSession.getUserId() });
        
        const robot = robotsResponse.data?.getLitterRobot4ByUser?.find(r => String(r.serial) === String(id));
        if (!robot) {
          throw new Error(`Robot with ID ${id} not found`);
        }
        
        device.robot = robot;
        this.log('Re-authentication successful');
        
        // Trigger device refresh
        await device.refresh();
        this.log('Device repair completed successfully');
        
        return true;
      } catch (err) {
        this.error('Repair login failed:', err);
        throw new Error('Repair login failed: ' + err.message);
      }
    });
  }
}