'use strict';

const {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoIdToken,
  CognitoAccessToken,
  CognitoRefreshToken,
} = require('amazon-cognito-identity-js');
const { decodeJwt, getUnixTimestamp, decodeBase64, colorize, LOG_COLORS, getTokenExpirationInfo, TOKEN_CONFIG } = require('./utils');
const { 
  WhiskerAuthenticationException, 
  WhiskerLoginException, 
  WhiskerTokenException 
} = require('./exceptions');
const TokenStore = require('./tokenstore');

// Polyfill fetch for Node.js environments where it's not globally available (Homey Cloud and Homey 2016-2019)
if (typeof global.fetch !== 'function') {
  global.fetch = require('node-fetch');
}

// Default Cognito configuration values (base64 encoded to prevent accidental exposure)
const DEFAULT_USER_POOL_ID = decodeBase64('dXMtZWFzdC0xX3JqaE5uWlZBbQ==');
const DEFAULT_CLIENT_ID    = decodeBase64('NDU1MnVqZXUzYWljOTBuZjhxbjUzbGV2bW4=');

/**
 * Manages AWS Cognito authentication sessions for Whisker API access.
 * Handles token refresh, session validation, and secure credential storage.
 */
class CognitoSession {
  constructor({ username, password, tokens = null, onTokensRefreshed = null, homey = null }) {
    this.homey = homey;
    this.log = homey ? homey.log : console.log;
    this.tokenStore = new TokenStore(homey);

    const userPoolId = process.env.COGNITO_USER_POOL_ID || DEFAULT_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID || DEFAULT_CLIENT_ID;
    this.userPool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });

    this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, 'Initializing Cognito session manager')}`);

    this.onTokensRefreshed = onTokensRefreshed;
    this._refreshing = false;
    this._refreshPromise = null;

    if (tokens) {
      this._initializeWithTokens(tokens);
    } else if (username && password) {
      this._initializeWithCredentials(username, password);
    } else {
      this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, 'Invalid initialization - missing required credentials')}`);
      throw new WhiskerAuthenticationException('Either tokens or username and password must be provided');
    }
  }

  /**
   * Restores a session using existing tokens from storage or previous authentication.
   * Validates token completeness and extracts user identity from the ID token.
   */
  _initializeWithTokens(tokens) {
    this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, 'Restoring session from existing tokens')}`);
    const { id_token, access_token, refresh_token } = tokens;
    if (!id_token || !access_token || !refresh_token) {
      this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, 'Invalid tokens provided - missing required components')}`);
      throw new WhiskerTokenException('Tokens must include id_token, access_token, and refresh_token');
    }
    const decoded = decodeJwt(id_token);
    const email = decoded?.email || decoded?.username || decoded?.['cognito:username'];
    if (!email) {
      this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, 'Cannot extract username from provided id_token')}`);
      throw new WhiskerTokenException('Cannot extract username/email from provided id_token');
    }
    this.cognitoUser = new CognitoUser({ Username: email, Pool: this.userPool });
    this.session = null;
    this.setSession({ id_token, access_token, refresh_token });
    this.log(`[CognitoSession] ${colorize(LOG_COLORS.SUCCESS, `Session restored successfully for user ${email}`)}`);
  }

  /**
   * Prepares for fresh authentication using username and password credentials.
   * Sets up the CognitoUser instance for subsequent login attempts.
   */
  _initializeWithCredentials(username, password) {
    this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, `Initializing for fresh authentication with username ${username}`)}`);
    this.username = username;
    this.password = password;
    this.cognitoUser = new CognitoUser({ Username: username, Pool: this.userPool });
    this.session = null;
  }

  /**
   * Creates a new CognitoUserSession from provided tokens and logs expiration information.
   * Updates the internal session state and notifies the CognitoUser instance.
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
      const accessTokenInfo = getTokenExpirationInfo(access_token, this.homey);
      const idTokenInfo = getTokenExpirationInfo(id_token, this.homey);
      
      if (accessTokenInfo) {
        this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, `Access token expires in ${accessTokenInfo.formattedTimeUntilExpiry} (${accessTokenInfo.expiresAt})`)}`);
      }
      
      if (idTokenInfo) {
        this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, `ID token expires in ${idTokenInfo.formattedTimeUntilExpiry} (${idTokenInfo.expiresAt})`)}`);
      }
    }
  }

  /**
   * Validates that the CognitoUser instance is properly initialized before operations.
   * Throws an exception if the user context is missing.
   */
  _assertUser() {
    if (!this.cognitoUser) {
      this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, 'Operation failed - CognitoUser is not initialized')}`);
      throw new WhiskerAuthenticationException('CognitoUser is not initialized');
    }
  }

  /**
   * Authenticates the user with AWS Cognito using stored credentials.
   * Handles various authentication challenges and stores tokens upon success.
   */
  async login() {
    this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, `Authenticating user ${this.username}`)}`);
    if (!this.username || !this.password) {
      this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, 'Login failed - missing username or password')}`);
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
          this.log(`[CognitoSession] ${colorize(LOG_COLORS.SUCCESS, `Authentication successful for user ${this.username}`)}`);
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
          this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, `Authentication failed for user ${this.username}:`)}`, err);
          reject(new WhiskerLoginException(`Authentication failed: ${err.message || err}`, err));
        },
        newPasswordRequired: () => {
          this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, `New password required for user ${this.username}`)}`);
          reject(new WhiskerLoginException('New password required'));
        },
        mfaRequired: () => {
          this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, `MFA required for user ${this.username}`)}`);
          reject(new WhiskerLoginException('MFA required'));
        },
        totpRequired: () => {
          this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, `TOTP required for user ${this.username}`)}`);
          reject(new WhiskerLoginException('TOTP required'));
        },
        customChallenge: () => {
          this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, `Custom challenge required for user ${this.username}`)}`);
          reject(new WhiskerLoginException('Custom challenge required'));
        },
      });
    });
  }

  /**
   * Checks if the current session is valid by verifying token expiration.
   * Uses a buffer period to proactively refresh tokens before they expire.
   */
  isSessionValid() {
    const idToken = this.getIdToken();
    if (!idToken) {
      this.log(`[CognitoSession] ${colorize(LOG_COLORS.WARNING, 'Session validation: failed - no ID token available')}`);
      return false;
    }
    const decoded = decodeJwt(idToken);
    if (!decoded?.exp) {
      this.log(`[CognitoSession] ${colorize(LOG_COLORS.WARNING, 'Session validation: failed - no expiration in token')}`);
      return false;
    }
    const now = getUnixTimestamp();
    const isValid = decoded.exp > now + TOKEN_CONFIG.EXPIRATION_BUFFER_SECONDS;
    
    if (this.homey && !isValid) {
      this.log(`[CognitoSession] ${colorize(LOG_COLORS.WARNING, `Session validation: token expires in ${decoded.exp - now} seconds, refreshing proactively...`)}`);
    }
    
    return isValid;
  }

  getIdToken() {
    return this.session ? this.session.getIdToken().getJwtToken() : null;
  }

  getUserId() {
    const idToken = this.getIdToken();
    const decoded = decodeJwt(idToken);
    return decoded?.mid || null;
  }

  getAccessToken() {
    return this.session ? this.session.getAccessToken().getJwtToken() : null;
  }

  getRefreshToken() {
    return this.session ? this.session.getRefreshToken().getToken() : null;
  }

  /**
   * Signs out the user and clears all stored tokens and session data.
   * Ensures complete cleanup of authentication state.
   */
  signOut() {
    if (this.cognitoUser) {
      this.log(`[CognitoSession] ${colorize(LOG_COLORS.SYSTEM, 'Signing out user')}`);
      this.cognitoUser.signOut();
      this.session = null;
      this.tokenStore.clearTokens();
      this.log(`[CognitoSession] ${colorize(LOG_COLORS.SUCCESS, 'User signed out successfully')}`);
    }
  }

  /**
   * Refreshes the session tokens using the refresh token.
   * Prevents concurrent refresh operations and handles token storage updates.
   */
  async refreshSession() {
    this._assertUser();
    
    this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, 'Refreshing session tokens')}`);
    
    if (!this.session) {
      this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, 'Session refresh failed - no session available')}`);
      throw new WhiskerTokenException('No session available to refresh');
    }
    const refreshTokenObj = this.session.getRefreshToken();
    const refreshToken = refreshTokenObj?.getToken();
    if (!refreshToken) {
      this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, 'Session refresh failed - missing refresh token')}`);
      throw new WhiskerTokenException('Missing refresh token. Cannot refresh session.');
    }

    if (this._refreshing) {
      this.log(`[CognitoSession] ${colorize(LOG_COLORS.WARNING, 'Session refresh already in progress, returning existing promise')}`);
      return this._refreshPromise;
    }
    this._refreshing = true;
    this._refreshPromise = new Promise((resolve, reject) => {
      this.cognitoUser.refreshSession(refreshTokenObj, (err, session) => {
        this._refreshing = false;
        this._refreshPromise = null;
        if (err) {
          this.homey.error(`[CognitoSession] ${colorize(LOG_COLORS.ERROR, 'Session refresh failed:')}`, err);
          this.signOut();
          return reject(err);
        }
        this.session = session;
        this.log(`[CognitoSession] ${colorize(LOG_COLORS.SUCCESS, 'Session tokens refreshed successfully')}`);
        
        const tokens = this.getTokens();
        if (tokens) {
          this.tokenStore.setTokens(tokens);
          if (this.onTokensRefreshed) {
            this.onTokensRefreshed(tokens);
          }
          if (this.homey) {
            const accessTokenInfo = getTokenExpirationInfo(tokens.access_token, this.homey);
            const idTokenInfo = getTokenExpirationInfo(tokens.id_token, this.homey);
            
            if (accessTokenInfo) {
              this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, `New access token expires in ${accessTokenInfo.formattedTimeUntilExpiry} (${accessTokenInfo.expiresAt})`)}`);
            }
            
            if (idTokenInfo) {
              this.log(`[CognitoSession] ${colorize(LOG_COLORS.INFO, `New ID token expires in ${idTokenInfo.formattedTimeUntilExpiry} (${idTokenInfo.expiresAt})`)}`);
            }
          }
        }
        
        resolve(session);
      });
    });
    return this._refreshPromise;
  }

  /**
   * Returns the current session tokens in a standardized format.
   * Returns null if no active session exists.
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
}

module.exports = CognitoSession;
