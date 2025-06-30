'use strict';

/**
 * CognitoSession manages AWS Cognito user authentication, session storage, and token refresh logic.
 * This is the centralized authentication component for the new Whisker app architecture.
 * 
 * Usage: Provide either username/password or valid tokens object ({ id_token, access_token, refresh_token }).
 */

const {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoIdToken,
  CognitoAccessToken,
  CognitoRefreshToken,
} = require('amazon-cognito-identity-js');
const jwt = require('jsonwebtoken');

// Polyfill fetch for Node.js (only if not available)
if (typeof global.fetch !== 'function') {
  global.fetch = require('node-fetch');
}

// Default Cognito configuration (decoded only once)
const DEFAULT_USER_POOL_ID = Buffer.from('dXMtZWFzdC0xX3JqaE5uWlZBbQ==', 'base64').toString('utf-8');
const DEFAULT_CLIENT_ID    = Buffer.from('NDU1MnVqZXUzYWljOTBuZjhxbjUzbGV2bW4=', 'base64').toString('utf-8');

class CognitoSession {
  /**
   * @param {object} options
   * @param {string} [options.username] - Cognito username/email
   * @param {string} [options.password] - Password for authentication
   * @param {object} [options.tokens] - Existing tokens { id_token, access_token, refresh_token }
   * @param {function} [options.onTokensRefreshed] - Callback when tokens are refreshed
   */
  constructor({ username, password, tokens = null, onTokensRefreshed = null }) {
    // Determine Cognito pool data
    const userPoolId = process.env.COGNITO_USER_POOL_ID || DEFAULT_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID || DEFAULT_CLIENT_ID;
    this.userPool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });

    // Store callback for token refresh notifications
    this.onTokensRefreshed = onTokensRefreshed;

    // If tokens provided, initialize session from tokens
    if (tokens) {
      // Validate tokens shape
      const { id_token, access_token, refresh_token } = tokens;
      if (!id_token || !access_token || !refresh_token) {
        throw new Error('Tokens must include id_token, access_token, and refresh_token');
      }
      // Decode id_token to get username/email for CognitoUser initialization
      const decoded = this._decodeJwt(id_token);
      const email = decoded?.email || decoded?.username || decoded?.['cognito:username'];
      if (!email) {
        throw new Error('Cannot extract username/email from provided id_token');
      }
      this.cognitoUser = new CognitoUser({ Username: email, Pool: this.userPool });
      this.session = null;
      this.setSession({ id_token, access_token, refresh_token });
    }
    // Else, require username/password
    else if (username && password) {
      this.username = username;
      this.password = password;
      this.cognitoUser = new CognitoUser({ Username: username, Pool: this.userPool });
      this.session = null;
    }
    else {
      throw new Error('Either tokens or username and password must be provided');
    }

    this._refreshing = false;
    this._refreshPromise = null;
  }

  /**
   * Initialize session from tokens.
   * @param {object} tokens
   */
  setSession(tokens) {
    const { id_token, access_token, refresh_token } = tokens;
    // Create CognitoUserSession from tokens
    this.session = new CognitoUserSession({
      IdToken: new CognitoIdToken({ IdToken: id_token }),
      AccessToken: new CognitoAccessToken({ AccessToken: access_token }),
      RefreshToken: new CognitoRefreshToken({ RefreshToken: refresh_token }),
    });
    // Attach session to cognitoUser instance
    if (this.cognitoUser) {
      this.cognitoUser.setSignInUserSession(this.session);
    }
  }

  /** Ensure cognitoUser is set before operations */
  _assertUser() {
    if (!this.cognitoUser) {
      throw new Error('CognitoUser is not initialized');
    }
  }

  /** Decode a JWT without verifying signature (returns payload or null) */
  _decodeJwt(token) {
    try {
      if (!token) return null;
      return jwt.decode(token) || null;
    } catch (err) {
      console.warn('Failed to decode JWT:', err);
      return null;
    }
  }

  /**
   * Authenticate using username/password and obtain session.
   * @returns {Promise<CognitoUserSession>}
   */
  async login() {
    // Ensure we have credentials
    if (!this.username || !this.password) {
      throw new Error('Username and password are required to login');
    }
    this._assertUser();

    const authDetails = new AuthenticationDetails({
      Username: this.username,
      Password: this.password,
    });

    // Wrap callback-based authenticateUser in a promise
    return new Promise((resolve, reject) => {
      this.cognitoUser.authenticateUser(authDetails, {
        onSuccess: (session) => {
          this.session = session;
          resolve(session);
        },
        onFailure: (err) => reject(err),
        newPasswordRequired: () => reject(new Error('New password required')),
        mfaRequired: () => reject(new Error('MFA required')),
        totpRequired: () => reject(new Error('TOTP required')),
        customChallenge: () => reject(new Error('Custom challenge required')),
      });
    });
  }

  /** Check if current session is valid (ID token expires in >30s) */
  isSessionValid() {
    const idToken = this.getIdToken();
    if (!idToken) return false;
    const decoded = this._decodeJwt(idToken);
    if (!decoded?.exp) return false;
    const now = Math.floor(Date.now() / 1000);
    return decoded.exp > now + 30;
  }

  /** Get current ID token string */
  getIdToken() {
    return this.session ? this.session.getIdToken().getJwtToken() : null;
  }

  /** Extract 'mid' claim (user ID) from ID token */
  getUserId() {
    const idToken = this.getIdToken();
    const decoded = this._decodeJwt(idToken);
    return decoded?.mid || null;
  }

  /** Get current access token string */
  getAccessToken() {
    return this.session ? this.session.getAccessToken().getJwtToken() : null;
  }

  /** Get current refresh token string */
  getRefreshToken() {
    return this.session ? this.session.getRefreshToken().getToken() : null;
  }

  /** Sign out and clear session */
  signOut() {
    if (this.cognitoUser) {
      this.cognitoUser.signOut();
      this.session = null;
    }
  }

  /**
   * Refresh the Cognito session using refresh token.
   * @returns {Promise<CognitoUserSession>}
   */
  async refreshSession() {
    this._assertUser();
    // Ensure existing session is available
    if (!this.session) {
      throw new Error('No session available to refresh');
    }
    const refreshTokenObj = this.session.getRefreshToken();
    const refreshToken = refreshTokenObj?.getToken();
    if (!refreshToken) {
      throw new Error('Missing refresh token. Cannot refresh session.');
    }
    // If a refresh is already in progress, return the existing promise
    if (this._refreshing) {
      return this._refreshPromise;
    }
    this._refreshing = true;
    this._refreshPromise = new Promise((resolve, reject) => {
      this.cognitoUser.refreshSession(refreshTokenObj, (err, session) => {
        // Reset flags after attempt
        this._refreshing = false;
        this._refreshPromise = null;
        if (err) {
          // Clear session on failure
          this.signOut();
          return reject(err);
        }
        this.session = session;
        
        // Notify callback if tokens were refreshed
        if (this.onTokensRefreshed) {
          const tokens = this.getTokens();
          if (tokens) {
            this.onTokensRefreshed(tokens);
          }
        }
        
        resolve(session);
      });
    });
    return this._refreshPromise;
  }

  /**
   * Get all tokens as an object for storage/transmission
   * @returns {object|null} Tokens object or null if no session
   */
  getTokens() {
    if (!this.session) return null;
    return {
      id_token: this.getIdToken(),
      access_token: this.getAccessToken(),
      refresh_token: this.getRefreshToken(),
    };
  }
}

/**
 * Helper function to login and get tokens in one call
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<object>} Tokens object
 */
async function loginAndGetTokens(email, password) {
  const session = new CognitoSession({ username: email, password });
  await session.login();
  return session.getTokens();
}

// Attach helper function to the class
CognitoSession.loginAndGetTokens = loginAndGetTokens;

module.exports = CognitoSession;