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
   * Internal method to make GraphQL requests with retry logic and token refresh.
   * @param {string} endpoint - GraphQL endpoint URL
   * @param {Object} data - Request data
   * @param {string} apiType - API type for logging
   * @returns {Promise<Object>} - Response data
   */
  async _makeGraphQLRequest(endpoint, data, apiType = 'Unknown') {
    const requestData = {
      method: 'POST',
      timeout: this.timeout,
      body: JSON.stringify(data),
    };

    // Extract operation name for cleaner logging
    const operationName = this._extractOperationName(data.query);
    this.homey.log(`\x1b[36mGraphQL ${operationName} request sent to ${endpoint}\x1b[0m`);

    return retryWithBackoff(async (attempt = 0) => {
      // Get fresh auth headers for each attempt (in case tokens were refreshed)
      const authHeaders = await this.getAuthHeaders();
      requestData.headers = { ...authHeaders };

      if (attempt > 0) {
        this.homey.log(`\x1b[33mGraphQL ${operationName} retry attempt ${attempt + 1} to ${endpoint}\x1b[0m`);
      }

      const response = await fetch(endpoint, requestData);
      
      if (!response.ok) {
        const errorText = await response.text();
        this.homey.error(`\x1b[31mGraphQL ${operationName} request failed: ${response.status} ${response.statusText}\x1b[0m`);
        
        // If we get a 401 Unauthorized and this is the first attempt, try to refresh tokens
        if (response.status === 401 && attempt === 0) {
          this.homey.log('Received 401 Unauthorized, attempting to refresh tokens...');
          try {
            await this.cognitoSession.refreshSession();
            this.homey.log('Token refresh successful, retrying request...');
            // Don't throw error, let retryWithBackoff handle the retry
            throw new Error('Token refreshed, retry request');
          } catch (refreshError) {
            this.homey.error('Token refresh failed:', refreshError.message);
            // If token refresh fails, throw the original 401 error
            throw new WhiskerApiException(
              `HTTP ${response.status}: ${response.statusText}`,
              response.status,
              new Error(errorText)
            );
          }
        }
        
        throw new WhiskerApiException(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          new Error(errorText)
        );
      }

      const responseData = await response.json();
      
      this.homey.log(`\x1b[32mGraphQL ${operationName} response received from ${endpoint} (${response.status})\x1b[0m`);

      // Log GraphQL errors if present
      if (responseData.errors && responseData.errors.length > 0) {
        this.homey.error(`GraphQL errors for ${operationName}:`, responseData.errors);
      }

      return responseData;
    }, 3, 1000); // 3 retries with 1 second base delay
  }

  /**
   * Extract operation name from GraphQL query for cleaner logging.
   * @param {string} query - GraphQL query string
   * @returns {string} - Operation name or 'query'/'mutation'/'subscription'
   * @private
   */
  _extractOperationName(query) {
    if (!query) return 'unknown';
    
    // Try to extract operation name from query
    const operationMatch = query.match(/(?:query|mutation|subscription)\s+(\w+)/);
    if (operationMatch) {
      return operationMatch[1];
    }
    
    // Fallback to operation type
    if (query.includes('query')) return 'query';
    if (query.includes('mutation')) return 'mutation';
    if (query.includes('subscription')) return 'subscription';
    
    return 'unknown';
  }

  /**
   * Log WebSocket messages in a clean, concise way.
   * @param {string} deviceId - Device identifier
   * @param {Object} message - WebSocket message
   * @private
   */
  _logWebSocketMessage(deviceId, message) {
    const messageType = message.type || 'unknown';
    
    // Only log important message types, skip keepalive messages
    if (messageType === 'ka') {
      return; // Skip keepalive messages entirely
    }
    
    if (messageType === 'data') {
      this.homey.log(`\x1b[36mWebSocket data received for device ${deviceId}\x1b[0m`);
    } else if (messageType === 'connection_ack') {
      this.homey.log(`\x1b[32mWebSocket connection acknowledged for device ${deviceId}\x1b[0m`);
    } else if (messageType === 'start_ack') {
      this.homey.log(`\x1b[32mWebSocket subscription started for device ${deviceId}\x1b[0m`);
    } else if (messageType === 'error') {
      this.homey.error(`\x1b[31mWebSocket error for device ${deviceId}:\x1b[0m`, message);
    } else {
      // For other message types, log briefly
      this.homey.log(`\x1b[35mWebSocket ${messageType} message for device ${deviceId}\x1b[0m`);
    }
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
          this._logWebSocketMessage(deviceId, json);

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
                          scoopsSavedCount
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
                          # LitterHopper fields
                          hopperStatus
                          isHopperRemoved
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
              if (update) {
                this.eventEmitter.emitDataReceived(deviceId, update, 'websocket');
                this._handleWebSocketMessage(deviceId, update);
              }
              break;
              
            case 'error':
              this.homey.error(`WebSocket subscription error for device ${deviceId}:`, json.payload);
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
      
      ws.on('close', (code, reason) => {
        this.homey.log(`WebSocket closed for device ${deviceId}: ${code} ${reason}`);
        this.websocketConnections.delete(deviceId);
        this.eventEmitter.emitDisconnected(deviceId, reason || 'connection_closed');
      });
      
      // Set timeout for connection
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close(1000, 'Connection timeout');
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
      ws.close(1000, 'Device cleanup');
      this.websocketConnections.delete(deviceId);
    }
  }

  /**
   * Close all WebSocket connections.
   */
  closeAllWebSocketConnections() {
    this.homey.log('Closing all WebSocket connections');
    for (const [deviceId, ws] of this.websocketConnections) {
      ws.close(1000, 'App shutdown');
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
    // The data is already the robot update object, not wrapped in payload
    this.eventEmitter.emitUpdate(deviceId, data);
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
          # LitterHopper fields
          hopperStatus
          isHopperRemoved
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
          this.homey.log(`Fetched robot: ${robot.name || robot.serial}`);
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
          this.homey.log(`Fetched pet: ${pet.name || pet.petId}`);
    return pet;
  }
}

// Attach constants to the class
ApiSession.ENDPOINTS = ENDPOINTS;

module.exports = ApiSession; 