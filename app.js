const Homey = require('homey');
const Session = require('./lib/session');
const DataManager = require('./lib/datamanager');
const { colorize, LOG_COLORS } = require('./lib/utils');
const { EventEmitter } = require('./lib/event');

/**
 * Main application class for the Whisker Homey app.
 * Manages centralized authentication, data management, and device coordination
 * for all Whisker devices (Litter-Robot 4, pet tracking, etc.).
 */
class WhiskerApp extends Homey.App {

  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing Whisker app...'));
    this._session = null;
    this._eventEmitter = new EventEmitter();
    this._eventEmitter.setMaxListeners(100);
    this._initializeDataManager();
    await this._restoreSession();
    this.log(colorize(LOG_COLORS.SUCCESS, 'Whisker app initialization completed successfully'));
  }

  /**
   * Initializes the data management system to handle cross-device communication
   * and centralized data processing for all Whisker devices.
   */
  _initializeDataManager() {
    this._dataManager = null;
    this.log(colorize(LOG_COLORS.INFO, 'Data management system initialized'));
  }

  /**
   * Attempts to restore user session from stored authentication tokens.
   * This enables seamless app restarts without requiring re-authentication
   * when valid tokens are available.
   */
  async _restoreSession() {
    try {
      const storedTokens = this.homey.settings.get('cognito_tokens');
      if (storedTokens) {
        this.log(colorize(LOG_COLORS.INFO, 'Found stored tokens, attempting to restore session...'));
        this._session = new Session({
          tokens: storedTokens,
          homey: this.homey,
          eventEmitter: this._eventEmitter,
          onTokensRefreshed: (tokens) => this.homey.settings.set('cognito_tokens', tokens),
        });

        if (!this._session.isSessionValid()) {
          await this._session.refreshSession();
        }

        this._dataManager = new DataManager(this._session, this.homey, () => this.onUninit(), this._eventEmitter);
        await this._registerDevices();
        this.log(colorize(LOG_COLORS.SUCCESS, 'Session restored successfully from stored tokens'));
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
    if (this._session && this._session.isSessionValid()) {
      this.log(colorize(LOG_COLORS.WARNING, 'Session already initialized'));
      return this._session;
    }

    this.log(colorize(LOG_COLORS.INFO, 'Initializing session with credentials...'));

    try {
      this._session = new Session({
        username,
        password,
        homey: this.homey,
        eventEmitter: this._eventEmitter,
        onTokensRefreshed: (tokens) => this.homey.settings.set('cognito_tokens', tokens),
      });

      await this._session.login();
      this._dataManager = new DataManager(this._session, this.homey, () => this.onUninit(), this._eventEmitter);
      await this._registerDevices();
      this.log(colorize(LOG_COLORS.SUCCESS, 'Session initialized successfully'));
      return this._session;
    } catch (error) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to initialize session:'), error);
      throw error;
    }
  }

  /**
   * Re-registers all existing devices with the new data manager instance.
   * Pet devices register for polling, robot devices will set up WebSocket in Phase 3.
   */
  async _registerDevices() {
    this.log(colorize(LOG_COLORS.INFO, 'Re-registering devices with DataManager...'));

    try {
      const drivers = await this.homey.drivers.getDrivers();

      for (const driver of Object.values(drivers)) {
        const driverDevices = await driver.getDevices();

        for (const device of driverDevices) {
          try {
            this.log(colorize(LOG_COLORS.INFO, `Re-registering device ${device.getName()}...`));
            if (typeof device._registerWithDataManager === 'function') {
              await device._registerWithDataManager();
              this.log(colorize(LOG_COLORS.SUCCESS, `Device ${device.getName()} re-registered successfully`));
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

  get session() {
    return this._session;
  }

  get apiSession() {
    return this._session;
  }

  get dataManager() {
    return this._dataManager;
  }

  get cognitoSession() {
    return this._session;
  }

  /**
   * Signs out the current user session, clearing authentication and cleaning up resources.
   * Used during repair flows to ensure fresh authentication.
   */
  async signOut() {
    this.log(colorize(LOG_COLORS.INFO, 'Signing out current session...'));
    try {
      if (this._session) {
        this._session.signOut();
        this._session.closeAllWebSockets();
      }
      if (this._dataManager) {
        this._dataManager.destroyDataManager();
        this._dataManager = null;
      }
      this.log(colorize(LOG_COLORS.SUCCESS, 'Sign out completed successfully'));
    } catch (error) {
      this.error(colorize(LOG_COLORS.ERROR, 'Error during sign out:'), error);
      throw error;
    }
  }

  /**
   * Cleanup method called when the app is being destroyed.
   * Ensures proper resource cleanup and session termination.
   */
  async onUninit() {
    this.log(colorize(LOG_COLORS.INFO, 'Whisker app is being destroyed, cleaning up resources...'));
    try {
      if (this._session) {
        this._session.signOut();
        this._session.closeAllWebSockets();
      }
      if (this._dataManager) {
        this._dataManager.destroyDataManager();
        this._dataManager = null;
      }
      if (this._eventEmitter) {
        this._eventEmitter.removeAllListeners();
      }
      this.log(colorize(LOG_COLORS.SUCCESS, 'Whisker app cleanup completed successfully'));
    } catch (error) {
      this.error(colorize(LOG_COLORS.ERROR, 'Error during app cleanup:'), error);
    }
  }

}

module.exports = WhiskerApp;
