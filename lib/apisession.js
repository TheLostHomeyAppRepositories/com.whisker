'use strict';

/**
 * Abstract API session class for the Whisker app.
 * Following the pylitterbot pattern for session management.
 */

const { WhiskerApiException, WhiskerInvalidCommandException } = require('./exceptions');
const { redactSensitiveData, retryWithBackoff } = require('./utils');
const { WhiskerEventEmitter, EVENTS } = require('./event');
const EventEmitter = require('events');
const WebSocket = require('ws');
const Homey = require('homey');
const fetch = require('node-fetch');

// API endpoints
const ENDPOINTS = {
  LR4: 'https://lr4.iothings.site/graphql',
  PET: 'https://pet-profile.iothings.site/graphql',
  WS: 'wss://lr4.iothings.site/graphql',
};

/**
 * Base API session class for Whisker API interactions
 * Handles HTTP requests, WebSocket connections, and event management
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
    
    this.eventEmitter = new WhiskerEventEmitter();
    
    // WebSocket connections pool
    this.websocketConnections = new Map();
    
    // Request timeout (30 seconds)
    this.timeout = 30000;

    this.connections = new Map();
    this.reconnectAttempts = new Map();
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
  }

  /**
   * Get authentication headers for API requests.
   * @returns {Object} - Headers object with authorization
   */
  async getAuthHeaders() {
    const tokens = await this.cognitoSession.getTokens();
    const appVersion = this.homey.manifest.version || '1.0.0';
    
    // Detect if running on Homey Cloud or Homey Pro
    const isCloud = this.homey.cloud;
    const platform = isCloud ? 'HomeyCloud' : 'HomeyPro';
    
    return {
      'Authorization': `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
      'User-Agent': `${platform}App/${appVersion}`,
    };
  }

  /**
   * Make a GraphQL request to the Litter-Robot 4 endpoint.
   * @param {string} query - GraphQL query
   * @param {Object} variables - Query variables
   * @returns {Promise<Object>} - Response data
   */
  async lr4Graphql(query, variables = {}) {
    const data = {
      query,
      variables,
    };
    
    // Use the LR4-specific GraphQL endpoint
    return this._makeGraphQLRequest(ENDPOINTS.LR4, data, 'LR4');
  }

  /**
   * Make a GraphQL request to the pet API endpoint.
   * @param {string} query - GraphQL query
   * @param {Object} variables - Query variables
   * @returns {Promise<Object>} - Response data
   */
  async petGraphql(query, variables = {}) {
    const data = {
      query,
      variables,
    };
    
    // Use the pet-specific GraphQL endpoint
    return this._makeGraphQLRequest(ENDPOINTS.PET, data, 'Pet');
  }

  /**
   * Internal method to make GraphQL requests with retry logic.
   * @param {string} endpoint - GraphQL endpoint URL
   * @param {Object} data - Request data
   * @param {string} apiType - API type for logging
   * @returns {Promise<Object>} - Response data
   */
  async _makeGraphQLRequest(endpoint, data, apiType = 'Unknown') {
    const authHeaders = await this.getAuthHeaders();
    const requestHeaders = { ...authHeaders };
    
    const requestData = {
      method: 'POST',
      headers: requestHeaders,
      timeout: this.timeout,
      body: JSON.stringify(data),
    };

    this.homey.log(`Making GraphQL request to ${endpoint}`, {
      headers: redactSensitiveData(requestHeaders),
      data: redactSensitiveData(data),
    });

    return retryWithBackoff(async () => {
      const response = await fetch(endpoint, requestData);
      
      if (!response.ok) {
        const errorText = await response.text();
        this.homey.error(`GraphQL request failed: ${response.status} ${response.statusText}`, {
          endpoint,
          status: response.status,
          error: errorText,
        });
        
        throw new WhiskerApiException(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          new Error(errorText)
        );
      }

      const responseData = await response.json();
      
      this.homey.log(`GraphQL response received`, {
        endpoint,
        status: response.status,
        data: redactSensitiveData(responseData),
      });

      // Log GraphQL errors if present
      if (responseData.errors && responseData.errors.length > 0) {
        this.homey.error(`GraphQL errors for ${endpoint}:`, responseData.errors);
      }

      return responseData;
    });
  }

  /**
   * Create WebSocket connection for real-time updates.
   * @param {string} deviceId - Device identifier
   * @param {Object} options - Connection options
   * @returns {Promise<WebSocket>} - WebSocket connection
   */
  async createWebSocketConnection(deviceId, options = {}) {
    if (this.websocketConnections.has(deviceId)) {
      this.homey.log(`WebSocket connection already exists for device ${deviceId}`);
      return this.websocketConnections.get(deviceId);
    }

    const tokens = await this.cognitoSession.getTokens();
    const idToken = tokens.id_token;
    if (!idToken) {
      throw new Error('Missing ID token for WebSocket connection');
    }

    // Build WebSocket endpoint URL, headers, and search parameters for GraphQL subscriptions
    // Following the old working code pattern
    const params = {
      header: Buffer.from(JSON.stringify({
        Authorization: `Bearer ${idToken}`,
        host: 'lr4.iothings.site',
      })).toString('base64'),
      payload: Buffer.from(JSON.stringify({})).toString('base64'),
    };

    const wsUrl = 'wss://lr4.iothings.site/graphql/realtime';
    const urlObj = new URL(wsUrl);
    Object.entries(params).forEach(([key, value]) => {
      urlObj.searchParams.append(key, value);
    });
    const fullWsUrl = urlObj.toString();
    
    this.homey.log(`Creating WebSocket connection for device ${deviceId}`);
    
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(fullWsUrl, 'graphql-ws', {
        headers: {
          'sec-websocket-protocol': 'graphql-ws'
        }
      });
      
      ws.on('open', () => {
        this.homey.log(`WebSocket connected for device ${deviceId}`);
        
        // Send connection init message
        ws.send(JSON.stringify({
          type: 'connection_init',
          payload: {}
        }));
      });
      
      ws.on('message', (data) => {
        try {
          const json = JSON.parse(data);
          this.homey.log({ json }, 'WebSocket received');

          switch (json.type) {
            case 'connection_ack':
              this.homey.log('WebSocket connection acknowledged, sending subscription start');
              
              // Store the WebSocket connection
              this.websocketConnections.set(deviceId, ws);
              this.eventEmitter.emitConnected(deviceId, { url: fullWsUrl });
              
              // Send subscription start message
              const serial = options.serial || deviceId;
              ws.send(JSON.stringify({
                id: '1',
                type: 'start',
                payload: {
                  data: JSON.stringify({
                    query: `
                      subscription litterRobot4StateSubscriptionBySerial($serial: String!) {
                        litterRobot4StateSubscriptionBySerial(serial: $serial) {
                          unitId
                          name
                          serial
                          userId
                          espFirmware
                          picFirmwareVersion
                          picFirmwareVersionHex
                          laserBoardFirmwareVersion
                          laserBoardFirmwareVersionHex
                          wifiRssi
                          unitPowerType
                          catWeight
                          displayCode
                          unitTimezone
                          unitTime
                          cleanCycleWaitTime
                          isKeypadLockout
                          nightLightMode
                          nightLightBrightness
                          isPanelSleepMode
                          panelSleepTime
                          panelWakeTime
                          unitPowerStatus
                          sleepStatus
                          robotStatus
                          globeMotorFaultStatus
                          pinchStatus
                          catDetect
                          isBonnetRemoved
                          isNightLightLEDOn
                          odometerPowerCycles
                          odometerCleanCycles
                          panelBrightnessHigh
                          panelBrightnessLow
                          smartWeightEnabled
                          odometerEmptyCycles
                          odometerFilterCycles
                          isDFIResetPending
                          DFINumberOfCycles
                          DFILevelPercent
                          isDFIFull
                          DFIFullCounter
                          DFITriggerCount
                          litterLevel
                          DFILevelMM
                          isCatDetectPending
                          globeMotorRetractFaultStatus
                          robotCycleStatus
                          robotCycleState
                          weightSensor
                          isOnline
                          isOnboarded
                          isProvisioned
                          isDebugModeActive
                          lastSeen
                          sessionId
                          setupDateTime
                          isFirmwareUpdateTriggered
                          firmwareUpdateStatus
                          wifiModeStatus
                          isUSBPowerOn
                          USBFaultStatus
                          isDFIPartialFull
                          isLaserDirty
                          surfaceType
                          hopperStatus
                          scoopsSavedCount
                          isHopperRemoved
                          optimalLitterLevel
                          litterLevelPercentage
                          litterLevelState
                          weekdaySleepModeEnabled {
                            Sunday { sleepTime wakeTime isEnabled }
                            Monday { sleepTime wakeTime isEnabled }
                            Tuesday { sleepTime wakeTime isEnabled }
                            Wednesday { sleepTime wakeTime isEnabled }
                            Thursday { sleepTime wakeTime isEnabled }
                            Friday { sleepTime wakeTime isEnabled }
                            Saturday { sleepTime wakeTime isEnabled }
                          }
                        }
                      }
                    `,
                    variables: {
                      serial: serial
                    }
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
              
            case 'ka':
              // keep-alive; can be ignored
              break;
              
            case 'data':
              const update = json.payload?.data?.litterRobot4StateSubscriptionBySerial;
              this.homey.log({ update }, 'Received robot update payload');
              if (update) {
                this.eventEmitter.emitDataReceived(deviceId, update, 'websocket');
                this._handleWebSocketMessage(deviceId, update);
              }
              break;
              
            case 'error':
              this.homey.error({ payload: json.payload }, 'Subscription error');
              break;
          }
        } catch (error) {
          this.homey.error(`Failed to parse WebSocket message for device ${deviceId}`, error);
          this.eventEmitter.emitError(error, `websocket_parse_${deviceId}`);
        }
      });
      
      ws.on('error', (error) => {
        this.homey.error(`WebSocket error for device ${deviceId}`, error);
        this.eventEmitter.emitError(error, `websocket_error_${deviceId}`);
        reject(error);
      });
      
      ws.on('close', (event) => {
        this.homey.log(`WebSocket disconnected for device ${deviceId}`, { code: event.code, reason: event.reason });
        this.websocketConnections.delete(deviceId);
        this.eventEmitter.emitDisconnected(deviceId, event.reason || 'connection_closed');
      });
      
      // Set timeout for connection
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error('WebSocket connection timeout'));
        }
      }, this.timeout);
    });
  }

  /**
   * Close WebSocket connection for a device.
   * @param {string} deviceId - Device identifier
   */
  closeWebSocketConnection(deviceId) {
    const ws = this.websocketConnections.get(deviceId);
    if (ws) {
      this.homey.log(`Closing WebSocket connection for device ${deviceId}`);
      ws.close();
      this.websocketConnections.delete(deviceId);
    }
  }

  /**
   * Close all WebSocket connections.
   */
  closeAllWebSocketConnections() {
    this.homey.log('Closing all WebSocket connections');
    for (const [deviceId, ws] of this.websocketConnections) {
      ws.close();
    }
    this.websocketConnections.clear();
  }

  /**
   * Handle incoming WebSocket messages.
   * Override this method in subclasses for device-specific handling.
   * @param {string} deviceId - Device identifier
   * @param {Object} data - Message data
   */
  _handleWebSocketMessage(deviceId, data) {
    // Base implementation - emit update event
    if (data.payload && data.payload.data) {
      this.eventEmitter.emitUpdate(deviceId, data.payload.data);
    }
  }

  /**
   * Get the event emitter for subscribing to events.
   * @returns {WhiskerEventEmitter} - Event emitter instance
   */
  getEventEmitter() {
    return this.eventEmitter;
  }

  /**
   * Get the user ID from the JWT token
   * @returns {string} User ID
   */
  getUserId() {
    return this.cognitoSession.getUserId();
  }

  /**
   * Clean up resources.
   */
  destroy() {
    this.closeAllWebSocketConnections();
    this.eventEmitter.removeAllListeners();
  }

  /**
   * Get robots for the authenticated user
   * @returns {Promise<Array>} Array of robot data
   */
  async getRobots() {
    const userId = this.getUserId();
    if (!userId) {
      throw new Error('Unable to get user ID from token');
    }

    const response = await this.lr4Graphql(`
      query GetLR4($userId: String!) {
        getLitterRobot4ByUser(userId: $userId) {
          id: unitId
          serial: serial
          nickname: name
          status: robotStatus
          lastSeen
        }
      }
    `, { userId });

    if (!response?.data?.getLitterRobot4ByUser) {
      throw new Error('Failed to fetch robots data');
    }
    return response.data.getLitterRobot4ByUser;
  }

  /**
   * Get specific robot data
   * @param {string} robotId - Robot ID or serial number
   * @returns {Promise<Object>} Robot data
   */
  async getRobot(robotId) {
    const robots = await this.getRobots();
    const robot = robots.find(r => r.id === robotId || r.serial === robotId);
    if (!robot) {
      throw new Error(`Robot with id or serial "${robotId}" not found`);
    }
    this.homey.log({ robot }, 'Fetched single robot');
    return robot;
  }

  /**
   * Get pets for the authenticated user
   * @returns {Promise<Array>} Array of pet data
   */
  async getPets() {
    const userId = this.getUserId();
    if (!userId) {
      throw new Error('Unable to get user ID from token');
    }

    const response = await this.petGraphql(`
      query GetPetsByUser($userId: String!) {
        getPetsByUser(userId: $userId) {
          petId
          userId
          createdAt
          name
          type
          gender
          weight
          weightLastUpdated
          lastWeightReading
          breeds
          age
          birthday
          adoptionDate
          s3ImageURL
          diet
          isFixed
          environmentType
          healthConcerns
          isActive
          whiskerProducts
          petTagId
          weightIdFeatureEnabled
        }
      }
    `, { userId });

    const pets = response.data?.getPetsByUser || [];
    this.homey.log(`Fetched ${pets.length} pets`);
    return pets;
  }

  /**
   * Get specific pet data
   * @param {string} petId - Pet ID
   * @returns {Promise<Object>} Pet data
   */
  async getPet(petId) {
    const pets = await this.getPets();
    const pet = pets.find(p => p.petId === petId);
    if (!pet) {
      throw new Error(`Pet with id "${petId}" not found`);
    }
    this.homey.log({ pet }, 'Fetched single pet');
    return pet;
  }
}

// Attach constants to the class
ApiSession.ENDPOINTS = ENDPOINTS;

module.exports = ApiSession; 