'use strict';

/**
 * LitterRobotDriver integrates Homey.Driver for Litter-Robot 4 pairing and repair flows.
 * @class
 */

const Homey = require('homey');
const WhiskerApi = require('../../lib/WhiskerApi');
const WhiskerRobot = require('../../lib/WhiskerRobot');

module.exports = class LitterRobotDriver extends Homey.Driver {

  /**
   * Log driver initialization.
   * @returns {void}
   */
  onInit() {
    this.log('Litter-Robot 4 driver initialized');
  }

  /**
   * Handle device pairing: authenticate user and list available robots.
   * @param {object} session Homey pairing session
   * @returns {Promise<void>}
   */
  async onPair(session) {
    // Pairing: handle user login and fetch available robots
    let tokens = null;
    let api;
    let robots = [];

    session.setHandler('login', async ({ username, password }) => {
      if (!username || !password) {
        throw new Error('Username and password are required for pairing');
      }
      this.log('Attempting login for user:', username);
      const authApi = new WhiskerApi({ email: username, password });
      try {
        await authApi.login();
        tokens = authApi.tokens;
        this.log(`Login successful, fetched tokens`);
        robots = await authApi.getRobots();
        this.log(`Found ${robots.length} robot(s) for account`);
        api = authApi;
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
        const robotInstance = new WhiskerRobot({ robot: robotData, api });
        const serialOrId = robotInstance.serial || robotData.id;
        return {
          name: robotInstance.nickname || `Litter-Robot ${serialOrId}`,
          data: { id: String(serialOrId) },
          settings: { tokens },
        };
      });
    });
  }

  /**
   * Handle device repair: refresh authentication and validate robot connectivity.
   * @param {object} session Homey pairing session
   * @param {object} device Homey device instance
   * @returns {Promise<void>}
   */
  async onRepair(session, device) {
    const { id } = device.getData();
    const { tokens } = device.getSettings();
    this.log('Repairing device with ID:', id);

    // Option 1: Try silent token refresh if valid tokens exist
    if (tokens?.refresh_token) {
      session.setHandler('login', async () => {
        this.log('Attempting silent session refresh for device ID:', id);
        let authApi;
        try {
          authApi = new WhiskerApi({ tokens });
          await authApi.cognitoSession.refreshSession();
          const refreshedTokens = authApi.getTokens();
          if (refreshedTokens) {
            this.log('Tokens returned by getTokens():', refreshedTokens);
            await device.setSettings({ tokens: refreshedTokens });
            this.log('Token refresh successful');
          }
          const robot = await authApi.getRobot(String(id));
          device.robot = robot;
          this.log('Fetched robot data for repair');
        } catch (err) {
          this.error('Silent repair failed:', err);
          throw new Error('Silent repair failed: ' + err.message);
        }
        return true;
      });
    } else {
      // Option 2: Prompt user to log in again
      session.setHandler('login', async ({ username, password }) => {
        if (!username || !password) {
          throw new Error('Username and password are required for repair');
        }
        this.log('Repair login with username:', username);
        const authApi = new WhiskerApi({ email: username, password });
        try {
          await authApi.login();
          const refreshedTokens = authApi.getTokens();
          if (refreshedTokens) {
            this.log('Tokens returned by getTokens():', refreshedTokens);
            await device.setSettings({ tokens: refreshedTokens });
            this.log('Re-authentication successful, tokens saved');
          }
          const robot = await authApi.getRobot(String(id));
          device.robot = robot;
          this.log('Fetched robot data after login');
        } catch (err) {
          this.error('Repair login failed:', err);
          throw new Error('Repair login failed: ' + err.message);
        }
        return true;
      });
    }
  }

};