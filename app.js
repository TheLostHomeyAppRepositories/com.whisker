'use strict';

const Homey = require('homey');
const WhiskerClient = require('./lib/whiskerclient');
const DataManager = require('./lib/datamanager');
const { colorize, LOG_COLORS } = require('./lib/utils');

/**
 * Main application class for the Whisker Homey app.
 * Manages centralized authentication, data management, and device coordination
 * for all Whisker devices (Litter-Robot 4, pet tracking, etc.).
 */
class WhiskerApp extends Homey.App {

  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing Whisker app...'));
    this.client = new WhiskerClient(this.homey);
    this._initializeDataManagement();
    await this._restoreSessionFromStorage();
    this.log(colorize(LOG_COLORS.SUCCESS, 'Whisker app initialization completed successfully'));
  }

  /**
   * Initializes the data management system to handle cross-device communication
   * and centralized data processing for all Whisker devices.
   */
  _initializeDataManagement() {
    this._dataManager = null;
    this.log(colorize(LOG_COLORS.INFO, 'Data management system initialized'));
  }

  /**
   * Attempts to restore user session from stored authentication tokens.
   * This enables seamless app restarts without requiring re-authentication
   * when valid tokens are available.
   */
  async _restoreSessionFromStorage() {
    try {
      const storedTokens = this.homey.settings.get('cognito_tokens');
      if (storedTokens) {
        this.log(colorize(LOG_COLORS.INFO, 'Found stored tokens, attempting to restore session...'));
        const loggedIn = await this.client.loginWithTokens(storedTokens);
        if (loggedIn) {
            this._dataManager = new DataManager(this.client.apiSession, this.homey);
            await this._reRegisterAllDevices();
            this.log(colorize(LOG_COLORS.SUCCESS, 'Session restored successfully from stored tokens'));
        }
      } else {
        this.log(colorize(LOG_COLORS.WARNING, 'No valid stored session found, user will need to authenticate'));
      }
    } catch (error) {
      this.error(colorize(LOG_COLORS.ERROR, 'Error restoring session from storage:'), error.message);
      this.homey.settings.unset('cognito_tokens');
    }
  }

  /**
   * Initializes a new API session using user credentials.
   * Creates the data manager and re-registers all devices to ensure
   * they have access to the new session and can communicate properly.
   */
  async initializeSession(username, password) {
    if (this.client.isAuthenticated()) {
      this.log(colorize(LOG_COLORS.WARNING, 'API session already initialized'));
      return this.client.apiSession;
    }

    this.log(colorize(LOG_COLORS.INFO, 'Initializing API session with credentials...'));

    try {
      const loggedIn = await this.client.login(username, password);
      if (loggedIn) {
        this._dataManager = new DataManager(this.client.apiSession, this.homey);
        await this._reRegisterAllDevices();
        this.log(colorize(LOG_COLORS.SUCCESS, 'API session initialized successfully'));
        return this.client.apiSession;
      }
      return null;
    } catch (error) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to initialize API session:'), error);
      throw error;
    }
  }

  /**
   * Re-registers all existing devices with the new data manager instance.
   * This ensures all devices can communicate with the centralized data system
   * after session restoration or re-authentication.
   */
  async _reRegisterAllDevices() {
    this.log(colorize(LOG_COLORS.INFO, 'Re-registering all devices with new DataManager...'));

    try {
      const drivers = await this.homey.drivers.getDrivers();

      for (const driver of Object.values(drivers)) {
        const driverDevices = await driver.getDevices();

        for (const device of driverDevices) {
          try {
            this.log(colorize(LOG_COLORS.INFO, `Re-registering device ${device.getName()} with DataManager...`));
            if (typeof device._registerWithDataManager === 'function') {
              await device._registerWithDataManager();
              this.log(colorize(LOG_COLORS.SUCCESS, `Device ${device.getName()} re-registered successfully`));
            } else {
              this.log(colorize(LOG_COLORS.WARNING, `Device ${device.getName()} has no _registerWithDataManager method, skipping`));
            }
          } catch (error) {
            this.error(colorize(LOG_COLORS.ERROR, `Failed to re-register device ${device.getName()}:`), error);
          }
        }
      }

      this.log(colorize(LOG_COLORS.SUCCESS, 'Device re-registration completed successfully'));
    } catch (error) {
      this.error(colorize(LOG_COLORS.ERROR, 'Error during device re-registration:'), error);
    }
  }

  get apiSession() {
    return this.client.apiSession;
  }

  get dataManager() {
    return this._dataManager;
  }

  get cognitoSession() {
    return this.client.cognitoSession;
  }

  /**
   * Signs out the user and cleans up all sessions and data managers.
   * Ensures no sensitive data remains in memory after logout.
   */
  async signOut() {
    this.client.signOut();
    if (this._dataManager) {
      this._dataManager.destroy();
      this._dataManager = null;
    }
    this.log(colorize(LOG_COLORS.SYSTEM, 'Signed out and cleaned up all sessions'));
  }

  /**
   * Cleanup method called when the app is being destroyed.
   * Ensures proper resource cleanup and session termination.
   */
  async onUninit() {
    this.log(colorize(LOG_COLORS.INFO, 'Whisker app is being destroyed, cleaning up resources...'));
    try {
      await this.signOut();
      this.log(colorize(LOG_COLORS.SUCCESS, 'Whisker app cleanup completed successfully'));
    } catch (error) {
      this.error(colorize(LOG_COLORS.ERROR, 'Error during app cleanup:'), error);
    }
  }

}

module.exports = WhiskerApp;
