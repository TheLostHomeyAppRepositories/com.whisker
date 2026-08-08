/**
 * @module Polling
 * Centralized polling: one shared fetch per poll group and interval, with debounced
 * refreshes after registrations and optional on-demand triggers.
 */

const { WhiskerNetworkException } = require('./exceptions');

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Coordinates polling so multiple devices sharing a poll key reuse one API round-trip per tick.
 *
 * @class
 */
class Polling {
  /**
   * @param {Object} session - Session passed to poll functions
   * @param {Object} homey - Homey instance for timers and logging
   */
  constructor(session, homey) {
    if (!session) {
      throw new Error('Session is required');
    }
    if (!homey) {
      throw new Error('Homey instance is required');
    }

    this.session = session;
    this.homey = homey;

    /** @type {Map<string, PollGroup>} */
    this._groups = new Map();

    this.config = {
      registerDebounceMs: 150,
    };
  }

  /**
   * Registers a device with a shared poll group. The first registrant for a poll key
   * must supply `pollFn`; later registrants reuse the same fetch and interval.
   *
   * @param {string} pollKey - Shared poll channel (e.g. `'pets'`)
   * @param {string} deviceId - Device identifier
   * @param {Object} options
   * @param {number} [options.pollInterval] - Interval in ms (default 5 minutes)
   * @param {Function} [options.pollFn] - Async fetch for the whole group; `(session) => data`
   * @param {Function} options.onDataUpdate - Called with `(data, source)` when data is available
   * @param {Function} [options.selectData] - Maps group result to device data; `(groupResult, metadata) => data`
   * @param {Object} [options.metadata] - Passed to `selectData`
   */
  registerPolling(pollKey, deviceId, options) {
    const group = this._getOrCreateGroup(pollKey, options);

    if (group.registrants.has(deviceId)) {
      this.homey.log(`[Polling] Device ${deviceId} is already registered for '${pollKey}'`);
      return;
    }

    this.homey.log(`[Polling] Registering device ${deviceId} for '${pollKey}' polling`);

    group.registrants.set(deviceId, {
      onDataUpdate: options.onDataUpdate,
      selectData: options.selectData,
      metadata: options.metadata,
      registeredAt: Date.now(),
    });

    this._scheduleDebouncedPoll(group, this.config.registerDebounceMs);
  }

  /**
   * Unregisters a device from a poll group. Stops the interval when none remain.
   *
   * @param {string} pollKey - Shared poll channel
   * @param {string} deviceId - Device identifier
   */
  unregisterPolling(pollKey, deviceId) {
    const group = this._groups.get(pollKey);
    if (!group || !group.registrants.has(deviceId)) {
      this.homey.log(`[Polling] Device ${deviceId} is not registered for '${pollKey}'`);
      return;
    }

    this.homey.log(`[Polling] Unregistering device ${deviceId} from '${pollKey}'`);

    group.registrants.delete(deviceId);
    this._checkAndStopGroup(group, pollKey);
  }

  /**
   * @param {string} pollKey - Shared poll channel
   * @returns {boolean} Whether any devices are registered for the poll key
   */
  hasRegistrants(pollKey) {
    const group = this._groups.get(pollKey);
    return Boolean(group && group.registrants.size > 0);
  }

  /**
   * Debounced refresh for a poll group, e.g. after an external event that should
   * trigger an immediate fetch.
   *
   * @param {string} pollKey - Shared poll channel
   * @param {Object} [options]
   * @param {number} [options.debounceMs=150] - Debounce delay
   * @param {Function|null} [options.onComplete] - Called with the group poll result
   */
  triggerDebouncedPoll(pollKey, { debounceMs = this.config.registerDebounceMs, onComplete = null } = {}) {
    const group = this._groups.get(pollKey);
    if (!group) {
      if (onComplete) {
        try {
          onComplete(null);
        } catch (error) {
          this.homey.error(`[Polling] Error in '${pollKey}' poll callback:`, error);
        }
      }
      return;
    }

    group.pollCompleteCallback = onComplete;
    this._scheduleDebouncedPoll(group, debounceMs);
  }

  /**
   * @param {string} pollKey
   * @param {Object} options
   * @returns {PollGroup}
   * @private
   */
  _getOrCreateGroup(pollKey, options) {
    let group = this._groups.get(pollKey);

    if (!group) {
      if (typeof options.pollFn !== 'function') {
        throw new Error(`pollFn is required when creating poll group '${pollKey}'`);
      }

      group = {
        pollKey,
        pollInterval: options.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
        pollFn: options.pollFn,
        registrants: new Map(),
        interval: null,
        debounceTimer: null,
        isPolling: false,
        pollCompleteCallback: null,
      };
      this._groups.set(pollKey, group);
      return group;
    }

    if (options.pollInterval && options.pollInterval !== group.pollInterval) {
      this.homey.log(
        `[Polling] Ignoring pollInterval for '${pollKey}'; group already uses ${group.pollInterval}ms`,
      );
    }

    return group;
  }

  /**
   * @param {PollGroup} group
   * @param {number} delayMs
   * @private
   */
  _scheduleDebouncedPoll(group, delayMs) {
    if (group.debounceTimer) {
      this.homey.clearTimeout(group.debounceTimer);
    }
    group.debounceTimer = this.homey.setTimeout(() => {
      group.debounceTimer = null;
      this._runDebouncedPoll(group);
    }, delayMs);
  }

  /**
   * Ensures the interval exists when there are registrants, then runs one poll.
   *
   * @param {PollGroup} group
   * @private
   */
  _runDebouncedPoll(group) {
    if (group.registrants.size > 0 && !group.interval) {
      group.interval = this.homey.setInterval(() => {
        this._executeGroupPoll(group);
      }, group.pollInterval);
      this.homey.log(
        `[Polling] Started '${group.pollKey}' polling for ${group.registrants.size} device(s)...`,
      );
    }
    this._executeGroupPoll(group);
  }

  /**
   * Fetches once per group and fans out to registered devices.
   *
   * @param {PollGroup} group
   * @private
   */
  async _executeGroupPoll(group) {
    if (group.isPolling) {
      this.homey.log(`[Polling] '${group.pollKey}' poll already in progress, skipping`);
      return;
    }

    group.isPolling = true;
    let groupResult = null;

    try {
      if (group.registrants.size === 0) {
        this._stopGroupTimers(group);
        if (group.pollCompleteCallback) {
          try {
            group.pollCompleteCallback(null);
          } catch (error) {
            this.homey.error(`[Polling] Error in '${group.pollKey}' poll callback:`, error);
          }
          group.pollCompleteCallback = null;
        }
        return;
      }

      groupResult = await group.pollFn(this.session);

      for (const [deviceId, registrant] of group.registrants.entries()) {
        if (!registrant.onDataUpdate) {
          continue;
        }

        const data = registrant.selectData
          ? registrant.selectData(groupResult, registrant.metadata)
          : groupResult;

        if (!data) {
          continue;
        }

        try {
          registrant.onDataUpdate(data, 'api');
        } catch (error) {
          this.homey.error(`[Polling] Error in '${group.pollKey}' callback for ${deviceId}:`, error);
        }
      }

      this.homey.log(
        `[Polling] '${group.pollKey}' poll completed for ${group.registrants.size} device(s)`,
      );
    } catch (error) {
      this.homey.error(`[Polling] '${group.pollKey}' poll failed:`, error);
      if (error instanceof WhiskerNetworkException) {
        for (const [deviceId, registrant] of group.registrants.entries()) {
          if (!registrant.onDataUpdate) {
            continue;
          }
          try {
            registrant.onDataUpdate(null, 'network_error');
          } catch (callbackError) {
            this.homey.error(`[Polling] Error in '${group.pollKey}' callback for ${deviceId}:`, callbackError);
          }
        }
      }
      groupResult = null;
    } finally {
      group.isPolling = false;

      if (group.pollCompleteCallback) {
        try {
          group.pollCompleteCallback(groupResult);
        } catch (error) {
          this.homey.error(`[Polling] Error in '${group.pollKey}' poll callback:`, error);
        }
        group.pollCompleteCallback = null;
      }
    }
  }

  /**
   * @param {PollGroup} group
   * @param {string} pollKey
   * @private
   */
  _checkAndStopGroup(group, pollKey) {
    if (group.registrants.size === 0) {
      this._stopGroupTimers(group);
      this._groups.delete(pollKey);
    }
  }

  /**
   * @param {PollGroup} group
   * @private
   */
  _stopGroupTimers(group) {
    if (group.interval) {
      this.homey.clearInterval(group.interval);
      group.interval = null;
      this.homey.log(`[Polling] Stopped '${group.pollKey}' polling`);
    }
    group.isPolling = false;
    if (group.debounceTimer) {
      this.homey.clearTimeout(group.debounceTimer);
      group.debounceTimer = null;
    }
  }

  /**
   * Tears down timers and registrations.
   */
  destroy() {
    this.homey.log('[Polling] Destroying polling...');
    for (const group of this._groups.values()) {
      this._stopGroupTimers(group);
    }
    this._groups.clear();
    this.homey.log('[Polling] Polling destroyed');
  }
}

module.exports = Polling;
