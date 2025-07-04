'use strict';

const Homey = require('homey');
const CognitoSession = require('./lib/cognitosession');
const ApiSession = require('./lib/apisession');
const DataManager = require('./lib/datamanager');

class WhiskerApp extends Homey.App {

  /**
   * Initialize the app and set up the centralized session and data management
   */
  async onInit() {
    this.log('Whisker app is initializing...');

    // Initialize centralized session management
    this._initializeSessionManagement();

    // Initialize centralized data management
    this._initializeDataManagement();

    // Try to restore session from stored tokens
    await this._restoreSessionFromStorage();

    this.log('Whisker app has been initialized');
  }

  /**
   * Initialize the centralized session management
   * @private
   */
  _initializeSessionManagement() {
    // Create centralized Cognito session
    // This will be initialized with credentials when devices are paired
    this._cognitoSession = null;
    this._apiSession = null;
    
    this.log('Session management initialized');
  }

  /**
   * Initialize the centralized data management
   * @private
   */
  _initializeDataManagement() {
    // Data manager will be created once we have an API session
    this._dataManager = null;
    
    this.log('Data management initialized');
  }

  /**
   * Try to restore session from stored tokens
   * @private
   */
  async _restoreSessionFromStorage() {
    try {
      const storedTokens = this.homey.settings.get('cognito_tokens');
      if (storedTokens && storedTokens.id_token && storedTokens.access_token && storedTokens.refresh_token) {
        this.log('Found stored tokens, attempting to restore session...');
        
        // Check if tokens are still valid
        const decoded = this._decodeJwt(storedTokens.access_token);
        if (decoded && decoded.exp) {
          const now = Math.floor(Date.now() / 1000);
          if (decoded.exp > now + 30) {
            // Tokens are still valid, restore session
            await this.initializeSessionWithTokens(storedTokens);
            this.log('Session restored successfully from stored tokens');
            return;
          } else {
            this.log('Stored tokens are expired, will need to refresh');
            // Try to refresh the session
            try {
              await this.initializeSessionWithTokens(storedTokens);
              // If we get here, refresh was successful
              this.log('Session refreshed successfully from stored tokens');
              return;
            } catch (refreshError) {
              this.log('Failed to refresh stored tokens:', refreshError.message);
              // Clear invalid tokens
              this._clearStoredTokens();
            }
          }
        }
      }
    } catch (error) {
      this.log('Error restoring session from storage:', error.message);
      // Clear potentially corrupted tokens
      this._clearStoredTokens();
    }
    
    this.log('No valid stored session found, user will need to authenticate');
  }

  /**
   * Store tokens in persistent storage
   * @param {Object} tokens - Tokens object { id_token, access_token, refresh_token }
   * @private
   */
  _storeTokens(tokens) {
    try {
      this.homey.settings.set('cognito_tokens', tokens);
      this.log('Tokens stored in persistent storage');
    } catch (error) {
      this.log('Failed to store tokens:', error.message);
    }
  }

  /**
   * Clear stored tokens from persistent storage
   * @private
   */
  _clearStoredTokens() {
    try {
      this.homey.settings.unset('cognito_tokens');
      this.log('Stored tokens cleared');
    } catch (error) {
      this.log('Failed to clear stored tokens:', error.message);
    }
  }

  /**
   * Decode JWT without verification (for checking expiration)
   * @param {string} token - JWT token
   * @returns {Object|null} Decoded payload or null
   * @private
   */
  _decodeJwt(token) {
    try {
      if (!token) return null;
      const jwt = require('jsonwebtoken');
      return jwt.decode(token) || null;
    } catch (err) {
      this.log('Failed to decode JWT:', err.message);
      return null;
    }
  }

  /**
   * Initialize the API session with credentials
   * @param {string} username - Cognito username/email
   * @param {string} password - Cognito password
   * @returns {Promise<ApiSession>}
   */
  async initializeSession(username, password) {
    if (this._apiSession) {
      this.log('API session already initialized');
      return this._apiSession;
    }

    this.log('Initializing API session with credentials...');

    try {
      // Create Cognito session with token refresh callback
      this._cognitoSession = new CognitoSession({ 
        username, 
        password,
        onTokensRefreshed: (tokens) => this._storeTokens(tokens)
      });
      
      // Authenticate and get tokens
      await this._cognitoSession.login();
      
      // Store tokens in persistent storage
      const tokens = this._cognitoSession.getTokens();
      if (tokens) {
        this._storeTokens(tokens);
      }
      
      // Create API session
      this._apiSession = new ApiSession(this._cognitoSession, this.homey);
      
      // Create data manager
      this._dataManager = new DataManager(this._apiSession, this.homey);
      
      this.log('API session initialized successfully');
      return this._apiSession;
    } catch (error) {
      this.log('Failed to initialize API session:', error);
      throw error;
    }
  }

  /**
   * Initialize the API session with existing tokens
   * @param {Object} tokens - Existing tokens { id_token, access_token, refresh_token }
   * @returns {Promise<ApiSession>}
   */
  async initializeSessionWithTokens(tokens) {
    if (this._apiSession) {
      this.log('API session already initialized');
      return this._apiSession;
    }

    this.log('Initializing API session with existing tokens...');

    try {
      // Create Cognito session with tokens and token refresh callback
      this._cognitoSession = new CognitoSession({ 
        tokens,
        onTokensRefreshed: (tokens) => this._storeTokens(tokens)
      });
      
      // Check if session is valid, if not try to refresh
      if (!this._cognitoSession.isSessionValid()) {
        this.log('Session is not valid, attempting to refresh...');
        await this._cognitoSession.refreshSession();
        
        // Store the refreshed tokens
        const refreshedTokens = this._cognitoSession.getTokens();
        if (refreshedTokens) {
          this._storeTokens(refreshedTokens);
        }
      } else {
        // Store the current tokens
        this._storeTokens(tokens);
      }
      
      // Create API session
      this._apiSession = new ApiSession(this._cognitoSession, this.homey);
      
      // Create data manager
      this._dataManager = new DataManager(this._apiSession, this.homey);
      
      this.log('API session initialized successfully with tokens');
      return this._apiSession;
    } catch (error) {
      this.log('Failed to initialize API session with tokens:', error);
      throw error;
    }
  }

  /**
   * Get the API session instance
   * @returns {ApiSession|null}
   */
  get apiSession() {
    return this._apiSession;
  }

  /**
   * Get the data manager instance
   * @returns {DataManager|null}
   */
  get dataManager() {
    return this._dataManager;
  }

  /**
   * Get the Cognito session instance
   * @returns {CognitoSession|null}
   */
  get cognitoSession() {
    return this._cognitoSession;
  }

  /**
   * Check if the app is authenticated
   * @returns {boolean}
   */
  isAuthenticated() {
    return this._cognitoSession && this._cognitoSession.isSessionValid();
  }

  /**
   * Sign out and clean up sessions
   */
  async signOut() {
    if (this._cognitoSession) {
      this._cognitoSession.signOut();
    }
    
    if (this._apiSession) {
      this._apiSession.destroy();
    }
    
    if (this._dataManager) {
      this._dataManager.destroy();
    }
    
    // Clear stored tokens
    this._clearStoredTokens();
    
    this._cognitoSession = null;
    this._apiSession = null;
    this._dataManager = null;
    
    this.log('Signed out and cleaned up sessions');
  }

  /**
   * Check if we have valid stored tokens that can be used for pairing
   * @returns {boolean} True if we have valid stored tokens
   */
  hasValidStoredTokens() {
    try {
      const storedTokens = this.homey.settings.get('cognito_tokens');
      if (!storedTokens || !storedTokens.access_token) {
        return false;
      }
      
      // Check if access token is still valid
      const decoded = this._decodeJwt(storedTokens.access_token);
      if (decoded && decoded.exp) {
        const now = Math.floor(Date.now() / 1000);
        return decoded.exp > now + 30; // 30 second buffer
      }
      
      return false;
    } catch (error) {
      this.log('Error checking stored tokens:', error.message);
      return false;
    }
  }

}

module.exports = WhiskerApp;
