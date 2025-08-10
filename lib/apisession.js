'use strict';

const { WhiskerApiException, WhiskerTokenException } = require('./exceptions');
const { retryWithBackoff, extractGraphQLOperationName, encodeBase64, safeStringify, safeParse, colorize, LOG_COLORS } = require('./utils');
const { WhiskerEventEmitter, EVENTS } = require('./event');
const EventEmitter = require('events');
const WebSocket = require('ws');
const Homey = require('homey');
const fetch = require('node-fetch');

const ENDPOINTS = {
  LR4: 'https://lr4.iothings.site/graphql',
  PET: 'https://pet-profile.iothings.site/graphql',
  WS: 'wss://lr4.iothings.site/graphql',
};

/**
 * Manages API communication with Whisker services including GraphQL requests and WebSocket connections.
 * Handles authentication, request retries, and real-time device state updates.
 */
class ApiSession extends EventEmitter {
  constructor(cognitoSession, homey) {
    super();
    if (!cognitoSession) {
      throw new Error('CognitoSession is required');
    }
    if (!homey) {
      throw new Error('Homey instance is required');
    }
    
    this.cognitoSession = cognitoSession;
    this.homey = homey;
    this.log = homey.log;
    
    this.eventEmitter = new WhiskerEventEmitter(homey);
    this.websocketConnections = new Map();
    this.connectionState = new Map();
    this.timeout = 30000;
  }

  /**
   * Generates authentication headers with automatic token refresh when needed.
   * Includes platform-specific user agent for proper API identification.
   */
  async getAuthHeaders() {
    if (!this.cognitoSession.isSessionValid()) {
      await this.cognitoSession.refreshSession();
    }
    
    const tokens = this.cognitoSession.getTokens();
    if (!tokens || !tokens.access_token) {
        throw new WhiskerTokenException('Missing access token');
    }

    const appVersion = this.homey.manifest.version || '1.0.0';
    const isCloud = this.homey.cloud;
    const platform = isCloud ? 'HomeyCloud' : 'HomeyPro';
    
    return {
      'Authorization': `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': `${platform}App/${appVersion}`,
    };
  }

  async lr4Graphql(query, variables = {}) {
    return this._makeGraphQLRequest(ENDPOINTS.LR4, { query, variables }, 'LR4');
  }

  async petGraphql(query, variables = {}) {
    return this._makeGraphQLRequest(ENDPOINTS.PET, { query, variables }, 'Pet');
  }

  /**
   * Executes GraphQL requests with automatic retry logic and token refresh on authentication failures.
   * Handles 401 errors by triggering token refresh and retrying the request.
   */
  async _makeGraphQLRequest(endpoint, data, apiType = 'Unknown') {
    const requestData = {
      method: 'POST',
      timeout: this.timeout,
      body: safeStringify(data),
    };

    const operationName = extractGraphQLOperationName(data.query);
    this.log(`[ApiSession] ${colorize(LOG_COLORS.INFO, `GraphQL ${operationName} request sent to ${endpoint}`)}`);

    return retryWithBackoff(async (attempt = 0) => {
      const authHeaders = await this.getAuthHeaders();
      requestData.headers = { ...authHeaders };

      if (attempt > 0) {
        this.log(`[ApiSession] ${colorize(LOG_COLORS.WARNING, `GraphQL ${operationName} retry attempt ${attempt + 1} to ${endpoint}`)}`);
      }

      const response = await fetch(endpoint, requestData);
      
      if (!response.ok) {
        const errorText = await response.text();
        this.homey.error(`[ApiSession] ${colorize(LOG_COLORS.ERROR, `GraphQL ${operationName} request failed: ${response.status} ${response.statusText}`)}`);
        
        if (response.status === 401 && attempt === 0) {
          this.log(`[ApiSession] ${colorize(LOG_COLORS.INFO, 'Received 401 Unauthorized, forcing token refresh...')}`);
          const retryError = new Error('Token refresh required, retrying request');
          retryError.isRetryTrigger = true;
          throw retryError;
        }
        
        throw new WhiskerApiException(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          new Error(errorText)
        );
      }

      const responseData = await response.json();
      this.log(`[ApiSession] ${colorize(LOG_COLORS.SUCCESS, `GraphQL ${operationName} response received from ${endpoint} (${response.status})`)}`);

      if (responseData.errors && responseData.errors.length > 0) {
        this.homey.error(`[ApiSession] ${colorize(LOG_COLORS.ERROR, `GraphQL errors for ${operationName}:`)}`, responseData.errors);
      }

      return responseData;
    }, 3, 1000);
  }

  /**
   * Logs WebSocket messages with appropriate detail level based on message type.
   * Skips keep-alive messages to reduce log noise.
   */
  _logWebSocketMessage(deviceId, message) {
    const messageType = message.type || 'unknown';
    if (messageType === 'ka') {
      return;
    }
    
    if (messageType === 'data') {
      this.log(`[ApiSession] ${colorize(LOG_COLORS.INFO, `WebSocket data received for device ${deviceId}`)}`);
    } else if (messageType === 'connection_ack') {
      this.log(`[ApiSession] ${colorize(LOG_COLORS.SUCCESS, `WebSocket connection acknowledged for device ${deviceId}`)}`);
    } else if (messageType === 'start_ack') {
      this.log(`[ApiSession] ${colorize(LOG_COLORS.SUCCESS, `WebSocket subscription started for device ${deviceId}`)}`);
    } else if (messageType === 'error') {
      this.homey.error(`[ApiSession] ${colorize(LOG_COLORS.ERROR, `WebSocket error for device ${deviceId}:`)}`, message);
    } else {
      this.log(`[ApiSession] ${colorize(LOG_COLORS.COMMAND, `WebSocket ${messageType} message for device ${deviceId}`)}`);
    }
  }

  /**
   * Establishes a WebSocket connection for real-time device state updates.
   * Handles connection lifecycle, authentication, and subscription management.
   */
  async createWebSocketConnection(deviceId, options = {}) {
    const existing = this.websocketConnections.get(deviceId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      this.log(`[ApiSession] ${colorize(LOG_COLORS.WARNING, `WebSocket connection already open for device ${deviceId}`)}`);
      return existing;
    }

    const serial = options.serial || deviceId;
    const state = this._getOrCreateConnState(deviceId, { serial });
    state.options = { ...options, serial };

    if (!this.cognitoSession.isSessionValid()) {
      await this.cognitoSession.refreshSession();
    }
    const tokens = this.cognitoSession.getTokens();
    const idToken = tokens ? tokens.id_token : null;
    if (!idToken) {
      throw new WhiskerTokenException('Missing ID token for WebSocket connection');
    }

    const params = {
      header: encodeBase64(safeStringify({
        Authorization: `Bearer ${idToken}`,
        host: 'lr4.iothings.site',
      })),
      payload: encodeBase64(safeStringify({})),
    };

    const urlObj = new URL(ENDPOINTS.WS + '/realtime');
    Object.entries(params).forEach(([key, value]) => urlObj.searchParams.append(key, value));
    const fullWsUrl = urlObj.toString();
    
    this.log(`[ApiSession] ${colorize(LOG_COLORS.INFO, `Creating WebSocket connection for device ${deviceId}`)}`);
    
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(fullWsUrl, 'graphql-ws', {
        headers: { 'sec-websocket-protocol': 'graphql-ws' }
      });
      
      ws.on('open', () => {
        this.log(`[ApiSession] ${colorize(LOG_COLORS.SUCCESS, `WebSocket connected for device ${deviceId}`)}`);
        ws.send(safeStringify({ type: 'connection_init', payload: {} }));
      });
      
      ws.on('message', (data) => {
        const st = this._getOrCreateConnState(deviceId);
        st.lastMessageAt = Date.now();

        try {
          const json = safeParse(data);
          if (json?.type !== 'ka') {
            this._logWebSocketMessage(deviceId, json);
          }

          switch (json.type) {
            case 'connection_ack':
              this.log(`[ApiSession] ${colorize(LOG_COLORS.INFO, 'WebSocket connection acknowledged, sending subscription start')}`);
              this.websocketConnections.set(deviceId, ws);
              st.reconnectAttempts = 0;
              this._setupHeartbeat(deviceId, ws);
              this.eventEmitter.emitConnected(deviceId, { url: fullWsUrl });
              
              ws.send(safeStringify({
                id: '1',
                type: 'start',
                payload: {
                  data: safeStringify({
                    query: `
                      subscription litterRobot4StateSubscriptionBySerial($serial: String!) {
                        litterRobot4StateSubscriptionBySerial(serial: $serial) {
                          unitId, name, serial, userId, espFirmware, picFirmwareVersion, picFirmwareVersionHex, laserBoardFirmwareVersion, laserBoardFirmwareVersionHex, wifiRssi, unitPowerType, catWeight, displayCode, unitTimezone, unitTime, cleanCycleWaitTime, isKeypadLockout, nightLightMode, nightLightBrightness, isPanelSleepMode, panelSleepTime, panelWakeTime, unitPowerStatus, sleepStatus, robotStatus, globeMotorFaultStatus, pinchStatus, catDetect, isBonnetRemoved, isNightLightLEDOn, odometerPowerCycles, odometerCleanCycles, panelBrightnessHigh, panelBrightnessLow, smartWeightEnabled, odometerEmptyCycles, odometerFilterCycles, isDFIResetPending, DFINumberOfCycles, DFILevelPercent, isDFIFull, DFIFullCounter, DFITriggerCount, litterLevel, DFILevelMM, isCatDetectPending, globeMotorRetractFaultStatus, robotCycleStatus, robotCycleState, weightSensor, isOnline, isOnboarded, isProvisioned, isDebugModeActive, lastSeen, sessionId, setupDateTime, isFirmwareUpdateTriggered, firmwareUpdateStatus, wifiModeStatus, isUSBPowerOn, USBFaultStatus, isDFIPartialFull, isLaserDirty, surfaceType, scoopsSavedCount, optimalLitterLevel, litterLevelPercentage, litterLevelState, weekdaySleepModeEnabled { Sunday { sleepTime, wakeTime, isEnabled }, Monday { sleepTime, wakeTime, isEnabled }, Tuesday { sleepTime, wakeTime, isEnabled }, Wednesday { sleepTime, wakeTime, isEnabled }, Thursday { sleepTime, wakeTime, isEnabled }, Friday { sleepTime, wakeTime, isEnabled }, Saturday { sleepTime, wakeTime, isEnabled } }, hopperStatus, isHopperRemoved
                        }
                      }
                    `,
                    variables: { serial: st.serial || serial }
                  }),
                  extensions: {
                    authorization: {
                      Authorization: `Bearer ${idToken}`,
                      host: 'lr4.iothings.site'
                    }
                  }
                }
              }));
              resolve(ws);
              break;
              
            case 'data':
              const update = json.payload?.data?.litterRobot4StateSubscriptionBySerial;
              if (update) {
                this.eventEmitter.emitDataReceived(deviceId, update, 'websocket');
              }
              break;
              
            case 'error':
              this.homey.error(`[ApiSession] ${colorize(LOG_COLORS.ERROR, `WebSocket subscription error for device ${deviceId}:`)}`, json.payload);
              break;
          }
        } catch (error) {
          this.homey.error(`[ApiSession] ${colorize(LOG_COLORS.ERROR, `Failed to parse WebSocket message for device ${deviceId}:`)}`, error);
          this.eventEmitter.emitError(error, `websocket_parse_${deviceId}`);
        }
      });
      
      const onSocketFailure = (where, errOrCode, reason) => {
        this.homey.log(`[ApiSession] ${colorize(LOG_COLORS.WARNING, `WebSocket ${where} for device ${deviceId}${reason ? `: ${reason}` : ''}`)}`, errOrCode || '');
        this.websocketConnections.delete(deviceId);
        this._clearHeartbeat(deviceId);
        this.eventEmitter.emitDisconnected(deviceId, reason || where);
      };

      ws.on('error', (error) => {
        onSocketFailure('error', error);
        this._scheduleReconnect(deviceId);
      });
      
      ws.on('close', (code, reason) => {
        onSocketFailure(`closed (${code})`, null, reason || 'connection_closed');
        this._scheduleReconnect(deviceId);
      });
      
      this.homey.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN && !this.websocketConnections.has(deviceId)) {
          try { ws.close(1000, 'Connection timeout'); } catch (e) {}
          this.eventEmitter.emitDisconnected(deviceId, 'connection_timeout');
          reject(new Error('WebSocket connection timeout'));
        }
      }, this.timeout);
    });
  }

  closeWebSocketConnection(deviceId) {
    const ws = this.websocketConnections.get(deviceId);
    if (ws) {
      this.log(`[ApiSession] ${colorize(LOG_COLORS.SYSTEM, `Closing WebSocket connection for device ${deviceId}`)}`);
      try { ws.close(1000, 'Device cleanup'); } catch (e) {}
      this.websocketConnections.delete(deviceId);
    }
    this._clearAllTimers(deviceId);
    this.connectionState.delete(deviceId);
  }

  closeAllWebSocketConnections() {
    this.log(`[ApiSession] ${colorize(LOG_COLORS.SYSTEM, 'Closing all WebSocket connections')}`);
    for (const [deviceId, ws] of this.websocketConnections) {
      try { ws.close(1000, 'App shutdown'); } catch (e) {}
      this._clearAllTimers(deviceId);
    }
    this.websocketConnections.clear();
    this.connectionState.clear();
  }

  getEventEmitter() {
    return this.eventEmitter;
  }

  getUserId() {
    return this.cognitoSession.getUserId();
  }

  destroy() {
    this.closeAllWebSocketConnections();
    this.eventEmitter.removeAllListeners();
  }

  /**
   * Internal helpers for reconnect/heartbeat
   */
  _getOrCreateConnState(deviceId, defaults = {}) {
    const state = this.connectionState.get(deviceId) || { reconnectAttempts: 0, ...defaults };
    this.connectionState.set(deviceId, state);
    return state;
  }

  _clearReconnectTimer(deviceId) {
    const state = this.connectionState.get(deviceId);
    if (state?.reconnectTimer) {
      this.homey.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  _clearHeartbeat(deviceId) {
    const state = this.connectionState.get(deviceId);
    if (state?.heartbeatTimer) {
      this.homey.clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  _clearAllTimers(deviceId) {
    this._clearReconnectTimer(deviceId);
    this._clearHeartbeat(deviceId);
  }

  _computeBackoffDelay(attempt) {
    const base = Math.min(30000, 1000 * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * 500);
    return base + jitter;
  }

  _setupHeartbeat(deviceId, ws, idleMs = 90000, checkEveryMs = 45000) {
    const state = this._getOrCreateConnState(deviceId);
    state.lastMessageAt = Date.now();
    this._clearHeartbeat(deviceId);
    state.heartbeatTimer = this.homey.setInterval(() => {
      if (!this.websocketConnections.has(deviceId)) return;
      const now = Date.now();
      if (now - (state.lastMessageAt || 0) > idleMs) {
        this.homey.log(`[ApiSession] ${colorize(LOG_COLORS.WARNING, `Heartbeat stale for device ${deviceId}, forcing reconnect`)}`);
        try { ws.terminate(); } catch (e) {}
      }
    }, checkEveryMs);
  }

  async _scheduleReconnect(deviceId) {
    const state = this._getOrCreateConnState(deviceId);
    if (state.reconnectTimer) return;
    const delay = this._computeBackoffDelay(state.reconnectAttempts || 0);
    this.homey.log(`[ApiSession] ${colorize(LOG_COLORS.WARNING, `Scheduling WebSocket reconnect for device ${deviceId} in ${Math.round(delay / 1000)}s (attempt ${(state.reconnectAttempts || 0) + 1})`)}`);
    state.reconnectTimer = this.homey.setTimeout(async () => {
      state.reconnectTimer = null;
      state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
      try {
        if (!this.cognitoSession.isSessionValid()) {
          await this.cognitoSession.refreshSession();
        }
        await this.createWebSocketConnection(deviceId, state.options || {});
      } catch (err) {
        this.homey.error(`[ApiSession] ${colorize(LOG_COLORS.ERROR, `Reconnect attempt failed for device ${deviceId}:`)}`, err);
        this._scheduleReconnect(deviceId);
      }
    }, delay);
  }

  /**
   * Retrieves all Litter-Robot 4 devices associated with the authenticated user.
   */
  async getRobots() {
    const userId = this.getUserId();
    if (!userId) {
      throw new WhiskerTokenException('Unable to get user ID from token');
    }

    const response = await this.lr4Graphql(`
      query GetLR4($userId: String!) {
        getLitterRobot4ByUser(userId: $userId) {
          id: unitId, serial: serial, nickname: name, status: robotStatus, lastSeen, hopperStatus, isHopperRemoved
        }
      }
    `, { userId });

    if (!response?.data?.getLitterRobot4ByUser) {
      throw new Error('Failed to fetch robots data');
    }
    return response.data.getLitterRobot4ByUser;
  }

  /**
   * Retrieves a specific robot by ID or serial number.
   */
  async getRobot(robotId) {
    const robots = await this.getRobots();
    const robot = robots.find(r => r.id === robotId || r.serial === robotId);
    if (!robot) {
      throw new Error(`Robot with id or serial "${robotId}" not found`);
    }
    this.log(`[ApiSession] ${colorize(LOG_COLORS.SUCCESS, `Fetched robot: ${robot.name || robot.serial}`)}`);
    return robot;
  }

  /**
   * Retrieves all pets associated with the authenticated user.
   */
  async getPets() {
    const userId = this.getUserId();
    if (!userId) {
      throw new WhiskerTokenException('Unable to get user ID from token');
    }

    const response = await this.petGraphql(`
      query GetPetsByUser($userId: String!) {
        getPetsByUser(userId: $userId) {
          petId, userId, createdAt, name, type, gender, weight, weightLastUpdated, lastWeightReading, breeds, age, birthday, adoptionDate, s3ImageURL, diet, isFixed, environmentType, healthConcerns, isActive, whiskerProducts, petTagId, weightIdFeatureEnabled
        }
      }
    `, { userId });

    const pets = response.data?.getPetsByUser || [];
    this.log(`[ApiSession] ${colorize(LOG_COLORS.SUCCESS, `Fetched ${pets.length} pets`)}`);
    return pets;
  }

  /**
   * Retrieves a specific pet by ID.
   */
  async getPet(petId) {
    const pets = await this.getPets();
    const pet = pets.find(p => p.petId === petId);
    if (!pet) {
      throw new Error(`Pet with id "${petId}" not found`);
    }
    this.log(`[ApiSession] ${colorize(LOG_COLORS.SUCCESS, `Fetched pet: ${pet.name || pet.petId}`)}`);
    return pet;
  }

  /**
   * Sends commands to robots via GraphQL to enable remote control functionality.
   * Generic method that can be used by any robot type (LR4, Feeder, etc.).
   * @param {string} robotSerial - Robot serial number
   * @param {string} command - Command to send
   * @param {Object|string} payload - Optional payload data
   * @param {string} robotType - Robot type (default: 'litter_robot_4')
   * @returns {Promise<Object>} GraphQL response
   */
  async sendCommand(robotSerial, command, payload = null, robotType = 'litter_robot_4') {
    if (!robotSerial) {
      throw new Error('Robot serial is required');
    }
    if (!command) {
      throw new Error('Command is required');
    }

    const value = payload ? (typeof payload === 'object' ? JSON.stringify(payload) : String(payload)) : null;
    
    this.log(`[ApiSession] ${colorize(LOG_COLORS.COMMAND, `Sending ${robotType} command: ${command}${payload ? ' with payload' : ''}`)}`);
    
    const query = `
      mutation sendCommand($serial: String!, $command: String!, $value: String) {
        sendLitterRobot4Command(input: {
          serial: $serial,
          command: $command,
          value: $value
        })
      }
    `;
    
    try {
      const response = await this.lr4Graphql(query, {
        serial: robotSerial,
        command,
        value
      });
      
      this.log(`[ApiSession] ${colorize(LOG_COLORS.SUCCESS, `Successfully sent ${robotType} command: ${command}`)}`);
      return response;
    } catch (err) {
      this.homey.error(`[ApiSession] ${colorize(LOG_COLORS.ERROR, `Failed to send ${robotType} command ${command}:`)}`, err);
      throw err;
    }
  }
}

ApiSession.ENDPOINTS = ENDPOINTS;

module.exports = ApiSession;
