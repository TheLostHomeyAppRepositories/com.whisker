const Homey = require('homey');
const { colorize, LOG_COLORS } = require('../../lib/utils');
const { handleCapabilityError } = require('../../lib/notifications');
const LitterRobot3Data = require('../../lib/litterrobot3data');

/**
 * Litter-Robot 3 driver that manages device pairing, repair, and flow card
 * registrations for automation capabilities.
 */
module.exports = class LitterRobot3Driver extends Homey.Driver {

  /**
   * Registers all flow cards (condition, action, and trigger cards) during
   * driver initialization. Flow cards enable users to create automations
   * based on device state and trigger device actions.
   */
  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing LitterRobot3Driver...'));

    this.homey.flow.getConditionCard('LR3_is_sleep_mode_active')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for sleep mode active check'));
          return false;
        }
        const isSleepActive = device.getCapabilityValue('alarm_sleep_mode_active');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_sleep_mode_active]: result=${isSleepActive}`)}`);
        return isSleepActive;
      });

    this.homey.flow.getConditionCard('LR3_is_sleep_mode_scheduled')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for sleep mode scheduled check'));
          return false;
        }
        const isSleepScheduled = device.getCapabilityValue('alarm_sleep_mode_scheduled');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [alarm_sleep_mode_scheduled]: result=${isSleepScheduled}`)}`);
        return isSleepScheduled;
      });

    this.homey.flow.getConditionCard('LR3_is_clean_cycle_status')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for clean cycle status check'));
          return false;
        }
        const currentStatus = device.getCapabilityValue('clean_cycle_status');
        const expectedStatus = args.status;
        const result = currentStatus === expectedStatus;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [clean_cycle_status]: current=${currentStatus}, expected=${expectedStatus}, result=${result}`)}`);
        return result;
      });

    this.homey.flow.getConditionCard('LR3_is_litter_robot_status')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device not available for litter robot status check'));
          return false;
        }
        const currentStatus = device.getCapabilityValue('litter_robot_status');
        const expectedStatus = args.status;
        const result = currentStatus === expectedStatus;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [litter_robot_status]: current=${currentStatus}, expected=${expectedStatus}, result=${result}`)}`);
        return result;
      });

    this.homey.flow.getConditionCard('LR3_is_cat_detected')
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

    this.homey.flow.getConditionCard('LR3_is_waste_drawer_full')
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

    this.homey.flow.getActionCard('LR3_lock_keypad')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [lock_keypad] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('key_pad_lock_out', true);
      });

    this.homey.flow.getActionCard('LR3_unlock_keypad')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [unlock_keypad] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('key_pad_lock_out', false);
      });

    this.homey.flow.getActionCard('LR3_start_clean_cycle')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [start_clean_cycle] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('start_clean_cycle', true);
      });

    this.homey.flow.getActionCard('LR3_turn_on_night_light')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [turn_on_night_light] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('night_light_enabled', true);
      });

    this.homey.flow.getActionCard('LR3_turn_off_night_light')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [turn_off_night_light] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('night_light_enabled', false);
      });

    this.homey.flow.getActionCard('LR3_set_cycle_delay')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        const minutes = String(args.minutes);
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [set_cycle_delay] executed for device: ${device.getName()}, minutes: ${minutes}`)}`);
        await device.triggerCapabilityListener('cycle_delay', minutes);
        await device.setCapabilityValue('cycle_delay', minutes).catch((err) => {
          handleCapabilityError(err, 'cycle_delay', 'update', this);
        });
      });

    this.homey.flow.getActionCard('LR3_toggle_night_light')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        const current = device.getCapabilityValue('night_light_enabled');
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [toggle_night_light] executed for device: ${device.getName()}, current state: ${current}`)}`);
        await device.triggerCapabilityListener('night_light_enabled', !current);
      });

    this.homey.flow.getActionCard('LR3_reset_waste_drawer')
      .registerRunListener(async (args) => {
        const { device } = args;
        if (!device) {
          throw new Error('Device not found');
        }
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Action [reset_waste_drawer] executed for device: ${device.getName()}`)}`);
        await device.triggerCapabilityListener('reset_waste_drawer', true);
      });

    this.homey.flow.getDeviceTriggerCard('LR3_clean_cycle_multiple')
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

    this.log(colorize(LOG_COLORS.SUCCESS, 'LitterRobot3Driver initialization completed'));
  }

  /**
   * Handles device pairing flow: authenticates user credentials, fetches
   * available LR3 robots from the API, and returns device list for user selection.
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
        robots = robotsData.lr3;
        this.log(colorize(LOG_COLORS.SUCCESS, `Found ${robots.length} LR3 robot(s) for account`));
      } catch (err) {
        this.error(colorize(LOG_COLORS.ERROR, `Login or fetching robots failed: ${err.message}`));
        throw new Error(`Login failed: ${err.message}`);
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!robots.length) {
        this.log(colorize(LOG_COLORS.INFO, 'No LR3 robots found, cleaning up session...'));
        try {
          await this.homey.app.onUninit();
        } catch (err) {
          this.log(colorize(LOG_COLORS.WARNING, `Failed to cleanup session: ${err.message}`));
        }
        throw new Error('No Litter-Robot 3 found for this account');
      }
      return robots.map((robotData) => {
        const nickname = robotData.litterRobotNickname || 'Litter-Robot 3';
        const serial = robotData.litterRobotSerial || 'Unknown';
        const deviceName = `${nickname} (${serial})`;

        return {
          name: deviceName,
          data: {
            id: robotData.litterRobotSerial,
            robotId: robotData.litterRobotId,
          },
        };
      });
    });
  }

  /**
   * Handles device repair flow by re-authenticating user credentials and
   * re-establishing connection to the specific robot. Signs out existing session
   * first to ensure clean authentication state.
   * @param {Object} session - Homey repair session object
   * @param {Object} device - Device instance being repaired
   */
  async onRepair(session, device) {
    const { id } = device.getData();
    this.log(colorize(LOG_COLORS.INFO, `Repairing LR3 device with serial: ${id}`));

    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for repair');
      }
      this.log(colorize(LOG_COLORS.INFO, `Repair login with username: ${username}`));
      try {
        await this.homey.app.signOut();
        const apiSession = await this.homey.app.initializeSession(username, password);
        const robotsData = await apiSession.getRobots();
        const robot = robotsData.lr3.find((r) => String(r.litterRobotSerial) === String(id));
        if (!robot) {
          throw new Error(`LR3 Robot with serial ${id} not found`);
        }

        device.robot = robot;
        this.log(colorize(LOG_COLORS.SUCCESS, 'Re-authentication successful'));
      } catch (err) {
        this.error(colorize(LOG_COLORS.ERROR, `Repair login failed: ${err.message}`));
        throw new Error(`Repair login failed: ${err.message}`);
      }
      return true;
    });
  }
};
