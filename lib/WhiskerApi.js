'use strict';

const CognitoSession = require('./CognitoSession');
const fetch = require('node-fetch');
const { Buffer } = require('buffer');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const LR4_ENDPOINT = 'https://lr4.iothings.site/graphql';

/**
 * WhiskerApi provides methods to authenticate with the Litter-Robot cloud API,
 * perform GraphQL queries, and subscribe to robot updates via WebSocket.
 * Instantiate with email/password or existing Cognito tokens.
 *
 * Usage:
 *   const api = new WhiskerApi({ email, password });
 *   await api.login();
 *   const robots = await api.getRobots();
 */
module.exports = class WhiskerApi {
  constructor({ email, password, tokens, log = console.log, error = console.error } = {}) {
    if (tokens) {
      // initialize from existing tokens
      this.tokens = { ...tokens };
      this.cognitoSession = new CognitoSession({ tokens });
    } else {
      // initialize from email/password
      this.email = email;
      this.password = password;
      this.tokens = null;
      this.cognitoSession = new CognitoSession({ username: email, password });
    }
    this.log = log;
    this.error = error;
  }

  /**
   * Get current access token from CognitoSession, or null if unavailable.
   * @returns {string|null}
   */
  getAccessToken() {
    return typeof this.cognitoSession.getAccessToken === 'function'
      ? this.cognitoSession.getAccessToken()
      : null;
  }

  /**
   * Authenticate using CognitoSession and store retrieved tokens.
   * @returns {Promise<void>}
   */
  async login() {
    await this.cognitoSession.login();
    const accessToken = this.cognitoSession.getAccessToken();
    const idToken = this.cognitoSession.getIdToken();
    const refreshToken = this.cognitoSession.getRefreshToken();

    this.log('Access Token:', accessToken ? '✓' : '✗');
    this.log('ID Token:', idToken ? '✓' : '✗');
    this.log('Refresh Token:', refreshToken ? '✓' : '✗');

    this.tokens = {
      access_token: accessToken,
      id_token: idToken,
      refresh_token: refreshToken,
    };
  }

  /**
   * Decode and log token claims for debugging.
   * @param {string} token - JWT to decode.
   */
  logDecodedTokenClaims(token) {
    try {
      const decoded = jwt.decode(token);
      this.log({ decoded }, 'Decoded ID token claims');
    } catch (err) {
      this.error({ err }, 'Failed to decode token');
    }
  }

  /**
   * Get HTTP headers for authenticated requests, refreshing the token if needed.
   * @returns {Promise<object>}
   */
  async getAuthHeaders() {
    // Retrieve ID token and refresh if expiring soon
    let token = this.cognitoSession.getIdToken();
    if (!token) {
      throw new Error('No valid ID token, please login first');
    }
    // Decode token payload to check expiration
    const decodedToken = jwt.decode(token);
    if (!decodedToken || !decodedToken.exp) {
      throw new Error('Invalid ID token: cannot decode expiration');
    }
    const exp = decodedToken.exp;
    const now = Math.floor(Date.now() / 1000);
    // Proactively refresh token if it's expiring soon (within 30 seconds)
    if (exp - now < 30) {
      this.log('ID token expiring soon, attempting refresh');
      try {
        await this.cognitoSession.refreshSession();
      } catch (err) {
        this.error({ err }, 'Failed to refresh Cognito session');
        throw new Error('Session expired and could not be refreshed. Please repair device.');
      }
      token = this.cognitoSession.getIdToken();
      this.log({ token }, 'Refreshed ID Token');
      // update stored tokens
      if (this.tokens) {
        this.tokens.id_token = token;
        this.tokens.access_token = this.cognitoSession.getAccessToken();
      }
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'HomeyApp/1.0',
    };
  }

  /**
   * Perform a GraphQL query with robust error handling.
   * @param {string} query
   * @param {object} variables
   * @param {boolean} retry
   * @returns {Promise<any>}
   */
  async fetchGraphQL(query, variables = {}, retry = true) {
    // Prepare headers
    const headers = await this.getAuthHeaders();

    this.log({ headers }, 'GraphQL Request Headers');
    this.log({ query, variables }, 'GraphQL Request Payload');

    let res;
    try {
      // Network request
      res = await fetch(LR4_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          variables,
        }),
      });
    } catch (err) {
      // Network error (e.g. DNS, connection refused)
      throw new Error(`Network error during GraphQL request: ${err.message}`);
    }

    let text;
    try {
      // Read response body as text
      text = await res.text();
    } catch (err) {
      throw new Error(`Failed to read GraphQL response body: ${err.message}`);
    }

    this.log({ status: res.status, body: text }, 'GraphQL Response');

    // Authorization error: try to login and retry once
    if (res.status === 401 && retry) {
      // Authorization retry
      this.log('Unauthorized response - refreshing session and retrying');
      await this.cognitoSession.login();
      return this.fetchGraphQL(query, variables, false);
    }

    // Non-OK status
    if (!res.ok) {
      this.error(`GraphQL error response: ${text}`);
      throw new Error(`GraphQL query failed with status ${res.status}: ${text}`);
    }

    // Parse JSON response, handle invalid JSON
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new Error(`Failed to parse GraphQL response as JSON: ${err.message}\nRaw response: ${text}`);
    }
    // If the GraphQL response contains errors, surface them
    if (json.errors && json.errors.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json;
  }

  /**
   * Retrieve the list of Litter-Robot units associated with the authenticated user.
   * @returns {Promise<Array>}
   */
  async getRobots() {
    const query = `
      query GetLR4($userId: String!) {
        getLitterRobot4ByUser(userId: $userId) {
          id: unitId
          serial: serial
          nickname: name
          status: robotStatus
          lastSeen
        }
      }
    `;

    // Extract userId (mid) from ID token
    const userId = this._getUserId();

    const result = await this.fetchGraphQL(query, { userId });

    if (!result.data || !result.data.getLitterRobot4ByUser) {
      throw new Error('Failed to fetch robots data');
    }
    return result.data.getLitterRobot4ByUser;
  }

  /**
   * Get a single robot by its unit ID or serial number.
   * @param {string} id - Unit ID or serial number.
   * @returns {Promise<object>}
   */
  async getRobot(id) {
    const robots = await this.getRobots();
    const robot = robots.find(r => r.id === id || r.serial === id);
    if (!robot) throw new Error(`Robot with id ${id} not found`);
    return robot;
  }

  /**
   * Build WebSocket endpoint URL, headers, and search parameters for GraphQL subscriptions.
   * @returns {Promise<{url: string, headers: object, searchParams: object}>}
   */
  async getWebSocketConfig() {
    const idToken = this.cognitoSession.getIdToken();
    if (!idToken) {
      throw new Error('Missing ID token');
    }

    const params = {
      header: Buffer.from(JSON.stringify({
        Authorization: `Bearer ${idToken}`,
        host: 'lr4.iothings.site',
      })).toString('base64'),
      payload: Buffer.from(JSON.stringify({})).toString('base64'),
    };

    return {
      url: 'wss://lr4.iothings.site/graphql/realtime',
      headers: {
        'sec-websocket-protocol': 'graphql-ws'
      },
      searchParams: params
    };
  }

  /**
   * Return the current Cognito token set.
   * @returns {{ access_token: string, id_token: string, refresh_token: string } | null}
   */
  getTokens() {
    return this.tokens;
  }

  /**
   * Decode the ID token to extract the user ID (mid) claim.
   * @returns {string} userId (mid)
   * @throws {Error} if ID token is missing or invalid
   */
  _getUserId() {
    const idToken = this.cognitoSession.getIdToken();
    if (!idToken) {
      throw new Error('Missing ID token');
    }
    const decoded = jwt.decode(idToken);
    if (!decoded || !decoded.mid) {
      throw new Error('User ID (mid) not found in token claims');
    }
    return decoded.mid;
  }

  /**
   * Subscribe to real-time robot updates using WebSocket.
   * @param {string} robotSerial - Serial number of the robot to subscribe to.
   * @param {function} onMessage - Callback invoked with update payload.
   * @returns {Promise<function>} Unsubscribe function.
   */
  async subscribeToRobotUpdates(robotSerial, onMessage) {
    this.log({ robotSerial }, 'Subscribing to robot updates');
    const token = this.cognitoSession.getIdToken();
    if (!token) throw new Error('Missing ID token');

    // Use getWebSocketConfig to build connection parameters
    const { url: wsUrl, headers: wsHeaders, searchParams } = await this.getWebSocketConfig();
    // Construct full WebSocket URL using URL and searchParams
    const urlObj = new URL(wsUrl);
    Object.entries(searchParams).forEach(([key, value]) => {
      urlObj.searchParams.append(key, value);
    });
    const fullWsUrl = urlObj.toString();
    const ws = new WebSocket(fullWsUrl, 'graphql-ws', { headers: wsHeaders });

    ws.on('open', () => {
      this.log('WebSocket connection opened');

      ws.send(JSON.stringify({
        type: 'connection_init',
        payload: {}
      }));
    });

    // Handle WebSocket message types: connection_ack to start subscription, 'ka' keep-alives, 'data' payloads, and 'error'
    ws.on('message', (data) => {
      try {
        const json = JSON.parse(data);
        this.log({ json }, 'WebSocket received');

        switch (json.type) {
          case 'connection_ack':
            this.log('WebSocket connection acknowledged, sending subscription start');
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
                    serial: robotSerial
                  }
                }),
                extensions: {
                  authorization: {
                    Authorization: `Bearer ${token}`,
                    host: 'lr4.iothings.site'
                  }
                }
              }
            }));
            break;
          case 'ka':
            // keep-alive; can be ignored or used to reset a timeout
            break;
          case 'data':
            const update = json.payload?.data?.litterRobot4StateSubscriptionBySerial;
            this.log({ update }, 'Received robot update payload');
            if (update) {
              onMessage(update);
            }
            break;
          case 'error':
            this.error({ payload: json.payload }, 'Subscription error');
            break;
        }
      } catch (err) {
        this.error({ err }, 'WebSocket message error');
      }
    });

    ws.on('error', (err) => {
      this.error({ err }, 'WebSocket error');
    });

    ws.on('close', () => {
      this.log('WebSocket closed');
    });

    return () => ws.close(); // unsubscribe function
  }
  /**
   * Send a control command to a Litter-Robot 4 device via GraphQL mutation.
   * @param {string} command - Command name.
   * @param {string} serial - Robot serial number.
   * @param {string|null} value - Optional command value.
   * @returns {Promise<any>}
   */
  async sendCommand(command, serial, value = null) {
    if (!serial || !command) {
      throw new Error('Both serial and command are required');
    }
    // Send command mutation to Litter-Robot API
    const query = `
      mutation sendCommand($serial: String!, $command: String!, $value: String) {
        sendLitterRobot4Command(input: {
          serial: $serial,
          command: $command,
          value: $value
        })
      }
    `;

    const result = await this.fetchGraphQL(query, {
      serial,
      command,
      value,
    });
    // If the GraphQL response contains errors, surface them
    if (result.errors && result.errors.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    const response = result?.data?.sendLitterRobot4Command;

    if (!response || (typeof response === 'string' && response.includes('Error'))) {
      throw new Error(`Failed to send command: ${response}`);
    }

    return response;
  }
};