const { colorize, LOG_COLORS } = require('./utils');

/**
 * Centralized token storage for Whisker authentication.
 * Provides secure persistence of Cognito tokens across app sessions,
 * enabling seamless authentication without requiring user re-login.
 */
class TokenStore {
  /**
   * @param {object} homey - Homey instance for settings access and logging.
   */
  constructor(homey) {
    if (!homey) {
      throw new Error('Homey instance is required for TokenStore.');
    }
    this.homey = homey;
    this.log = homey.log;
  }

  /**
   * Retrieves stored authentication tokens for session restoration.
   * @returns {object|null} Stored tokens or null if not found.
   */
  getTokens() {
    try {
      const tokens = this.homey.settings.get('cognito_tokens');
      if (tokens) {
        this.log(`[TokenStore] ${colorize(LOG_COLORS.INFO, 'Retrieved tokens from storage.')}`);
        return tokens;
      }
      this.log(`[TokenStore] ${colorize(LOG_COLORS.INFO, 'No tokens found in storage.')}`);
      return null;
    } catch (error) {
      this.homey.error(`[TokenStore] ${colorize(LOG_COLORS.ERROR, 'Error getting tokens:')}`, error.message);
      return null;
    }
  }

  /**
   * Persists authentication tokens for future sessions.
   * Validates token structure to prevent storage of incomplete credentials.
   * @param {object} tokens - Complete token object with id, access, and refresh tokens.
   */
  setTokens(tokens) {
    if (!tokens || !tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
      this.homey.error(`[TokenStore] ${colorize(LOG_COLORS.ERROR, 'Attempted to store invalid tokens.')}`);
      return;
    }
    try {
      this.homey.settings.set('cognito_tokens', tokens);
      this.log(`[TokenStore] ${colorize(LOG_COLORS.INFO, 'Tokens stored successfully.')}`);
    } catch (error) {
      this.homey.error(`[TokenStore] ${colorize(LOG_COLORS.ERROR, 'Error setting tokens:')}`, error.message);
    }
  }

  /**
   * Removes stored tokens to force re-authentication.
   * Used during logout or when tokens become invalid.
   */
  clearTokens() {
    try {
      this.homey.settings.unset('cognito_tokens');
      this.log(`[TokenStore] ${colorize(LOG_COLORS.SYSTEM, 'Tokens cleared from storage.')}`);
    } catch (error) {
      this.homey.error(`[TokenStore] ${colorize(LOG_COLORS.ERROR, 'Error clearing tokens:')}`, error.message);
    }
  }
}

module.exports = TokenStore;
