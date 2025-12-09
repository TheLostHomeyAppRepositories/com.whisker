const Homey = require('homey');
const { colorize, LOG_COLORS } = require('../../lib/utils');

/**
 * Litter-Robot 4 driver that manages device pairing, repair, and flow card
 * registrations for automation capabilities.
 */
module.exports = class LitterRobotDriver extends Homey.Driver {

  /**
   * Registers all flow cards (condition, action, and trigger cards) during
   * driver initialization. Flow cards enable users to create automations
   * based on device state and trigger device actions.
   */
  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing LitterRobotDriver...'));

    this.homey.flow.getConditionCard('is_cat_detected')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for cat detection check'));
          return false;
        }
        const isCatDetected = device.getCapabilityValue('alarm_cat_detected');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_cat_detected]: result=${isCatDetected}`)}`);
        return isCatDetected;
      });

    this.homey.flow.getConditionCard('is_sleep_mode_active')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for sleep mode check'));
          return false;
        }
        const isSleepActive = device.getCapabilityValue('alarm_sleep_mode_active');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_sleep_mode_active]: result=${isSleepActive}`)}`);
        return isSleepActive;
      });

    this.homey.flow.getConditionCard('is_waste_drawer_full')
      .registerRunListener(async (args, state) => {
        const { device } = args;
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
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for sleep schedule check'));
          return false;
        }
        const isSleepScheduled = device.getCapabilityValue('alarm_sleep_mode_scheduled');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_sleep_mode_scheduled]: result=${isSleepScheduled}`)}`);
        return isSleepScheduled;
      });

    this.homey.flow.getConditionCard('is_cleaning_status')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for cleaning status check'));
          return false;
        }
        const currentStatus = device.getCapabilityValue('clean_cycle_status');
        const expectedStatus = args.status;
        const result = currentStatus === expectedStatus;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [clean_cycle_status]: current=${currentStatus}, expected=${expectedStatus}, result=${result}`)}`);
        return result;
      });

    this.homey.flow.getConditionCard('is_litter_hopper_empty')
      .registerRunListener(async (args) => {
        const { device } = args;
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
        const { device } = args;
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
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for Litter-Robot status check'));
          return false;
        }
        const currentStatus = device.getCapabilityValue('litter_robot_status');
        const expectedStatus = args.status;
        const result = currentStatus === expectedStatus;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [litter_robot_status]: current=${currentStatus}, expected=${expectedStatus}, result=${result}`)}`);
        return result;
      });

    this.homey.flow.getActionCard('lock_keypad')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [lock_keypad] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('key_pad_lock_out', true);
      });

    this.homey.flow.getActionCard('unlock_keypad')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [unlock_keypad] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('key_pad_lock_out', false);
      });

    this.homey.flow.getActionCard('set_night_light_mode')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [set_night_light_mode] executed for device: ${device.getName()} with mode: ${args.mode}`)}`);
        await device.triggerCapabilityListener('night_light_mode', args.mode);
      });

    this.homey.flow.getActionCard('start_clean_cycle')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [start_clean_cycle] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('start_clean_cycle', true);
      });

    this.homey.flow.getActionCard('short_reset_press')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [short_reset_press] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('short_reset_press', true);
      });

    this.homey.flow.getActionCard('start_empty_cycle')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [start_empty_cycle] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('start_empty_cycle', true);
      });

    this.homey.flow.getActionCard('set_clean_cycle_wait_time')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [set_clean_cycle_wait_time] executed for device: ${device.getName()} with wait time: ${args.wait_time} minutes`)}`);
        await device.triggerCapabilityListener('clean_cycle_wait_time', args.wait_time);
      });

    this.homey.flow.getActionCard('set_panel_brightness')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [set_panel_brightness] executed for device: ${device.getName()} with brightness: ${args.brightness}`)}`);
        await device.triggerCapabilityListener('panel_brightness', args.brightness);
      });

    this.homey.flow.getActionCard('set_night_light_brightness')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [set_night_light_brightness] executed for device: ${device.getName()} with brightness: ${args.brightness}`)}`);
        await device.triggerCapabilityListener('night_light_brightness', args.brightness);
      });

    this.homey.flow.getDeviceTriggerCard('clean_cycle_multiple')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for clean cycle multiple check'));
          return false;
        }

        const totalCycles = device.getCapabilityValue('measure_odometer_clean_cycles');
        const requestedCount = args.count;

        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, 'Condition check [measure_odometer_clean_cycles]: '
          + `total=${totalCycles}, requested count=${requestedCount}, `
          + `remainder=${totalCycles % requestedCount}`)}`);

        const shouldTrigger = requestedCount > 0 && totalCycles % requestedCount === 0;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition decision [clean_cycle_multiple]: trigger condition met? ${shouldTrigger}`)}`);

        return shouldTrigger;
      });

    this.log(colorize(LOG_COLORS.SUCCESS, 'LitterRobotDriver initialization completed successfully'));
  }

  /**
   * Handles device pairing flow: authenticates user credentials, fetches
   * available LR4 robots from the API, and returns device list for user selection.
   * Cleans up session if no robots are found.
   * @param {Object} session - Homey pairing session object
   */
  async onPair(session) {
    let robots = [];

    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for pairing');
      }
      this.log(colorize(LOG_COLORS.INFO, `Attempting login for user: ${username}`));
      try {
        const apiSession = await this.homey.app.initializeSession(username, password);
        const robotsData = await apiSession.getRobots();
        robots = robotsData.lr4;
        this.log(colorize(LOG_COLORS.SUCCESS, `Found ${robots.length} LR4 robot(s) for account`));
      } catch (err) {
        throw new Error(err.message);
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!robots.length) {
        this.log(colorize(LOG_COLORS.INFO, 'No robots found, cleaning up session...'));
        try {
          await this.homey.app.onUninit();
        } catch (err) {
          this.log(colorize(LOG_COLORS.WARNING, `Failed to cleanup session: ${err.message}`));
        }
        throw new Error('No robots found for this account');
      }
      return robots.map((robotData) => {
        const nickname = robotData.nickname || 'Litter-Robot 4';
        const serial = robotData.serial || 'Unknown';
        const deviceName = `${nickname} (${serial})`;

        return {
          name: deviceName,
          data: { id: robotData.serial },
        };
      });
    });
  }

  /**
   * Handles device repair flow by re-authenticating user credentials and
   * re-establishing connection to the specific robot. Validates credentials
   * and device access before destroying the existing session.
   * @param {Object} session - Homey repair session object
   * @param {Object} device - Device instance being repaired
   */
  async onRepair(session, device) {
    const { id } = device.getData();
    this.log(colorize(LOG_COLORS.INFO, `Repairing device with ID: ${id}`));

    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for repair');
      }
      this.log(colorize(LOG_COLORS.INFO, `Repair login with username: ${username}`));
      try {
        const tempSession = await this.homey.app.validateCredentials(username, password);
        
        const robotsData = await tempSession.getRobots();
        const robot = robotsData.lr4.find((r) => String(r.serial) === String(id));
        if (!robot) {
          throw new Error(`Robot with ID ${id} not found`);
        }

        await this.homey.app.signOut();
        await this.homey.app.initializeSession(username, password);
        
        await device._fetchRobotData();
        this.log(colorize(LOG_COLORS.SUCCESS, 'Re-authentication successful'));
      } catch (err) {
        throw new Error(err.message);
      }
      return true;
    });
  }
};
