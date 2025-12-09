/**
 * PetDriver manages pet information devices for the Whisker app.
 * Handles device pairing, repair flows, and Flow card registration for pet-related automation.
 * Uses centralized session management for authentication and data access.
 */

const Homey = require('homey');
const PetData = require('../../lib/petdata');
const { colorize, LOG_COLORS } = require('../../lib/utils');

module.exports = class PetDriver extends Homey.Driver {

  /**
   * Initialize the driver and register Flow cards for pet automation.
   * Sets up condition cards for birthday checks and trigger cards for pet data changes.
   */
  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing Pet driver...'));

    this.homey.flow.getConditionCard('birthday_today')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        if (!device || !device.petData) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device or pet data not available for birthday check'));
          return false;
        }
        const result = device.petData.isBirthdayToday;
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Condition check [label_birthday]: pet=${device.petData.pet?.name || 'Unknown'}, result=${result}`)}`);
        return result;
      });

    this.homey.flow.getConditionCard('days_until_birthday')
      .registerRunListener(async (args, state) => {
        const { device } = args;
        const { days } = args;

        if (!device || !device.petData) {
          this.error(colorize(LOG_COLORS.ERROR, 'Device or pet data not available for days until birthday check'));
          return false;
        }

        const threshold = parseInt(days, 10);
        if (Number.isNaN(threshold)) {
          this.error(colorize(LOG_COLORS.ERROR, `Invalid days threshold provided: ${days}`));
          return false;
        }

        const result = device.petData.isDaysUntilBirthday(threshold);
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, 'Condition check [label_birthday]: '
          + `pet=${device.petData.pet?.name || 'Unknown'}, remaining=${device.petData.daysUntilBirthday}, `
          + `threshold=${threshold}, result=${result}`)}`);
        return result;
      });

    this.homey.flow.getDeviceTriggerCard('health_concern_detected');
    this.homey.flow.getDeviceTriggerCard('age_changed');
    this.homey.flow.getDeviceTriggerCard('environment_changed');
    this.homey.flow.getDeviceTriggerCard('diet_changed');

    this.log(colorize(LOG_COLORS.SUCCESS, 'Pet driver initialization completed successfully'));
  }

  /**
   * Handle device pairing flow for pet information devices.
   * Authenticates user credentials and discovers available pets from the Whisker account.
   * Uses centralized session management to avoid storing tokens in device settings.
   * @param {object} session Homey pairing session
   */
  async onPair(session) {
    let pets = [];

    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for pairing');
      }
      this.log(colorize(LOG_COLORS.INFO, `Attempting login for user: ${username}`));
      try {
        const apiSession = await this.homey.app.initializeSession(username, password);
        pets = await apiSession.getPets();
        this.log(colorize(LOG_COLORS.SUCCESS, `Found ${pets.length} pet(s) for account`));
      } catch (err) {
        throw new Error(err.message);
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!pets.length) {
        throw new Error('No pets found for this account');
      }
      return pets.map((petData) => {
        return {
          name: petData.name || `Pet ${petData.petId}`,
          data: { id: String(petData.petId) },
        };
      });
    });

    session.setHandler('add_devices', async (selectedDevices) => {
      return selectedDevices;
    });
  }

  /**
   * Handle device repair flow for pet information devices.
   * Validates credentials and verifies that the pet still exists in the account
   * before destroying the existing session. Uses centralized session management
   * to ensure secure re-authentication.
   * @param {object} session Homey pairing session
   * @param {object} device Homey device instance
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
        
        const pets = await tempSession.getPets();
        const pet = pets.find((p) => String(p.petId) === String(id));
        if (!pet) {
          throw new Error(`Pet with ID ${id} not found`);
        }

        await this.homey.app.signOut();
        const apiSession = await this.homey.app.initializeSession(username, password);
        
        device.petData = new PetData({ pet });
        this.log(colorize(LOG_COLORS.SUCCESS, 'Re-authentication successful'));
      } catch (err) {
        throw new Error(err.message);
      }
      return true;
    });
  }
};
