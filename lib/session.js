const EventEmitter = require('events');
const WebSocket = require('ws');
const {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoIdToken,
  CognitoAccessToken,
  CognitoRefreshToken,
} = require('amazon-cognito-identity-js');
const nodeFetch = require('node-fetch');
const {
  retryWithBackoff, extractGraphQLOperationName, encodeBase64, safeStringify, safeParse, colorize, LOG_COLORS,
  decodeJwt, getUnixTimestamp, decodeBase64, getTokenExpirationInfo, TOKEN_CONFIG,
} = require('./utils');
const {
  emitDataReceived, emitConnected, emitDisconnected, emitError,
} = require('./event');
const {
  WhiskerApiException, WhiskerTokenException, WhiskerAuthenticationException, WhiskerLoginException,
  getCognitoErrorMessage, isCognitoWarningError,
} = require('./exceptions');
const TokenStore = require('./tokenstore');

/**
 * @module session
 * @description Unified session management for Whisker services, handling AWS Cognito authentication,
 * token refresh, API requests, and WebSocket connections for Litter-Robot devices.
 */

if (typeof global.fetch !== 'function') {
  global.fetch = nodeFetch;
}

const ENDPOINTS = {
  PET: 'https://pet-profile.iothings.site/graphql',
  LR4: 'https://lr4.iothings.site/graphql',
  LR4_WS: 'wss://lr4.iothings.site/graphql',
  LR3: 'https://v2.api.whisker.iothings.site',
  LR3_WS: 'https://8s1fz54a82.execute-api.us-east-1.amazonaws.com/prod',
};

const DEFAULT_USER_POOL_ID = decodeBase64('dXMtZWFzdC0xX3JqaE5uWlZBbQ==');
const DEFAULT_CLIENT_ID = decodeBase64('NDU1MnVqZXUzYWljOTBuZjhxbjUzbGV2bW4=');

/**
 * Unified session manager for Whisker services.
 * Handles AWS Cognito authentication, token lifecycle, API requests, and WebSocket connections.
 * @class
 * @extends EventEmitter
 */
class Session extends EventEmitter {
  /**
   * Creates a new Session instance.
   * @param {Object} options - Configuration options
   * @param {string} [options.username] - Username for authentication (required if tokens not provided)
   * @param {string} [options.password] - Password for authentication (required if tokens not provided)
   * @param {Object} [options.tokens] - Existing tokens to restore session (required if credentials not provided)
   * @param {Function} [options.onTokensRefreshed] - Callback invoked when tokens are refreshed
   * @param {Object} options.homey - Homey instance (required)
   * @param {EventEmitter} [options.eventEmitter] - Custom event emitter, otherwise creates new one
   * @throws {Error} If homey instance is missing
   * @throws {WhiskerAuthenticationException} If neither tokens nor credentials are provided
   */
  constructor({
    username, password, tokens = null, onTokensRefreshed = null, homey = null, eventEmitter = null,
  }) {
    super();
    if (!homey) {
      throw new Error('Homey instance is required');
    }

    this.homey = homey;
    this.log = homey.log;
    this.tokenStore = new TokenStore(homey);
    this.eventEmitter = eventEmitter || new EventEmitter();
    if (this.eventEmitter === eventEmitter) {
      this.eventEmitter.setMaxListeners(100);
    }
    this.websocketConnections = new Map();
    this.connectionState = new Map();
    this.timeout = 30000;

    const userPoolId = process.env.COGNITO_USER_POOL_ID || DEFAULT_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID || DEFAULT_CLIENT_ID;
    this.userPool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });

    this.log(`[Session] ${colorize(LOG_COLORS.INFO, 'Initializing session manager')}`);

    this.onTokensRefreshed = onTokensRefreshed;
    this._refreshing = false;
    this._refreshPromise = null;

    if (tokens) {
      this._initializeWithTokens(tokens);
    } else if (username && password) {
      this._initializeWithCredentials(username, password);
    } else {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'Invalid initialization - missing required credentials')}`);
      throw new WhiskerAuthenticationException('Either tokens or username and password must be provided');
    }
  }

  /**
   * Restores session from existing tokens.
   * Extracts user identity from ID token to initialize CognitoUser without re-authentication.
   * @param {Object} tokens - Token object containing id_token, access_token, and refresh_token
   * @throws {WhiskerTokenException} If tokens are incomplete or user identity cannot be extracted
   * @private
   */
  _initializeWithTokens(tokens) {
    this.log(`[Session] ${colorize(LOG_COLORS.INFO, 'Restoring session from existing tokens')}`);
    const { id_token, access_token, refresh_token } = tokens;
    if (!id_token || !access_token || !refresh_token) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'Invalid tokens provided - missing required components')}`);
      throw new WhiskerTokenException('Tokens must include id_token, access_token, and refresh_token');
    }
    const decoded = decodeJwt(id_token);
    const email = decoded?.email || decoded?.username || decoded?.['cognito:username'];
    if (!email) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'Cannot extract username from provided id_token')}`);
      throw new WhiskerTokenException('Cannot extract username/email from provided id_token');
    }
    this.cognitoUser = new CognitoUser({ Username: email, Pool: this.userPool });
    this.session = null;
    this.setSession({ id_token, access_token, refresh_token });
    this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `Session restored successfully for user ${email}`)}`);
  }

  /**
   * Prepares session for fresh authentication.
   * Stores credentials and initializes CognitoUser for login flow.
   * @param {string} username - Username for authentication
   * @param {string} password - Password for authentication
   * @private
   */
  _initializeWithCredentials(username, password) {
    this.log(`[Session] ${colorize(LOG_COLORS.INFO, `Initializing for fresh authentication with username ${username}`)}`);
    this.username = username;
    this.password = password;
    this.cognitoUser = new CognitoUser({ Username: username, Pool: this.userPool });
    this.session = null;
  }

  /**
   * Updates session with new tokens.
   * Creates CognitoUserSession wrapper and synchronizes with CognitoUser to maintain consistency.
   * @param {Object} tokens - Token object containing id_token, access_token, and refresh_token
   */
  setSession(tokens) {
    const { id_token, access_token, refresh_token } = tokens;
    this.session = new CognitoUserSession({
      IdToken: new CognitoIdToken({ IdToken: id_token }),
      AccessToken: new CognitoAccessToken({ AccessToken: access_token }),
      RefreshToken: new CognitoRefreshToken({ RefreshToken: refresh_token }),
    });
    if (this.cognitoUser) {
      this.cognitoUser.setSignInUserSession(this.session);
    }
    if (this.homey) {
      const accessTokenInfo = getTokenExpirationInfo(access_token);
      const idTokenInfo = getTokenExpirationInfo(id_token);

      if (accessTokenInfo) {
        this.log(`[Session] ${colorize(LOG_COLORS.INFO, `Access token expires in ${accessTokenInfo.formattedTimeUntilExpiry} (${accessTokenInfo.expiresAt})`)}`);
      }

      if (idTokenInfo) {
        this.log(`[Session] ${colorize(LOG_COLORS.INFO, `ID token expires in ${idTokenInfo.formattedTimeUntilExpiry} (${idTokenInfo.expiresAt})`)}`);
      }
    }
  }

  /**
   * Ensures CognitoUser is initialized before operations.
   * Prevents errors from attempting authentication operations without user context.
   * @throws {WhiskerAuthenticationException} If CognitoUser is not initialized
   * @private
   */
  _assertUser() {
    if (!this.cognitoUser) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'Operation failed - CognitoUser is not initialized')}`);
      throw new WhiskerAuthenticationException('CognitoUser is not initialized');
    }
  }

  /**
   * Authenticates user with AWS Cognito.
   * Handles MFA, password changes, and other challenge flows. Stores tokens on success.
   * @returns {Promise<CognitoUserSession>} The authenticated session
   * @throws {WhiskerLoginException} If authentication fails or challenges are not supported
   */
  async login() {
    this.log(`[Session] ${colorize(LOG_COLORS.INFO, `Authenticating user ${this.username}`)}`);
    if (!this.username || !this.password) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'Login failed - missing username or password')}`);
      throw new WhiskerLoginException('Username and password are required to login');
    }
    this._assertUser();

    const authDetails = new AuthenticationDetails({
      Username: this.username,
      Password: this.password,
    });

    return new Promise((resolve, reject) => {
      this.cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => {
          this.session = session;
          this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `Authentication successful for user ${this.username}`)}`);
          const tokens = this.getTokens();
          if (tokens) {
            this.tokenStore.setTokens(tokens);
            if (this.onTokensRefreshed) {
              this.onTokensRefreshed(tokens);
            }
          }
          resolve(session);
        },
        onFailure: (err) => {
          const userMessage = getCognitoErrorMessage(err);

          if (isCognitoWarningError(err)) {
            const errorCode = err.code || err.name;
            this.homey.log(`[Session] ${colorize(LOG_COLORS.WARNING, `Authentication failed for user ${this.username}: ${errorCode}`)}`);
          } else {
            this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `Authentication failed for user ${this.username}:`)}`, err);
          }

          reject(new WhiskerLoginException(userMessage, err));
        },
        newPasswordRequired: () => {
          this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `New password required for user ${this.username}`)}`);
          reject(new WhiskerLoginException('New password required'));
        },
        mfaRequired: () => {
          this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `MFA required for user ${this.username}`)}`);
          reject(new WhiskerLoginException('MFA required'));
        },
        totpRequired: () => {
          this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `TOTP required for user ${this.username}`)}`);
          reject(new WhiskerLoginException('TOTP required'));
        },
        customChallenge: () => {
          this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `Custom challenge required for user ${this.username}`)}`);
          reject(new WhiskerLoginException('Custom challenge required'));
        },
      });
    });
  }

  /**
   * Validates session token expiration.
   * Uses buffer period to refresh tokens proactively before expiration to avoid failed requests.
   * @returns {boolean} True if token is valid with buffer time remaining
   */
  isSessionValid() {
    const idToken = this.getIdToken();
    if (!idToken) {
      this.log(`[Session] ${colorize(LOG_COLORS.WARNING, 'Session validation: failed - no ID token available')}`);
      return false;
    }
    const decoded = decodeJwt(idToken);
    if (!decoded?.exp) {
      this.log(`[Session] ${colorize(LOG_COLORS.WARNING, 'Session validation: failed - no expiration in token')}`);
      return false;
    }
    const now = getUnixTimestamp();
    const isValid = decoded.exp > now + TOKEN_CONFIG.EXPIRATION_BUFFER_SECONDS;

    if (this.homey && !isValid) {
      this.log(`[Session] ${colorize(LOG_COLORS.WARNING, `Session validation: token expires in ${decoded.exp - now} seconds, refreshing proactively...`)}`);
    }

    return isValid;
  }

  /**
   * Retrieves the ID token from the current session.
   * @returns {string|null} JWT ID token or null if no session exists
   */
  getIdToken() {
    return this.session ? this.session.getIdToken().getJwtToken() : null;
  }

  /**
   * Extracts user ID from the ID token.
   * @returns {string|null} User ID (mid) or null if not available
   */
  getUserId() {
    const idToken = this.getIdToken();
    const decoded = decodeJwt(idToken);
    return decoded?.mid || null;
  }

  /**
   * Retrieves the access token from the current session.
   * @returns {string|null} JWT access token or null if no session exists
   */
  getAccessToken() {
    return this.session ? this.session.getAccessToken().getJwtToken() : null;
  }

  /**
   * Retrieves the refresh token from the current session.
   * @returns {string|null} Refresh token or null if no session exists
   */
  getRefreshToken() {
    return this.session ? this.session.getRefreshToken().getToken() : null;
  }

  /**
   * Signs out user and clears all authentication state.
   * Removes tokens from storage to prevent reuse after logout.
   */
  signOut() {
    if (this.cognitoUser) {
      this.log(`[Session] ${colorize(LOG_COLORS.SYSTEM, 'Signing out user')}`);
      this.cognitoUser.signOut();
      this.session = null;
      this.tokenStore.clearTokens();
      this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, 'User signed out successfully')}`);
    }
  }

  /**
   * Refreshes session tokens using refresh token.
   * Prevents concurrent refresh attempts by returning existing promise if refresh in progress.
   * @returns {Promise<CognitoUserSession>} The refreshed session
   * @throws {WhiskerTokenException} If session or refresh token is missing
   */
  async refreshSession() {
    this._assertUser();

    this.log(`[Session] ${colorize(LOG_COLORS.INFO, 'Refreshing session tokens')}`);

    if (!this.session) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'Session refresh failed - no session available')}`);
      throw new WhiskerTokenException('No session available to refresh');
    }
    const refreshTokenObj = this.session.getRefreshToken();
    const refreshToken = refreshTokenObj?.getToken();
    if (!refreshToken) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'Session refresh failed - missing refresh token')}`);
      throw new WhiskerTokenException('Missing refresh token. Cannot refresh session.');
    }

    if (this._refreshing) {
      this.log(`[Session] ${colorize(LOG_COLORS.WARNING, 'Session refresh already in progress, returning existing promise')}`);
      return this._refreshPromise;
    }
    this._refreshing = true;
    this._refreshPromise = new Promise((resolve, reject) => {
      this.cognitoUser.refreshSession(refreshTokenObj, (err, session) => {
        this._refreshing = false;
        this._refreshPromise = null;
        if (err) {
          this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'Session refresh failed:')}`, err);
          this.signOut();
          reject(err);
          return;
        }
        this.session = session;
        this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, 'Session tokens refreshed successfully')}`);

        const tokens = this.getTokens();
        if (tokens) {
          this.tokenStore.setTokens(tokens);
          if (this.onTokensRefreshed) {
            this.onTokensRefreshed(tokens);
          }
          if (this.homey) {
            const accessTokenInfo = getTokenExpirationInfo(tokens.access_token);
            const idTokenInfo = getTokenExpirationInfo(tokens.id_token);

            if (accessTokenInfo) {
              this.log(`[Session] ${colorize(LOG_COLORS.INFO, `New access token expires in ${accessTokenInfo.formattedTimeUntilExpiry} (${accessTokenInfo.expiresAt})`)}`);
            }

            if (idTokenInfo) {
              this.log(`[Session] ${colorize(LOG_COLORS.INFO, `New ID token expires in ${idTokenInfo.formattedTimeUntilExpiry} (${idTokenInfo.expiresAt})`)}`);
            }
          }
        }

        resolve(session);
      });
    });
    return this._refreshPromise;
  }

  /**
   * Retrieves current session tokens in standardized format.
   * @returns {Object|null} Token object with id_token, access_token, refresh_token, or null if no session
   */
  getTokens() {
    if (!this.session) {
      return null;
    }

    return {
      id_token: this.session.getIdToken().getJwtToken(),
      access_token: this.session.getAccessToken().getJwtToken(),
      refresh_token: this.session.getRefreshToken().getToken(),
    };
  }

  /**
   * Generates authentication headers for API requests.
   * Refreshes tokens if expired and includes platform-specific user agent for backend identification.
   * @param {string} robotType - Robot type ('LR3' or 'LR4') to determine token type and headers
   * @returns {Promise<Object>} Headers object with Authorization and other required headers
   * @throws {Error} If robot type is unsupported
   * @throws {WhiskerTokenException} If required token is missing
   */
  async getAuthHeaders(robotType) {
    if (!this.isSessionValid()) {
      await this.refreshSession();
    }

    const tokens = this.getTokens();

    const robotConfig = {
      LR3: {
        tokenKey: 'id_token',
        additionalHeaders: {
          Accept: 'application/json',
          'x-api-key': 'p7ndMoj61npRZP5CVz9v4Uj0bG769xy6758QRBPb',
        },
      },
      LR4: {
        tokenKey: 'access_token',
        additionalHeaders: {},
      },
    };

    const config = robotConfig[robotType];
    if (!config) {
      throw new Error(`Unsupported robot type: ${robotType}`);
    }
    const { tokenKey } = config;

    if (!tokens || !tokens[tokenKey]) {
      throw new WhiskerTokenException(`Missing ${tokenKey} for ${robotType} API`);
    }

    const appVersion = this.homey.manifest.version || '1.0.0';
    const platform = this.homey.cloud ? 'HomeyCloud' : 'HomeyPro';
    const headers = {
      Authorization: `Bearer ${tokens[tokenKey]}`,
      'Content-Type': 'application/json',
      'User-Agent': `${platform}App/${appVersion}`,
      ...config.additionalHeaders,
    };

    return headers;
  }

  /**
   * Executes GraphQL query against LR4 endpoint.
   * @param {string} query - GraphQL query string
   * @param {Object} [variables={}] - Query variables
   * @returns {Promise<Object>} GraphQL response
   */
  async lr4Graphql(query, variables = {}) {
    return this._makeGraphQLRequest(ENDPOINTS.LR4, { query, variables }, 'LR4');
  }

  /**
   * Executes GraphQL query against Pet Profile endpoint.
   * @param {string} query - GraphQL query string
   * @param {Object} [variables={}] - Query variables
   * @returns {Promise<Object>} GraphQL response
   */
  async petGraphql(query, variables = {}) {
    return this._makeGraphQLRequest(ENDPOINTS.PET, { query, variables }, 'Pet');
  }

  /**
   * Executes GraphQL request with automatic retry and token refresh.
   * Retries 401 responses once after forcing token refresh to handle transient auth failures.
   * @param {string} endpoint - GraphQL endpoint URL
   * @param {Object} data - Request data with query and variables
   * @param {string} [apiType='Unknown'] - API type identifier for logging
   * @returns {Promise<Object>} GraphQL response
   * @private
   */
  async _makeGraphQLRequest(endpoint, data, apiType = 'Unknown') {
    const requestData = {
      method: 'POST',
      timeout: this.timeout,
      body: safeStringify(data),
    };

    const operationName = extractGraphQLOperationName(data.query);
    this.log(`[Session] ${colorize(LOG_COLORS.INFO, `GraphQL ${operationName} request sent to ${endpoint}`)}`);

    return retryWithBackoff(async (attempt = 0) => {
      const authHeaders = await this.getAuthHeaders('LR4');
      requestData.headers = { ...authHeaders };

      if (attempt > 0) {
        this.log(`[Session] ${colorize(LOG_COLORS.WARNING, `GraphQL ${operationName} retry attempt ${attempt + 1} to ${endpoint}`)}`);
      }

      const response = await fetch(endpoint, requestData);

      if (!response.ok) {
        const errorText = await response.text();
        this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `GraphQL ${operationName} request failed: ${response.status} ${response.statusText}`)}`);

        if (response.status === 401 && attempt === 0) {
          this.log(`[Session] ${colorize(LOG_COLORS.INFO, 'Received 401 Unauthorized, forcing token refresh...')}`);
          const retryError = new Error('Token refresh required, retrying request');
          retryError.isRetryTrigger = true;
          throw retryError;
        }

        throw new WhiskerApiException(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          new Error(errorText),
        );
      }

      const responseData = await response.json();
      this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `GraphQL ${operationName} response received from ${endpoint} (${response.status})`)}`);

      if (responseData.errors && responseData.errors.length > 0) {
        this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `GraphQL errors for ${operationName}:`)}`, responseData.errors);
      }

      return responseData;
    }, 3, 1000);
  }

  /**
   * Logs WebSocket messages, filtering out keep-alive traffic.
   * Suppresses ping/pong/ka messages to reduce log noise while preserving important events.
   * @param {string} deviceId - Device identifier
   * @param {Object} message - WebSocket message object
   * @private
   */
  _logWebSocketMessage(deviceId, message) {
    const messageType = message.type || 'unknown';

    if (messageType === 'ka' || messageType === 'ping' || messageType === 'pong') {
      return;
    }

    const logHandlers = {
      data: () => {
        this.log(`[Session] ${colorize(LOG_COLORS.INFO, `WebSocket data received for device ${deviceId}`)}`);
      },
      connection_ack: () => {
        this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `WebSocket connection acknowledged for device ${deviceId}`)}`);
      },
      start_ack: () => {
        this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `WebSocket subscription started for device ${deviceId}`)}`);
      },
      error: () => {
        this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `WebSocket error for device ${deviceId}:`)}`, message);
      },
      MODIFY: () => {
        this.log(`[Session] ${colorize(LOG_COLORS.INFO, `LR3 device state update received for device ${deviceId}`)}`);
      },
      INSERT: () => {
        this.log(`[Session] ${colorize(LOG_COLORS.INFO, `LR3 ${messageType} event received for device ${deviceId}`)}`);
      },
      DELETE: () => {
        this.log(`[Session] ${colorize(LOG_COLORS.INFO, `LR3 ${messageType} event received for device ${deviceId}`)}`);
      },
    };

    const handler = logHandlers[messageType];
    if (handler) {
      handler();
    } else {
      this.log(`[Session] ${colorize(LOG_COLORS.COMMAND, `WebSocket ${messageType} message for device ${deviceId}`)}`);
    }
  }

  /**
   * Creates WebSocket connection for real-time device updates.
   * Routes to device-specific implementation and reuses existing connections when available.
   * @param {string} deviceId - Device identifier
   * @param {Object} [options={}] - Connection options including deviceType and serial
   * @returns {Promise<WebSocket>} The WebSocket connection
   * @throws {Error} If device type is unsupported
   */
  async createWebSocket(deviceId, options = {}) {
    const existing = this.websocketConnections.get(deviceId);
    if (existing && existing.readyState === WebSocket.OPEN) {
      this.log(`[Session] ${colorize(LOG_COLORS.WARNING, `WebSocket connection already open for device ${deviceId}`)}`);
      return existing;
    }

    const deviceType = options.deviceType || 'litter_robot_4';
    const wsHandlers = {
      litter_robot_4: (id, opts) => this._createLR4WebSocket(id, opts),
      litter_robot_3: (id, opts) => this._createLR3WebSocket(id, opts),
    };

    const handler = wsHandlers[deviceType];
    if (!handler) {
      throw new Error(`Unsupported device type for WebSocket: ${deviceType}`);
    }
    return handler(deviceId, options);
  }

  /**
   * Creates WebSocket connection for LR4 devices using GraphQL subscriptions.
   * Establishes connection, authenticates, starts subscription, and sets up heartbeat monitoring.
   * @param {string} deviceId - Device identifier
   * @param {Object} [options={}] - Connection options including serial number
   * @returns {Promise<WebSocket>} The WebSocket connection
   * @throws {WhiskerTokenException} If ID token is missing
   * @private
   */
  async _createLR4WebSocket(deviceId, options = {}) {
    const serial = options.serial || deviceId;
    const state = this._getOrCreateConnState(deviceId, { serial });
    state.options = { ...options, serial };

    if (!this.isSessionValid()) {
      await this.refreshSession();
    }
    const tokens = this.getTokens();
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

    const urlObj = new URL(`${ENDPOINTS.LR4_WS}/realtime`);
    Object.entries(params).forEach(([key, value]) => urlObj.searchParams.append(key, value));
    const fullWsUrl = urlObj.toString();

    this.log(`[Session] ${colorize(LOG_COLORS.INFO, `Creating LR4 WebSocket connection for device ${deviceId}`)}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(fullWsUrl, 'graphql-ws', {
        headers: { 'sec-websocket-protocol': 'graphql-ws' },
      });

      let connectionTimeout = null;

      ws.on('open', () => {
        this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `LR4 WebSocket connected for device ${deviceId}`)}`);
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
              this.log(`[Session] ${colorize(LOG_COLORS.INFO, 'LR4 WebSocket connection acknowledged, sending subscription start')}`);
              if (connectionTimeout) {
                this.homey.clearTimeout(connectionTimeout);
                connectionTimeout = null;
              }
              this.websocketConnections.set(deviceId, ws);
              st.reconnectAttempts = 0;
              this._setupHeartbeat(deviceId, ws);
              emitConnected(this.eventEmitter, deviceId, { url: fullWsUrl }, this.homey);

              ws.send(safeStringify({
                id: '1',
                type: 'start',
                payload: {
                  data: safeStringify({
                    query: `
                      subscription litterRobot4StateSubscriptionBySerial($serial: String!) {
                        litterRobot4StateSubscriptionBySerial(serial: $serial) {
                          unitId, name, serial, userId, espFirmware, picFirmwareVersion,
                          picFirmwareVersionHex, laserBoardFirmwareVersion, laserBoardFirmwareVersionHex,
                          wifiRssi, unitPowerType, catWeight, displayCode, unitTimezone, unitTime,
                          cleanCycleWaitTime, isKeypadLockout, nightLightMode, nightLightBrightness,
                          isPanelSleepMode, panelSleepTime, panelWakeTime, unitPowerStatus, sleepStatus,
                          robotStatus, globeMotorFaultStatus, pinchStatus, catDetect, isBonnetRemoved,
                          isNightLightLEDOn, odometerPowerCycles, odometerCleanCycles, panelBrightnessHigh,
                          panelBrightnessLow, smartWeightEnabled, odometerEmptyCycles, odometerFilterCycles,
                          isDFIResetPending, DFINumberOfCycles, DFILevelPercent, isDFIFull, DFIFullCounter,
                          DFITriggerCount, litterLevel, DFILevelMM, isCatDetectPending,
                          globeMotorRetractFaultStatus, robotCycleStatus, robotCycleState, weightSensor,
                          isOnline, isOnboarded, isProvisioned, isDebugModeActive, lastSeen, sessionId,
                          setupDateTime, isFirmwareUpdateTriggered, firmwareUpdateStatus, wifiModeStatus,
                          isUSBPowerOn, USBFaultStatus, isDFIPartialFull, isLaserDirty, surfaceType,
                          scoopsSavedCount, optimalLitterLevel, litterLevelPercentage, litterLevelState,
                          weekdaySleepModeEnabled {
                            Sunday { sleepTime, wakeTime, isEnabled },
                            Monday { sleepTime, wakeTime, isEnabled },
                            Tuesday { sleepTime, wakeTime, isEnabled },
                            Wednesday { sleepTime, wakeTime, isEnabled },
                            Thursday { sleepTime, wakeTime, isEnabled },
                            Friday { sleepTime, wakeTime, isEnabled },
                            Saturday { sleepTime, wakeTime, isEnabled }
                          },
                          hopperStatus, isHopperRemoved
                        }
                      }
                    `,
                    variables: { serial: st.serial || serial },
                  }),
                  extensions: {
                    authorization: {
                      Authorization: `Bearer ${idToken}`,
                      host: 'lr4.iothings.site',
                    },
                  },
                },
              }));
              resolve(ws);
              break;

            case 'data': {
              const update = json.payload?.data?.litterRobot4StateSubscriptionBySerial;
              if (update) {
                emitDataReceived(this.eventEmitter, deviceId, update, 'websocket', this.homey);
              }
              break;
            }

            case 'error':
              this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `LR4 WebSocket subscription error for device ${deviceId}:`)}`, json.payload);
              break;

            case 'start_ack':
              break;

            case 'ka':
              break;

            default:
              this.log(`[Session] ${colorize(LOG_COLORS.WARNING, `Received unknown WebSocket message type: ${json.type}`)}`);
              break;
          }
        } catch (error) {
          this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `Failed to parse LR4 WebSocket message for device ${deviceId}:`)}`, error);
          emitError(this.eventEmitter, error, `websocket_parse_${deviceId}`, this.homey);
        }
      });

      const onSocketFailure = (where, errOrCode, reason) => {
        this.homey.log(`[Session] ${colorize(LOG_COLORS.WARNING, `LR4 WebSocket ${where} for device ${deviceId}${reason ? `: ${reason}` : ''}`)}`, errOrCode || '');
        this.websocketConnections.delete(deviceId);
        this._clearHeartbeat(deviceId);
        emitDisconnected(this.eventEmitter, deviceId, reason || where, this.homey);
      };

      ws.on('error', (error) => {
        onSocketFailure('error', error);
        this._scheduleReconnect(deviceId);
      });

      ws.on('close', (code, reason) => {
        onSocketFailure(`closed (${code})`, null, reason || 'connection_closed');
        const state = this.connectionState.get(deviceId);
        if (state) {
          this._scheduleReconnect(deviceId);
        } else {
          this.homey.log(`[Session] ${colorize(LOG_COLORS.INFO, `Connection ${deviceId} was manually closed, skipping reconnect`)}`);
        }
      });

      connectionTimeout = this.homey.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN && !this.websocketConnections.has(deviceId)) {
          try {
            ws.close(1000, 'Connection timeout');
          } catch (e) {
            // Ignore - connection may already be closed
          }
          emitDisconnected(this.eventEmitter, deviceId, 'connection_timeout', this.homey);
          reject(new Error('LR4 WebSocket connection timeout'));
        }
        connectionTimeout = null;
      }, this.timeout);
    });
  }

  /**
   * Creates WebSocket connection for LR3 devices.
   * Establishes connection and forwards all messages to observers for device-specific handling.
   * @param {string} deviceId - Device identifier
   * @param {Object} [options={}] - Connection options including serial number
   * @returns {Promise<WebSocket>} The WebSocket connection
   * @throws {WhiskerTokenException} If ID token is missing
   * @private
   */
  async _createLR3WebSocket(deviceId, options = {}) {
    const serial = options.serial || deviceId;
    const state = this._getOrCreateConnState(deviceId, { serial });
    state.options = { ...options, serial };

    if (!this.isSessionValid()) {
      await this.refreshSession();
    }
    const tokens = this.getTokens();
    const idToken = tokens ? tokens.id_token : null;
    if (!idToken) {
      throw new WhiskerTokenException('Missing ID token for LR3 WebSocket connection');
    }

    this.log(`[Session] ${colorize(LOG_COLORS.INFO, `Creating LR3 WebSocket connection for device ${deviceId}`)}`);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(ENDPOINTS.LR3_WS, {
        headers: {
          authorization: `Bearer ${idToken}`,
        },
      });

      let connectionTimeout = null;

      ws.on('open', () => {
        this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `LR3 WebSocket connected for device ${deviceId}`)}`);
        if (connectionTimeout) {
          this.homey.clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }
        this.websocketConnections.set(deviceId, ws);
        state.reconnectAttempts = 0;
        emitConnected(this.eventEmitter, deviceId, { url: ENDPOINTS.LR3_WS }, this.homey);

        ws.send(JSON.stringify({ action: 'ping' }));
        resolve(ws);
      });

      ws.on('message', (data) => {
        const st = this._getOrCreateConnState(deviceId);
        st.lastMessageAt = Date.now();

        try {
          const json = safeParse(data);
          this._logWebSocketMessage(deviceId, json);

          emitDataReceived(this.eventEmitter, deviceId, json, 'websocket', this.homey);
        } catch (error) {
          this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `Failed to parse LR3 WebSocket message for device ${deviceId}:`)}`, error);
          emitError(this.eventEmitter, error, `lr3_websocket_parse_${deviceId}`, this.homey);
        }
      });

      const onSocketFailure = (where, errOrCode, reason) => {
        this.homey.log(`[Session] ${colorize(LOG_COLORS.WARNING, `LR3 WebSocket ${where} for device ${deviceId}${reason ? `: ${reason}` : ''}`)}`, errOrCode || '');
        this.websocketConnections.delete(deviceId);
        emitDisconnected(this.eventEmitter, deviceId, reason || where, this.homey);
      };

      ws.on('error', (error) => {
        onSocketFailure('error', error);
        this._scheduleReconnect(deviceId);
      });

      ws.on('close', (code, reason) => {
        onSocketFailure(`closed (${code})`, null, reason || 'connection_closed');
        const state = this.connectionState.get(deviceId);
        if (state) {
          this._scheduleReconnect(deviceId);
        } else {
          this.homey.log(`[Session] ${colorize(LOG_COLORS.INFO, `Connection ${deviceId} was manually closed, skipping reconnect`)}`);
        }
      });

      connectionTimeout = this.homey.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN && !this.websocketConnections.has(deviceId)) {
          try {
            ws.close(1000, 'Connection timeout');
          } catch (e) {
            // Ignore - connection may already be closed
          }
          emitDisconnected(this.eventEmitter, deviceId, 'connection_timeout', this.homey);
          reject(new Error('LR3 WebSocket connection timeout'));
        }
        connectionTimeout = null;
      }, this.timeout);
    });
  }

  /**
   * Closes WebSocket connection for a specific device.
   * Clears all associated timers and connection state to prevent memory leaks.
   * @param {string} deviceId - Device identifier
   */
  closeWebSocket(deviceId) {
    const ws = this.websocketConnections.get(deviceId);
    if (ws) {
      this.log(`[Session] ${colorize(LOG_COLORS.SYSTEM, `Closing WebSocket connection for device ${deviceId}`)}`);
      try {
        ws.close(1000, 'Device cleanup');
      } catch (e) {
        // Ignore - connection may already be closed
      }
      this.websocketConnections.delete(deviceId);
    }
    this._clearAllTimers(deviceId);
    this.connectionState.delete(deviceId);
  }

  /**
   * Closes all active WebSocket connections.
   * Clears all connection state, typically called during app shutdown.
   */
  closeAllWebSockets() {
    this.log(`[Session] ${colorize(LOG_COLORS.SYSTEM, 'Closing all WebSocket connections')}`);
    for (const [deviceId, ws] of this.websocketConnections) {
      try {
        ws.close(1000, 'App shutdown');
      } catch (e) {
        // Ignore - connection may already be closed
      }
      this._clearAllTimers(deviceId);
    }
    this.websocketConnections.clear();
    this.connectionState.clear();
  }

  /**
   * Returns the event emitter for WebSocket and data events.
   * @returns {EventEmitter} The event emitter instance
   */
  getEventEmitter() {
    return this.eventEmitter;
  }

  /**
   * Gets or creates connection state for a device.
   * Maintains per-device state for reconnection attempts and heartbeat tracking.
   * @param {string} deviceId - Device identifier
   * @param {Object} [defaults={}] - Default values for new state objects
   * @returns {Object} Connection state object
   * @private
   */
  _getOrCreateConnState(deviceId, defaults = {}) {
    const state = this.connectionState.get(deviceId) || { reconnectAttempts: 0, ...defaults };
    this.connectionState.set(deviceId, state);
    return state;
  }

  /**
   * Clears reconnect timer for a device.
   * @param {string} deviceId - Device identifier
   * @private
   */
  _clearReconnectTimer(deviceId) {
    const state = this.connectionState.get(deviceId);
    if (state?.reconnectTimer) {
      this.homey.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  /**
   * Clears heartbeat timer for a device.
   * @param {string} deviceId - Device identifier
   * @private
   */
  _clearHeartbeat(deviceId) {
    const state = this.connectionState.get(deviceId);
    if (state?.heartbeatTimer) {
      this.homey.clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  /**
   * Clears all timers for a device.
   * @param {string} deviceId - Device identifier
   * @private
   */
  _clearAllTimers(deviceId) {
    this._clearReconnectTimer(deviceId);
    this._clearHeartbeat(deviceId);
  }

  /**
   * Calculates exponential backoff delay with jitter.
   * Prevents synchronized reconnection attempts across multiple devices.
   * @param {number} attempt - Reconnection attempt number (0-based)
   * @returns {number} Delay in milliseconds
   * @private
   */
  _computeBackoffDelay(attempt) {
    const base = Math.min(30000, 1000 * (2 ** attempt));
    const jitter = Math.floor(Math.random() * 500);
    return base + jitter;
  }

  /**
   * Sets up heartbeat monitoring for WebSocket connection.
   * Detects stale connections by checking message activity and forces reconnect if idle too long.
   * @param {string} deviceId - Device identifier
   * @param {WebSocket} ws - WebSocket connection
   * @param {number} [idleMs=90000] - Maximum idle time before forcing reconnect
   * @param {number} [checkEveryMs=45000] - Interval for checking connection activity
   * @private
   */
  _setupHeartbeat(deviceId, ws, idleMs = 90000, checkEveryMs = 45000) {
    const state = this._getOrCreateConnState(deviceId);
    state.lastMessageAt = Date.now();
    this._clearHeartbeat(deviceId);
    this.log(`[Session] ${colorize(LOG_COLORS.INFO, `Setting up heartbeat monitoring for device ${deviceId} (idle timeout: ${idleMs}ms, check interval: ${checkEveryMs}ms)`)}`);
    state.heartbeatTimer = this.homey.setInterval(() => {
      const currentWs = this.websocketConnections.get(deviceId);
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
        this._clearHeartbeat(deviceId);
        return;
      }
      const now = Date.now();
      const timeSinceLastMessage = now - (state.lastMessageAt || 0);
      if (timeSinceLastMessage > idleMs) {
        this.homey.log(`[Session] ${colorize(LOG_COLORS.WARNING, `Heartbeat stale for device ${deviceId} (${Math.round(timeSinceLastMessage / 1000)}s since last message), forcing reconnect`)}`);
        try {
          currentWs.close(1006, 'Heartbeat timeout');
        } catch (e) {
          try {
            currentWs.terminate();
          } catch (termErr) {
            // Ignore - connection may already be closed
          }
        }
      }
    }, checkEveryMs);
  }

  /**
   * Schedules WebSocket reconnection with exponential backoff.
   * Refreshes tokens before reconnecting to ensure valid authentication.
   * @param {string} deviceId - Device identifier
   * @private
   */
  async _scheduleReconnect(deviceId) {
    const state = this._getOrCreateConnState(deviceId);
    if (state.reconnectTimer) return;
    const delay = this._computeBackoffDelay(state.reconnectAttempts || 0);
    this.homey.log(`[Session] ${colorize(LOG_COLORS.WARNING, `Scheduling WebSocket reconnect for device ${deviceId} `
      + `in ${Math.round(delay / 1000)}s (attempt ${(state.reconnectAttempts || 0) + 1})`)}`);
    state.reconnectTimer = this.homey.setTimeout(async () => {
      state.reconnectTimer = null;
      state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
      try {
        if (!this.isSessionValid()) {
          await this.refreshSession();
        }
        await this.createWebSocket(deviceId, state.options || {});
      } catch (err) {
        this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `Reconnect attempt failed for device ${deviceId}:`)}`, err);
        this._scheduleReconnect(deviceId);
      }
    }, delay);
  }

  /**
   * Retrieves all Litter-Robot devices for the authenticated user.
   * Fetches LR4 and LR3 devices in parallel for efficiency.
   * @returns {Promise<Object>} Object with lr4, lr3, and all arrays of robot data
   * @throws {WhiskerTokenException} If user ID cannot be extracted from token
   */
  async getRobots() {
    const userId = this.getUserId();
    if (!userId) {
      throw new WhiskerTokenException('Unable to get user ID from token');
    }

    const [lr4Robots, lr3Robots] = await Promise.all([
      this._getLR4Robots(userId),
      this._getLR3Robots(userId),
    ]);

    this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS,
      `Found ${lr4Robots.length} LR4 and ${lr3Robots.length} LR3 robots`)}`);

    return {
      lr4: lr4Robots,
      lr3: lr3Robots,
      all: [...lr4Robots, ...lr3Robots],
    };
  }

  /**
   * Fetches LR4 devices for a user via GraphQL.
   * Adds robotType field for consistent handling across robot types.
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of LR4 robot objects
   * @private
   */
  async _getLR4Robots(userId) {
    const response = await this.lr4Graphql(`
      query GetLR4($userId: String!) {
        getLitterRobot4ByUser(userId: $userId) {
          id: unitId, serial: serial, nickname: name, status: robotStatus, 
          lastSeen, hopperStatus, isHopperRemoved
        }
      }
    `, { userId });

    if (!response?.data?.getLitterRobot4ByUser) {
      return [];
    }
    return response.data.getLitterRobot4ByUser.map((robot) => ({
      ...robot,
      robotType: 'LR4',
    }));
  }

  /**
   * Fetches LR3 devices for a user via REST API.
   * Adds robotType field for consistent handling across robot types.
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of LR3 robot objects
   * @private
   */
  async _getLR3Robots(userId) {
    const endpoint = `${ENDPOINTS.LR3}/users/${userId}/robots`;

    return retryWithBackoff(async (attempt = 0) => {
      const authHeaders = await this.getAuthHeaders('LR3');

      const response = await fetch(endpoint, {
        method: 'GET',
        headers: authHeaders,
        timeout: this.timeout,
      });

      if (!response.ok) {
        if (response.status === 401 && attempt === 0) {
          const retryError = new Error('Token refresh required, retrying request');
          retryError.isRetryTrigger = true;
          throw retryError;
        }
        throw new WhiskerApiException(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      }

      const robots = await response.json();
      return robots.map((robot) => ({
        ...robot,
        robotType: 'LR3',
      }));
    }, 3, 1000);
  }

  /**
   * Retrieves a specific robot by ID or serial number.
   * @param {string} robotId - Robot ID or serial number
   * @returns {Promise<Object>} Robot data object
   * @throws {Error} If robot is not found
   */
  async getRobot(robotId) {
    const robotsData = await this.getRobots();
    const robot = robotsData.all.find((r) => r.id === robotId || r.serial === robotId);
    if (!robot) {
      throw new Error(`Robot with id or serial "${robotId}" not found`);
    }
    this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `Fetched robot: ${robot.name || robot.serial}`)}`);
    return robot;
  }

  /**
   * Retrieves all pets for the authenticated user.
   * @returns {Promise<Array>} Array of pet objects
   * @throws {WhiskerTokenException} If user ID cannot be extracted from token
   */
  async getPets() {
    const userId = this.getUserId();
    if (!userId) {
      throw new WhiskerTokenException('Unable to get user ID from token');
    }

    const response = await this.petGraphql(`
      query GetPetsByUser($userId: String!) {
        getPetsByUser(userId: $userId) {
          petId, userId, createdAt, name, type, gender, weight, weightLastUpdated,
          lastWeightReading, breeds, age, birthday, adoptionDate, s3ImageURL, diet,
          isFixed, environmentType, healthConcerns, isActive, whiskerProducts,
          weightIdFeatureEnabled, zodiacSign, petTagAssigned {
            requested, success, error, petTag {
              petTagId, userId, petId, batteryLevel, createdAt, updatedAt
            }
          }
        }
      }
    `, { userId });

    const pets = response.data?.getPetsByUser || [];
    this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `Fetched ${pets.length} pets`)}`);
    return pets;
  }

  /**
   * Retrieves a specific pet by ID.
   * @param {string} petId - Pet ID
   * @returns {Promise<Object>} Pet data object
   * @throws {Error} If pet is not found
   */
  async getPet(petId) {
    const pets = await this.getPets();
    const pet = pets.find((p) => p.petId === petId);
    if (!pet) {
      throw new Error(`Pet with id "${petId}" not found`);
    }
    this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `Fetched pet: ${pet.name || pet.petId}`)}`);
    return pet;
  }

  /**
   * Sends command to robot via appropriate API endpoint.
   * Routes to device-specific implementation based on robot type.
   * @param {string} robotSerial - Robot serial number
   * @param {string} command - Command to send
   * @param {Object|string} [payload=null] - Optional payload data
   * @param {string} [robotType='litter_robot_4'] - Robot type ('litter_robot_3' or 'litter_robot_4')
   * @param {string} [robotId=null] - Robot ID (required for LR3 commands)
   * @returns {Promise<Object>} Command response
   * @throws {Error} If robotSerial or command is missing
   */
  async sendCommand(robotSerial, command, payload = null, robotType = 'litter_robot_4', robotId = null) {
    if (!robotSerial) {
      throw new Error('Robot serial is required');
    }
    if (!command) {
      throw new Error('Command is required');
    }

    this.log(`[Session] ${colorize(LOG_COLORS.COMMAND, `Sending ${robotType} command: ${command}${payload ? ' with payload' : ''}`)}`);

    const commandHandlers = {
      litter_robot_3: (serial, cmd, pld, id) => this._sendLR3Command(serial, cmd, pld, id),
      litter_robot_4: (serial, cmd, pld) => this._sendLR4Command(serial, cmd, pld),
    };

    const handler = commandHandlers[robotType] || commandHandlers.litter_robot_4;
    return handler(robotSerial, command, payload, robotId);
  }

  /**
   * Sends command to LR4 device via GraphQL mutation.
   * Serializes payload to string format required by GraphQL API.
   * @param {string} robotSerial - Robot serial number
   * @param {string} command - Command to send
   * @param {Object|string} payload - Optional payload data
   * @returns {Promise<Object>} GraphQL response
   * @private
   */
  async _sendLR4Command(robotSerial, command, payload) {
    let value = null;
    if (payload) {
      value = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    }

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
        value,
      });

      this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `Successfully sent LR4 command: ${command}`)}`);
      return response;
    } catch (err) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `Failed to send LR4 command ${command}:`)}`, err);
      throw err;
    }
  }

  /**
   * Updates LR4 robot state via GraphQL mutation.
   * Used for settings like night light brightness, sleep mode, etc.
   * @param {string} serial - Robot serial number
   * @param {Object} stateUpdate - State update object (e.g., { nightLightBrightness: 50 })
   * @param {string} [unitId] - Optional unit ID for the robot
   * @param {string} [userId] - Optional user ID for the robot
   * @returns {Promise<Object>} GraphQL response
   * @throws {Error} If serial or stateUpdate is missing or invalid
   */
  async updateLR4State(serial, stateUpdate, unitId = null, userId = null) {
    if (!serial) {
      throw new Error('Robot serial is required');
    }
    if (!stateUpdate || typeof stateUpdate !== 'object') {
      throw new Error('State update object is required');
    }

    const query = `
      mutation litterRobot4StateUpdate($input: LR4LitterRobot4StateUpdateInput!) {
        litterRobot4StateUpdate(input: $input) {
          serial
          nightLightBrightness
        }
      }
    `;

    const input = {
      serial,
      ...stateUpdate,
    };

    if (unitId) {
      input.unitId = unitId;
    }

    if (userId) {
      input.userId = userId;
    }

    const variables = {
      input,
    };

    try {
      this.log(`[Session] ${colorize(LOG_COLORS.COMMAND, `Updating LR4 state for ${serial} with: ${JSON.stringify(stateUpdate)}`)}`);
      const response = await this.lr4Graphql(query, variables);

      if (response.data && response.data.litterRobot4StateUpdate) {
        this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `Successfully updated LR4 state for ${serial}`)}`);
      } else if (response.errors) {
        this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, 'GraphQL errors updating LR4 state:')}`, response.errors);
        throw new Error(`GraphQL errors: ${JSON.stringify(response.errors)}`);
      }

      return response;
    } catch (err) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `Failed to update LR4 state for ${serial}:`)}`, err);
      throw err;
    }
  }

  /**
   * Sends command to LR3 device via REST API.
   * Prefixes command with '<' character as required by LR3 API.
   * @param {string} robotSerial - Robot serial number
   * @param {string} command - Command to send
   * @param {Object|string} payload - Payload (not used for LR3, kept for interface consistency)
   * @param {string} robotId - Robot ID (required for LR3)
   * @returns {Promise<Object>} Command response
   * @throws {Error} If userId or robotId is missing
   * @private
   */
  async _sendLR3Command(robotSerial, command, payload, robotId) {
    try {
      const userId = this.getUserId();
      if (!userId) {
        throw new Error('Unable to get user ID from token');
      }

      if (!robotId) {
        throw new Error('Robot ID is required for LR3 commands');
      }

      const endpoint = `${ENDPOINTS.LR3}/users/${userId}/robots/${robotId}/dispatch-commands`;

      const commandWithPrefix = `<${command}`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: await this.getAuthHeaders('LR3'),
        body: JSON.stringify({ command: commandWithPrefix }),
        timeout: this.timeout,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this.log(`[Session] ${colorize(LOG_COLORS.SUCCESS, `Successfully sent LR3 command: ${command}`)}`);
      return { success: true };
    } catch (err) {
      this.homey.error(`[Session] ${colorize(LOG_COLORS.ERROR, `Failed to send LR3 command ${command}:`)}`, err);
      throw err;
    }
  }

  /**
   * Updates LR3 robot settings via PATCH request.
   * Used for settings like sleep mode, night light, and other configuration changes.
   * @param {string} robotId - Robot ID
   * @param {Object} payload - JSON payload with settings to update
   * @returns {Promise<Object>} API response
   * @throws {Error} If userId cannot be extracted from token
   * @throws {WhiskerApiException} If API request fails
   */
  async patchLR3Robot(robotId, payload) {
    const userId = this.getUserId();
    if (!userId) {
      throw new Error('Unable to get user ID from token');
    }

    const endpoint = `${ENDPOINTS.LR3}/users/${userId}/robots/${robotId}`;

    const response = await fetch(endpoint, {
      method: 'PATCH',
      headers: await this.getAuthHeaders('LR3'),
      body: JSON.stringify(payload),
      timeout: this.timeout,
    });

    if (!response.ok) {
      throw new WhiskerApiException(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
      );
    }

    return response.json();
  }
}

Session.ENDPOINTS = ENDPOINTS;

module.exports = Session;
