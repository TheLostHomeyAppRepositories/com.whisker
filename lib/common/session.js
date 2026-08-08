const {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoIdToken,
  CognitoAccessToken,
  CognitoRefreshToken,
} = require('amazon-cognito-identity-js');
const {
  retryWithBackoff, extractGraphQLOperationName, safeStringify,
  decodeJwt, getUnixTimestamp, getTokenExpirationInfo, TOKEN_CONFIG,
} = require('./utils');
const {
  WhiskerApiException, WhiskerTokenException, WhiskerAuthenticationException, WhiskerLoginException,
  WhiskerNetworkException,
} = require('./exceptions');
const { applyWebSocketMethods } = require('./websocket');

/**
 * @module session
 * @description Unified session management for Whisker services: AWS Cognito authentication,
 * token refresh, HTTP transport, and WebSocket connections. Device APIs live under `lib/lr3`,
 * `lib/lr4`, and `lib/pet`. Shared infrastructure lives under `lib/common`.
 */

const DEFAULT_USER_POOL_ID = 'us-east-1_rjhNnZVAm';
const DEFAULT_CLIENT_ID = '4552ujeu3aic90nf8qn53levmn';

const AUTH_CONFIG_BY_API_TYPE = {
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
  Pet: {
    tokenKey: 'access_token',
    additionalHeaders: {},
  },
};

/**
 * Unified session manager for Whisker services.
 * Handles AWS Cognito authentication, token lifecycle, API requests, and WebSocket connections.
 * WebSocket robot updates are routed to per-device handlers via {@link Session#subscribeToDevice}.
 * @class
 */
class Session {
  /**
   * Creates a new Session instance.
   * @param {Object} options - Configuration options
   * @param {string} [options.username] - Username for authentication (required if tokens not provided)
   * @param {string} [options.password] - Password for authentication (required if tokens not provided)
   * @param {Object} [options.tokens] - Existing tokens to restore session (required if credentials not provided)
   * @param {Function} [options.onTokensRefreshed] - Callback invoked when tokens are refreshed
   * @param {Function} [options.onTokensCleared] - Callback invoked when persisted tokens should be cleared
   * @param {boolean} [options.persistTokens=true] - When false, login/signOut skip shared token storage (temporary sessions)
   * @param {Object} options.homey - Homey instance (required)
   * @throws {Error} If homey instance is missing
   * @throws {WhiskerAuthenticationException} If neither tokens nor credentials are provided
   */
  constructor({
    username, password, tokens = null, onTokensRefreshed = null, onTokensCleared = null,
    homey, persistTokens = true,
  }) {
    if (!homey) {
      throw new Error('Homey instance is required');
    }

    this.homey = homey;
    this._logUtilErr = homey.error.bind(homey);
    this.persistTokens = persistTokens;
    this._dataSubscribers = new Map();
    this.websocketConnections = new Map();
    this.connectionState = new Map();
    this.timeout = 30000;

    const userPoolId = process.env.COGNITO_USER_POOL_ID || DEFAULT_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID || DEFAULT_CLIENT_ID;
    this.userPool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });

    this.homey.log('[Session] Initializing session manager');

    this.onTokensRefreshed = onTokensRefreshed;
    this.onTokensCleared = onTokensCleared;
    this._refreshing = false;
    this._refreshPromise = null;

    if (tokens) {
      this._initializeWithTokens(tokens);
    } else if (username && password) {
      this._initializeWithCredentials(username, password);
    } else {
      this.homey.error('[Session] Invalid initialization - missing required credentials');
      throw new WhiskerAuthenticationException('Either tokens or username and password must be provided');
    }
  }

  /**
   * Restores session from existing tokens.
   * @param {Object} tokens
   * @private
   */
  _initializeWithTokens(tokens) {
    this.homey.log('[Session] Restoring session from existing tokens');
    const { id_token, access_token, refresh_token } = tokens;
    if (!id_token || !access_token || !refresh_token) {
      this.homey.error('[Session] Invalid tokens provided - missing required components');
      throw new WhiskerTokenException('Tokens must include id_token, access_token, and refresh_token');
    }
    const decoded = decodeJwt(id_token);
    const email = decoded?.email || decoded?.username || decoded?.['cognito:username'];
    if (!email) {
      this.homey.error('[Session] Cannot extract username from provided id_token');
      throw new WhiskerTokenException('Cannot extract username/email from provided id_token');
    }
    this.cognitoUser = new CognitoUser({ Username: email, Pool: this.userPool });
    this.session = null;
    this.setSession({ id_token, access_token, refresh_token });
    this.homey.log(`[Session] Session restored successfully for user ${email}`);
  }

  /**
   * Prepares session for fresh authentication.
   * @param {string} username
   * @param {string} password
   * @private
   */
  _initializeWithCredentials(username, password) {
    this.homey.log(`[Session] Initializing for fresh authentication with username ${username}`);
    this.username = username;
    this.password = password;
    this.cognitoUser = new CognitoUser({ Username: username, Pool: this.userPool });
    this.session = null;
  }

  /**
   * Updates session with new tokens.
   * @param {Object} tokens
   */
  setSession(tokens) {
    const { id_token, access_token, refresh_token } = tokens;
    this.session = new CognitoUserSession({
      IdToken: new CognitoIdToken({ IdToken: id_token }),
      AccessToken: new CognitoAccessToken({ AccessToken: access_token }),
      RefreshToken: new CognitoRefreshToken({ RefreshToken: refresh_token }),
    });
    this.cognitoUser.setSignInUserSession(this.session);
    this._logTokenExpiry(tokens);
  }

  /**
   * @private
   */
  _assertUser() {
    if (!this.cognitoUser) {
      this.homey.error('[Session] Operation failed - CognitoUser is not initialized');
      throw new WhiskerAuthenticationException('CognitoUser is not initialized');
    }
  }

  /**
   * @param {Object} tokens
   * @param {string} [labelPrefix='']
   * @private
   */
  _logTokenExpiry(tokens, labelPrefix = '') {
    const accessTokenInfo = getTokenExpirationInfo(tokens.access_token);
    const idTokenInfo = getTokenExpirationInfo(tokens.id_token);

    if (accessTokenInfo) {
      this.homey.log(`[Session] ${labelPrefix}Access token expires in ${accessTokenInfo.formattedTimeUntilExpiry} (${accessTokenInfo.expiresAt})`);
    }
    if (idTokenInfo) {
      this.homey.log(`[Session] ${labelPrefix}ID token expires in ${idTokenInfo.formattedTimeUntilExpiry} (${idTokenInfo.expiresAt})`);
    }
  }

  /**
   * @param {Object} [options]
   * @param {boolean} [options.logExpiry=false]
   * @param {string} [options.expiryLabelPrefix='']
   * @private
   */
  _persistTokens({ logExpiry = false, expiryLabelPrefix = '' } = {}) {
    const tokens = this.getTokens();
    if (!tokens || !this.persistTokens) return;
    if (this.onTokensRefreshed) {
      this.onTokensRefreshed(tokens);
    }
    if (logExpiry) {
      this._logTokenExpiry(tokens, expiryLabelPrefix);
    }
  }

  /**
   * Authenticates user with AWS Cognito.
   * @returns {Promise<CognitoUserSession>}
   */
  async login() {
    this.homey.log(`[Session] Authenticating user ${this.username}`);
    if (!this.username || !this.password) {
      this.homey.error('[Session] Login failed - missing username or password');
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
          this.homey.log(`[Session] Authentication successful for user ${this.username}`);
          this._persistTokens();
          resolve(session);
        },
        onFailure: (err) => {
          this.homey.log(`[Session] Authentication failed for user ${this.username}:`, err);
          reject(new WhiskerLoginException(err.message || 'Authentication failed', err));
        },
        newPasswordRequired: () => {
          this.homey.error(`[Session] New password required for user ${this.username}`);
          reject(new WhiskerLoginException('New password required'));
        },
        mfaRequired: () => {
          this.homey.error(`[Session] MFA required for user ${this.username}`);
          reject(new WhiskerLoginException('MFA required'));
        },
        totpRequired: () => {
          this.homey.error(`[Session] TOTP required for user ${this.username}`);
          reject(new WhiskerLoginException('TOTP required'));
        },
        customChallenge: () => {
          this.homey.error(`[Session] Custom challenge required for user ${this.username}`);
          reject(new WhiskerLoginException('Custom challenge required'));
        },
      });
    });
  }

  /**
   * @returns {boolean}
   */
  isSessionValid() {
    const idToken = this.getIdToken();
    if (!idToken) {
      this.homey.log('[Session] Session validation: failed - no ID token available');
      return false;
    }
    const decoded = decodeJwt(idToken);
    if (!decoded?.exp) {
      this.homey.log('[Session] Session validation: failed - no expiration in token');
      return false;
    }
    const now = getUnixTimestamp();
    const isValid = decoded.exp > now + TOKEN_CONFIG.EXPIRATION_BUFFER_SECONDS;

    if (!isValid) {
      this.homey.log(`[Session] Session validation: token expires in ${decoded.exp - now} seconds, refreshing proactively...`);
    }

    return isValid;
  }

  /** @returns {string|null} */
  getIdToken() {
    return this.session ? this.session.getIdToken().getJwtToken() : null;
  }

  /** @returns {string|null} */
  getUserId() {
    const idToken = this.getIdToken();
    const decoded = decodeJwt(idToken);
    return decoded?.mid || null;
  }

  /** @returns {string|null} */
  getAccessToken() {
    return this.session ? this.session.getAccessToken().getJwtToken() : null;
  }

  /** @returns {string|null} */
  getRefreshToken() {
    return this.session ? this.session.getRefreshToken().getToken() : null;
  }

  /**
   * Clears Cognito state and persisted tokens so repair can force a clean login.
   */
  signOut() {
    if (this.cognitoUser) {
      this.homey.log('[Session] Signing out user');
      this.cognitoUser.signOut();
      this.session = null;
      if (this.persistTokens && this.onTokensCleared) {
        this.onTokensCleared();
      }
      this.homey.log('[Session] User signed out successfully');
    }
  }

  /**
   * @returns {Promise<CognitoUserSession>}
   */
  async refreshSession() {
    this._assertUser();

    this.homey.log('[Session] Refreshing session tokens');

    if (!this.session) {
      this.homey.error('[Session] Session refresh failed - no session available');
      throw new WhiskerTokenException('No session available to refresh');
    }
    const refreshTokenObj = this.session.getRefreshToken();
    const refreshToken = refreshTokenObj.getToken();
    if (!refreshToken) {
      this.homey.error('[Session] Session refresh failed - missing refresh token');
      throw new WhiskerTokenException('Missing refresh token. Cannot refresh session.');
    }

    if (this._refreshing) {
      this.homey.log('[Session] Session refresh already in progress, returning existing promise');
      return this._refreshPromise;
    }
    this._refreshing = true;
    this._refreshPromise = new Promise((resolve, reject) => {
      this.cognitoUser.refreshSession(refreshTokenObj, (err, session) => {
        this._refreshing = false;
        this._refreshPromise = null;
        if (err) {
          this.homey.error('[Session] Session refresh failed:', err);
          const code = err.code || err.name;
          if (code === 'NotAuthorizedException' || code === 'UserNotFoundException') {
            this.signOut();
          }
          reject(err);
          return;
        }
        this.session = session;
        this.homey.log('[Session] Session tokens refreshed successfully');

        this._persistTokens({ logExpiry: true, expiryLabelPrefix: 'New ' });

        resolve(session);
      });
    });
    return this._refreshPromise;
  }

  /** @returns {Object|null} */
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
   * @param {string} apiType
   * @returns {Promise<Object>}
   */
  async getAuthHeaders(apiType) {
    if (!this.isSessionValid()) {
      await this.refreshSession();
    }

    const tokens = this.getTokens();
    const config = AUTH_CONFIG_BY_API_TYPE[apiType];
    if (!config) {
      throw new Error(`Unsupported API type: ${apiType}`);
    }
    const { tokenKey } = config;

    if (!tokens || !tokens[tokenKey]) {
      throw new WhiskerTokenException(`Missing ${tokenKey} for ${apiType} API`);
    }

    const appVersion = this.homey.manifest.version || '1.0.0';
    const platform = this.homey.cloud ? 'HomeyCloud' : 'HomeyPro';
    return {
      Authorization: `Bearer ${tokens[tokenKey]}`,
      'Content-Type': 'application/json',
      'User-Agent': `${platform}App/${appVersion}`,
      ...config.additionalHeaders,
    };
  }

  /**
   * Executes GraphQL request with automatic retry and token refresh.
   * @param {string} endpoint
   * @param {Object} data
   * @param {'LR4'|'Pet'} apiType
   * @returns {Promise<Object>}
   * @package — used by device API modules
   */
  async _makeGraphQLRequest(endpoint, data, apiType) {
    const requestData = {
      method: 'POST',
      body: safeStringify(data, 0, this._logUtilErr),
    };

    const operationName = extractGraphQLOperationName(data.query);
    this.homey.log(`[Session] GraphQL ${operationName} request sent to ${endpoint}`);

    return retryWithBackoff(async (attempt = 0) => {
      const authHeaders = await this.getAuthHeaders(apiType);
      requestData.headers = { ...authHeaders };

      if (attempt > 0) {
        this.homey.log(`[Session] GraphQL ${operationName} retry attempt ${attempt + 1} to ${endpoint}`);
      }

      let response;
      try {
        response = await fetch(endpoint, {
          ...requestData,
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (err) {
        const detail = err.cause?.message || err.cause?.code || err.code;
        const suffix = detail ? ` — ${detail}` : '';
        this.homey.error(`[Session] GraphQL ${operationName} transport failed for ${endpoint}: ${err.message}${suffix}`);
        throw new WhiskerNetworkException(err);
      }

      if (!response.ok) {
        const errorText = await response.text();
        this.homey.error(`[Session] GraphQL ${operationName} request failed: ${response.status} ${response.statusText}`);

        if (response.status === 401 && attempt === 0) {
          this.homey.log('[Session] Received 401 Unauthorized, forcing token refresh...');
          throw new Error('Token refresh required, retrying request');
        }

        throw new WhiskerApiException(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          new Error(errorText),
        );
      }

      const responseData = await response.json();
      this.homey.log(`[Session] GraphQL ${operationName} response received from ${endpoint} (${response.status})`);

      if (responseData.errors && responseData.errors.length > 0) {
        this.homey.error(`[Session] GraphQL errors for ${operationName}:`, responseData.errors);
      }

      return responseData;
    }, 3, 1000);
  }

  /**
   * Executes LR3 REST request with automatic retry and token refresh on 401.
   * @param {string} method
   * @param {string} endpoint
   * @param {Object} [options={}]
   * @returns {Promise<Object|undefined>}
   * @package — used by device API modules
   */
  async _makeRestRequest(method, endpoint, { body, label, parseJson = true } = {}) {
    const logLabel = label || `${method} ${endpoint}`;

    return retryWithBackoff(async (attempt = 0) => {
      const requestData = {
        method,
        headers: await this.getAuthHeaders('LR3'),
      };

      if (body !== undefined) {
        requestData.body = safeStringify(body, 0, this._logUtilErr);
      }

      if (attempt === 0) {
        this.homey.log(`[Session] REST ${logLabel} request sent to ${endpoint}`);
      } else {
        this.homey.log(`[Session] REST ${logLabel} retry attempt ${attempt + 1} to ${endpoint}`);
      }

      let response;
      try {
        response = await fetch(endpoint, {
          ...requestData,
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (err) {
        const detail = err.cause?.message || err.cause?.code || err.code;
        const suffix = detail ? ` — ${detail}` : '';
        this.homey.error(`[Session] REST ${logLabel} transport failed for ${endpoint}: ${err.message}${suffix}`);
        throw new WhiskerNetworkException(err);
      }

      if (!response.ok) {
        this.homey.error(`[Session] REST ${logLabel} request failed: ${response.status} ${response.statusText}`);

        if (response.status === 401 && attempt === 0) {
          this.homey.log('[Session] Received 401 Unauthorized, forcing token refresh...');
          throw new Error('Token refresh required, retrying request');
        }

        throw new WhiskerApiException(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status,
        );
      }

      this.homey.log(`[Session] REST ${logLabel} response received from ${endpoint} (${response.status})`);

      if (!parseJson) {
        return undefined;
      }

      return response.json();
    }, 3, 1000);
  }

  /**
   * Registers a handler for WebSocket robot updates for a device serial.
   * @param {string} serial
   * @param {(robot: Object) => void} handler
   */
  subscribeToDevice(serial, handler) {
    this._dataSubscribers.set(serial, handler);
  }

  /**
   * Removes the WebSocket robot update handler for a device serial.
   * @param {string} serial
   */
  unsubscribeFromDevice(serial) {
    this._dataSubscribers.delete(serial);
  }

  /**
   * Routes a WebSocket robot payload to the subscriber for the given serial.
   * @param {string} serial
   * @param {Object} robot
   * @private
   */
  _dispatchData(serial, robot) {
    this._dataSubscribers.get(serial)?.(robot);
  }
}

applyWebSocketMethods(Session);

module.exports = Session;
