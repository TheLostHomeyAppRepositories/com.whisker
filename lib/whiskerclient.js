'use strict';

const ApiSession = require('./apisession');
const CognitoSession = require('./cognitosession');
const { colorize, LOG_COLORS } = require('./utils');

/**
 * Centralized authentication and API client for the Whisker app.
 * Manages Cognito authentication sessions and provides unified access to Whisker APIs
 * for robot and pet data, with automatic token refresh and WebSocket connection management.
 */
class WhiskerClient {
  constructor(homey) {
    this.homey = homey;
    this.log = homey.log;
    this.cognitoSession = null;
    this.apiSession = null;
  }

  /**
   * Authenticates with Whisker using username and password credentials.
   * Establishes Cognito session and initializes API access for subsequent operations.
   * @param {string} username - Whisker account username
   * @param {string} password - Whisker account password
   * @returns {Promise<boolean>} Authentication success status
   */
  async login(username, password) {
    this.log(`[WhiskerClient] ${colorize(LOG_COLORS.INFO, 'Logging in...')}`);
    try {
      this.cognitoSession = new CognitoSession({
        username,
        password,
        homey: this.homey,
        onTokensRefreshed: (tokens) => this.homey.settings.set('cognito_tokens', tokens),
      });
      await this.cognitoSession.login();
      this.apiSession = new ApiSession(this.cognitoSession, this.homey);
      this.log(`[WhiskerClient] ${colorize(LOG_COLORS.SUCCESS, 'Login successful.')}`);
      return true;
    } catch (error) {
      this.log(`[WhiskerClient] ${colorize(LOG_COLORS.ERROR, 'Login failed:')}`, error.message);
      return false;
    }
  }

  /**
   * Authenticates using stored tokens for seamless session restoration.
   * Refreshes tokens if needed to maintain continuous API access.
   * @param {Object} tokens - Stored authentication tokens
   * @returns {Promise<boolean>} Authentication success status
   */
  async loginWithTokens(tokens) {
    this.log(`[WhiskerClient] ${colorize(LOG_COLORS.INFO, 'Logging in with tokens...')}`);
    try {
      this.cognitoSession = new CognitoSession({
        tokens,
        homey: this.homey,
        onTokensRefreshed: (tokens) => this.homey.settings.set('cognito_tokens', tokens),
      });
      if (!this.cognitoSession.isSessionValid()) {
        await this.cognitoSession.refreshSession();
      }
      this.apiSession = new ApiSession(this.cognitoSession, this.homey);
      this.log(`[WhiskerClient] ${colorize(LOG_COLORS.SUCCESS, 'Login with tokens successful.')}`);
      return true;
    } catch (error) {
      this.log(`[WhiskerClient] ${colorize(LOG_COLORS.ERROR, 'Login with tokens failed:')}`, error.message);
      return false;
    }
  }

  /**
   * Checks if the client has a valid authentication session.
   * @returns {boolean} Authentication status
   */
  isAuthenticated() {
    return this.cognitoSession && this.cognitoSession.isSessionValid();
  }


  /**
   * Signs out and cleans up all authentication resources.
   * Clears sessions and resets internal state for security.
   */
  signOut() {
    if (this.cognitoSession) {
      this.cognitoSession.signOut();
    }
    if (this.apiSession) {
      this.apiSession.destroy();
    }
    this.cognitoSession = null;
    this.apiSession = null;
    this.log(`[WhiskerClient] ${colorize(LOG_COLORS.SYSTEM, 'Signed out.')}`);
  }
}

module.exports = WhiskerClient;
