const WhiskerDevice = require('./WhiskerDevice');
const { WhiskerNetworkException } = require('./common/exceptions');
const { getRobotDisplayName } = require('./common/utils');

/**
 * Shared WebSocket lifecycle and capability refresh for litter-robot Homey devices.
 * Litter-Robot 3 and Litter-Robot 4 device classes extend this and supply product-specific fetch, sync, and command hooks.
 */
module.exports = class WhiskerLitterRobotDevice extends WhiskerDevice {

  /**
   * Defers full initialization when no session exists so repair can authenticate later.
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    this._destroyed = false;
    this._initialStateTimer = null;
    this._websocketUnsubscribe = null;

    this.log('Initializing device...');

    try {
      const data = this.getData();
      this.robotSerial = data.id;

      if (!this.robotSerial) {
        throw new Error(this.homey.__('errors.invalid_device_data_missing_serial'));
      }

      this.log(`Device initialized with robot serial: ${this.robotSerial}`);

      await this.onSessionReady();
      this._initSucceeded = true;
    } catch (err) {
      this.error('Failed to initialize device:', err);
      this.setUnavailable(err instanceof WhiskerNetworkException
        ? this.homey.__('errors.network_unreachable')
        : err.message);

    }
  }

  /**
   * Marks the device unavailable when a capability command cannot reach the Whisker cloud.
   */
  registerCapabilityListener(capability, listener) {
    return super.registerCapabilityListener(capability, async (...args) => {
      try {
        return await listener.apply(this, args);
      } catch (err) {
        if (err instanceof WhiskerNetworkException) {
          this.setUnavailable(this.homey.__('errors.network_unreachable'));
        }
        throw err;
      }
    });
  }

  /**
   * Loads robot state, registers command listeners when needed, and opens the WebSocket.
   *
   * @returns {Promise<void>}
   */
  async onSessionReady() {
    if (this._destroyed) {
      return;
    }

    if (!this.robot) {
      await this._registerCapabilityListeners();
    }

    await this._syncRobot();
    await this._setupWebSocket();
  }

  /**
   * Pulls a REST/GraphQL snapshot before opening the realtime channel so capabilities are populated immediately.
   *
   * @returns {Promise<void>}
   */
  async _syncRobot() {
    const { session } = this.homey.app;
    if (!session || !session.isSessionValid()) {
      throw new Error(this.homey.__('errors.session_unavailable'));
    }

    this.robot = await this._fetchRobotSnapshot(session);
    await this._syncDeviceSettings(this.robot);
    await this._refreshAllCapabilities(this.robot);

    this.log(`Connected to robot: ${getRobotDisplayName(this.robot, this.robotSerial)}`);
  }

  /**
   * Lazily loads robot state for capability listeners invoked before the first WebSocket frame.
   *
   * @returns {Promise<void>}
   */
  async _ensureRobot() {
    if (!this.robot) {
      await this._syncRobot();
    }
  }

  /**
   * Subscribes to session-level WebSocket updates and requests a delayed state refresh because
   * the first frames after connect can be incomplete.
   *
   * @returns {Promise<void>}
   */
  async _setupWebSocket() {
    if (this._destroyed) return;

    this._websocketUnsubscribe?.();
    this._clearInitialStateTimer();

    const { session } = this.homey.app;

    this.log('Setting up WebSocket connection...');

    await session.createWebSocket(this.robotSerial, { deviceType: this.constructor.DEVICE_TYPE });

    const dataHandler = (robot) => {
      if (this._destroyed) return;
      this._handleRobotUpdate(robot).catch((err) => {
        this.error('Failed to handle robot update:', err);
      });
    };

    session.subscribeToDevice(this.robotSerial, dataHandler);
    this._websocketUnsubscribe = () => {
      session.unsubscribeFromDevice(this.robotSerial);
    };

    this.log('WebSocket connection established');

    this.setAvailable();

    this._initialStateTimer = this.homey.setTimeout(() => {
      this._initialStateTimer = null;
      if (this._destroyed) return;
      this._requestInitialState();
    }, 5000);
  }

  /**
   * Cancels the post-connect state refresh so reconnects do not stack timers.
   */
  _clearInitialStateTimer() {
    if (this._initialStateTimer) {
      this.homey.clearTimeout(this._initialStateTimer);
      this._initialStateTimer = null;
    }
  }

  /**
   * Merges partial WebSocket payloads into cached robot state before capability refresh.
   *
   * @param {Object} update
   * @returns {Promise<void>}
   */
  async _handleRobotUpdate(update) {
    if (this._destroyed) {
      return;
    }

    this.log(`Received robot update for ${getRobotDisplayName(update, this.robotSerial)}`);

    const from = this.robot;
    this.robot = { ...this.robot, ...update };

    await this._applyRobotUpdate({ robot: this.robot, update, from });
  }

  /**
   * Recomputes all capabilities from a full snapshot (initial sync or reconnect).
   *
   * @param {Object} robot
   * @returns {Promise<void>}
   */
  async _refreshAllCapabilities(robot) {
    await this._applyRobotUpdate({ robot, update: robot });
  }

  /**
   * Fires flow cards when the clean cycle odometer increases.
   */
  _triggerCleanCycleFlowCards() {
    const totalCycles = this.getCapabilityValue('measure_odometer_clean_cycles');
    if (typeof totalCycles !== 'number' || totalCycles <= 0) {
      return;
    }

    const previousCycles = this.getStoreValue('previous_clean_cycles') || 0;
    if (totalCycles > previousCycles) {
      this._triggerFlowCard('clean_cycle_multiple', { total_cycles: totalCycles });
      this._triggerFlowCard('clean_cycle_finished', { total_clean_cycles: totalCycles });
    }

    this.setStoreValue('previous_clean_cycles', totalCycles).catch((err) => {
      this.error('Failed to update store value for previous_clean_cycles:', err);
    });
  }

  /**
   * Releases WebSocket resources when the device is removed from Homey.
   */
  onDeleted() {
    this.log('Device deleted, cleaning up...');
    this.onUninit();
    this.log('Device cleanup completed');
  }

  /**
   * Releases WebSocket resources during driver shutdown or app restart.
   */
  onUninit() {
    if (this._destroyed) return;
    this._destroyed = true;

    this._clearInitialStateTimer();

    try {
      if (this._websocketUnsubscribe) {
        this._websocketUnsubscribe();
        this._websocketUnsubscribe = null;
      }

      const { session } = this.homey.app;
      if (session && this.robotSerial) {
        session.closeWebSocket(this.robotSerial);
      }
    } catch (err) {
      this.error('Error during connection teardown:', err);
    }
  }
};
