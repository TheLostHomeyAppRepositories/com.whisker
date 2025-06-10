'use strict';

/**
 * PetDriver integrates Homey.Driver for cat info pairing and repair flows.
 * @class
 */

const Homey = require('homey');
const PetApi = require('../../lib/PetApi');

module.exports = class PetDriver extends Homey.Driver {

  /**
   * Log driver initialization.
   * @returns {void}
   */
  onInit() {
    this.log('Pet Information driver initialized');
  }

  /**
   * Handle device pairing: authenticate user and list available pets.
   * @param {object} session Homey pairing session
   * @returns {Promise<void>}
   */
  async onPair(session) {
    let tokens = null;
    let api;
    let pets = [];

    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for pairing');
      }
      this.log('Attempting login for user:', username);
      this.log('Calling loginAndGetTokens...');
      try {
        // Reuse loginAndGetTokens just to get tokens, PetApi requires valid tokens
        const { loginAndGetTokens } = require('../../lib/CognitoSession');
        tokens = await loginAndGetTokens(username, password);
        this.log('Tokens obtained:', tokens);
        api = new PetApi({ tokens, log: this.log, error: this.error });
        this.log('PetApi instantiated, calling getPets...');
        pets = await api.getPets();
        this.log(`Fetched pets array:`, pets);
        this.log(`Found ${pets.length} pet(s) for account`);
      } catch (err) {
        this.error('Login or fetching pets failed:', err);
        throw new Error('Login failed: ' + err.message);
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      this.log('list_devices called, pets:', pets);
      if (!pets.length) {
        throw new Error('No pets found for this account');
      }
      return pets.map(pet => {
        return {
          name: pet.name || `Cat ${pet.petId}`,
          data: { id: String(pet.petId) },
          settings: { tokens },
        };
      });
    });
    // Allow adding multiple pets in one pairing session
    session.setHandler('add_devices', async (selectedDevices) => {
      this.log('add_devices called, selectedDevices:', selectedDevices);
      // Homey will pass an array of { name, data, settings } for each checked pet
      return selectedDevices;
    });
  }

  /**
   * Handle device repair: refresh authentication and validate pet connectivity.
   * @param {object} session Homey pairing session
   * @param {object} device Homey device instance
   * @returns {Promise<void>}
   */
  async onRepair(session, device) {
    const { id } = device.getData();
    const { tokens } = device.getSettings();
    this.log('Repairing device with ID:', id);

    if (tokens?.refresh_token) {
      session.setHandler('login', async () => {
        this.log('Attempting silent session refresh for device ID:', id);
        try {
          const { default: LR4Api } = await import('../../lib/LR4Api.js');
          const authApi = new LR4Api({ tokens });
          await authApi.cognitoSession.refreshSession();
          const refreshedTokens = authApi.getTokens();
          if (refreshedTokens) {
            await device.setSettings({ tokens: refreshedTokens });
            this.log('Token refresh successful');
          }
        } catch (err) {
          this.error('Silent repair failed:', err);
          throw new Error('Silent repair failed: ' + err.message);
        }
        return true;
      });
    } else {
      session.setHandler('login', async ({ username, password }) => {
        if (!username || !password) {
          throw new Error('Username and password are required for repair');
        }
        this.log('Repair login with username:', username);
        try {
          const { loginAndGetTokens } = require('../../lib/CognitoSession');
          const refreshedTokens = await loginAndGetTokens(username, password);
          if (refreshedTokens) {
            await device.setSettings({ tokens: refreshedTokens });
            this.log('Re-authentication successful, tokens saved');
          }
        } catch (err) {
          this.error('Repair login failed:', err);
          throw new Error('Repair login failed: ' + err.message);
        }
        return true;
      });
    }
  }

};