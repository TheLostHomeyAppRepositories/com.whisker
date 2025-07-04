'use strict';

/**
 * PetDriver integrates Homey.Driver for pet information pairing and repair flows.
 * Updated to use the new centralized session and data management architecture.
 * @class
 */

const Homey = require('homey');
const PetData = require('../../lib/petdata');

module.exports = class PetDriver extends Homey.Driver {

  /**
   * Log driver initialization and register all Flow cards.
   * @returns {void}
   */
  async onInit() {
    this.log('PetDriver has been initialized');

    // Register condition cards
    this.homey.flow.getConditionCard('birthday_today')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        if (!device || !device.petData) {
          this.error('Device or pet data not available for birthday check');
          return false;
        }
        const result = device.petData.isBirthdayToday;
        this.log(`Birthday check for ${device.petData.name}: result=${result}`);
        return result;
      });

    this.homey.flow.getConditionCard('days_until_birthday')
      .registerRunListener(async (args, state) => {
        const device = args.device;
        const days = args.days;
        
        if (!device || !device.petData) {
          this.error('Device or pet data not available for days until birthday check');
          return false;
        }
        
        const threshold = parseInt(days, 10);
        if (isNaN(threshold)) {
          this.error('Invalid days threshold provided:', days);
          return false;
        }
        
        const result = device.petData.isDaysUntilBirthday(threshold);
        this.log(`Days until birthday check for ${device.petData.name}: remaining=${device.petData.daysUntilBirthday}, threshold=${threshold}, result=${result}`);
        return result;
      });

    // Register trigger cards (devices will trigger these directly)
    this.homey.flow.getDeviceTriggerCard('health_concern_detected');
    this.homey.flow.getDeviceTriggerCard('age_changed');
    this.homey.flow.getDeviceTriggerCard('environment_changed');
    this.homey.flow.getDeviceTriggerCard('diet_changed');
  }

  /**
   * Handle device pairing: authenticate user and list available pets.
   * Updated to use centralized session management.
   * @param {object} session Homey pairing session
   * @returns {Promise<void>}
   */
  async onPair(session) {
    // Pairing: handle user login and fetch available pets
    let pets = [];

    // Always require login during pairing
    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for pairing');
      }
      this.log('Attempting login for user:', username);
      try {
        // Use centralized app session management
        const apiSession = await this.homey.app.initializeSession(username, password);
        
        // Get pets using the new session
        pets = await apiSession.getPets();
        this.log(`Found ${pets.length} pet(s) for account`);
      } catch (err) {
        this.error('Login or fetching pets failed:', err);
        throw new Error('Login failed: ' + err.message);
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!pets.length) {
        throw new Error('No pets found for this account');
      }
      return pets.map(petData => {
        const petInstance = new PetData({ pet: petData });
        return {
          name: petInstance.name || `Pet ${petData.petId}`,
          data: { id: String(petData.petId) },
          // No need to store tokens in device settings - they're managed centrally
        };
      });
    });
    
    // Allow adding multiple pets in one pairing session
    session.setHandler('add_devices', async (selectedDevices) => {
      // Homey will pass an array of { name, data, settings } for each checked pet
      return selectedDevices;
    });
  }

  /**
   * Handle device repair: refresh authentication and validate pet connectivity.
   * Updated to use centralized session management.
   * @param {object} session Homey pairing session
   * @param {object} device Homey device instance
   * @returns {Promise<void>}
   */
  async onRepair(session, device) {
    const { id } = device.getData();
    this.log('Repairing device with ID:', id);

    // Always require fresh login during repair
    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for repair');
      }
      this.log('Repair login with username:', username);
      try {
        // Clear any existing session and create a fresh one
        await this.homey.app.signOut();
        
        // Initialize new session with fresh credentials
        const apiSession = await this.homey.app.initializeSession(username, password);
        
        // Verify pet exists using the new session
        const pets = await apiSession.getPets();
        const pet = pets.find(p => String(p.petId) === String(id));
        if (!pet) {
          throw new Error(`Pet with ID ${id} not found`);
        }
        
        device.petData = new PetData({ pet });
        this.log('Re-authentication successful');
      } catch (err) {
        this.error('Repair login failed:', err);
        throw new Error('Repair login failed: ' + err.message);
      }
      return true;
    });
  }
}