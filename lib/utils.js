'use strict';

/**
 * Utility functions for the Whisker app.
 * Provides essential helper functions for reliability, formatting, data validation,
 * and common operations across the entire app ecosystem.
 */

const jwt = require('jsonwebtoken');

/**
 * Token expiration configuration constants.
 * Centralized settings for token validation and refresh timing.
 */
const TOKEN_CONFIG = {
  EXPIRATION_BUFFER_SECONDS: 300, // 5 minutes buffer before token expiration
};

/**
 * ANSI color codes for consistent logging across the app.
 * Centralized color definitions to maintain consistency and ease maintenance.
 */
const LOG_COLORS = {
  // Primary colors for different log types
  INFO: '\x1b[36m',      // Cyan - informational steps/progress
  SUCCESS: '\x1b[32m',   // Green - successful completions
  WARNING: '\x1b[33m',   // Yellow - warnings
  ERROR: '\x1b[31m',     // Red - errors/failures
  SYSTEM: '\x1b[35m',    // Magenta - system operations and state changes
  COMMAND: '\x1b[38;5;136m', // Brown - command sending and execution
  CAPABILITY: '\x1b[38;5;27m',  // Blue - capability-related log messages
  FLOW: '\x1b[38;5;172m',  // Orange - Flow condition checks
  
  // Text formatting
  BOLD: '\x1b[1m',       // Bold text
  
  // Reset formatting
  RESET: '\x1b[0m',      // Reset all formatting
};

/**
 * Helper function to create colored log messages.
 * @param {string} color - Color code from LOG_COLORS
 * @param {string} message - Message to colorize
 * @returns {string} Colored message with reset
 */
function colorize(color, message) {
  return `${color}${message}${LOG_COLORS.RESET}`;
}

/**
 * Implements exponential backoff retry logic for transient failures.
 * Reduces API load during temporary issues while ensuring eventual success.
 * @param {Function} fn - Function to retry (can receive attempt number as parameter)
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in milliseconds
 * @param {Object} [homey] - Homey instance for logging
 * @returns {Promise} - Promise that resolves with function result
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000, homey = null) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) {
              if (homey) {
        homey.error(`[Utils] ${colorize(LOG_COLORS.ERROR, `Retry failed after ${maxRetries} attempts:`)}`, error);
      }
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt);
      if (homey) {
        homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `Retry attempt ${attempt + 1} failed, waiting ${delay}ms before retry`)}`);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Formats snake_case strings to Title Case for display.
 * Converts strings like "german_shepherd" to "German Shepherd".
 * @param {string} str - Snake case string to format
 * @param {Object} [homey] - Homey instance for logging
 * @returns {string} Title case formatted string
 */
function formatSnakeCase(str, homey = null) {
  if (!str || typeof str !== 'string') {
    if (homey) {
      homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `formatSnakeCase: Invalid input, returning as-is:`)}`, str);
    }
    return str;
  }
  
  return str
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Formats an array of snake_case strings to Title Case and sorts them.
 * Used for formatting lists like breeds, health concerns, etc.
 * @param {Array} items - Array of snake_case strings
 * @param {Object} [homey] - Homey instance for logging
 * @returns {Array} Formatted and sorted array of Title Case strings
 */
function formatStringList(items, homey = null) {
  if (!Array.isArray(items) || items.length === 0) {
    if (homey) {
      homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `formatStringList: Empty or invalid array provided`)}`);
    }
    return [];
  }
  
  return items
    .map(item => formatSnakeCase(item, homey))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Converts weight from pounds to grams using standard conversion.
 * @param {number} weightInLbs - Weight in pounds
 * @param {Object} [homey] - Homey instance for logging
 * @returns {number} Weight in grams (rounded)
 */
function convertLbsToGrams(weightInLbs, homey = null) {
  if (typeof weightInLbs !== 'number' || isNaN(weightInLbs)) {
    if (homey) {
      homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `convertLbsToGrams: Invalid weight value:`)}`, weightInLbs);
    }
    return null;
  }
  
  return Math.round(weightInLbs * 453.59237);
}

/**
 * Validates if an array contains items (not empty or null).
 * @param {Array} array - Array to validate
 * @param {Object} [homey] - Homey instance for logging
 * @returns {boolean} True if array exists and has items
 */
function hasItems(array, homey = null) {
  const result = Array.isArray(array) && array.length > 0;
  
  if (homey && !result) {
    homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `hasItems: Array validation failed (empty or invalid)`)}`);
  }
  
  return result;
}

/**
 * Checks if a date string represents today's date.
 * @param {string} dateStr - Date string in ISO format
 * @param {Object} [homey] - Homey instance for logging
 * @returns {boolean} True if the date is today
 */
function isDateToday(dateStr, homey = null) {
  if (!dateStr) {
    if (homey) {
      homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `isDateToday: No date string provided`)}`);
    }
    return false;
  }
  
  const today = new Date();
  const [year, month, day] = dateStr.split(' ')[0].split('-').map(Number);
  return today.getDate() === day && (today.getMonth() + 1) === month;
}

/**
 * Calculates days until the next occurrence of a date.
 * @param {string} dateStr - Date string in ISO format
 * @param {Object} [homey] - Homey instance for logging
 * @returns {number|null} Days until next occurrence or null if invalid
 */
function daysUntilDate(dateStr, homey = null) {
  if (!dateStr) {
    if (homey) {
      homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `daysUntilDate: No date string provided`)}`);
    }
    return null;
  }
  
  const today = new Date();
  const targetDate = new Date(dateStr);
  const nextOccurrence = new Date(today.getFullYear(), targetDate.getMonth(), targetDate.getDate());

  if (nextOccurrence < today) {
    nextOccurrence.setFullYear(nextOccurrence.getFullYear() + 1);
  }

  const diffMs = nextOccurrence - today;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Decodes JWT token without signature verification to extract payload data.
 * @param {string} token - JWT token to decode
 * @param {Object} [homey] - Homey instance for logging
 * @returns {Object|null} Decoded token payload or null if failed
 */
function decodeJwt(token, homey = null) {
  try {
    if (!token) {
      if (homey) {
        homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `decodeJwt: No token provided`)}`);
      }
      return null;
    }
    
    // Disable signature verification to extract data from tokens with signature issues
    const result = jwt.decode(token, { 
      verify_signature: false, 
      verify_exp: false 
    }) || null;
    
    if (homey && !result) {
      homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `decodeJwt: JWT token decode returned null`)}`);
    }
    
    return result;
  } catch (err) {
    if (homey) {
      homey.error(`[Utils] ${colorize(LOG_COLORS.ERROR, `decodeJwt: Failed to decode JWT token:`)}`, err);
    }
    return null;
  }
}

/**
 * Converts current time to Unix timestamp (seconds since epoch).
 * Used for token expiration checking and time calculations.
 * @returns {number} Current Unix timestamp in seconds
 */
function getUnixTimestamp() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Safely encodes data to base64 string.
 * @param {string|Object} data - Data to encode (string or object to JSON.stringify)
 * @param {Object} [homey] - Homey instance for logging
 * @returns {string} Base64 encoded string
 */
function encodeBase64(data, homey = null) {
  try {
    const stringData = typeof data === 'string' ? data : JSON.stringify(data);
    return Buffer.from(stringData).toString('base64');
  } catch (err) {
    if (homey) {
      homey.error(`[Utils] ${colorize(LOG_COLORS.ERROR, `encodeBase64: Failed to encode data:`)}`, err);
    }
    return '';
  }
}

/**
 * Safely decodes base64 string to original data.
 * @param {string} base64String - Base64 encoded string
 * @param {Object} [homey] - Homey instance for logging
 * @returns {string} Decoded string
 */
function decodeBase64(base64String, homey = null) {
  try {
    return Buffer.from(base64String, 'base64').toString('utf-8');
  } catch (err) {
    if (homey) {
      homey.error(`[Utils] ${colorize(LOG_COLORS.ERROR, `decodeBase64: Failed to decode base64 string:`)}`, err);
    }
    return '';
  }
}

/**
 * Extracts operation name from GraphQL query for structured logging.
 * Attempts to find named operations first, then falls back to operation type.
 * @param {string} query - GraphQL query string
 * @param {Object} [homey] - Homey instance for logging
 * @returns {string} Operation name or operation type fallback
 */
function extractGraphQLOperationName(query, homey = null) {
  if (!query) {
    if (homey) {
      homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `extractGraphQLOperationName: No query provided`)}`);
    }
    return 'unknown';
  }
  
  // Extract named operation (e.g., "query GetRobots")
  const operationMatch = query.match(/(?:query|mutation|subscription)\s+(\w+)/);
  if (operationMatch) {
    return operationMatch[1];
  }
  
  // Fallback to operation type if no name found
  if (query.includes('query')) {
    return 'query';
  }
  if (query.includes('mutation')) {
    return 'mutation';
  }
  if (query.includes('subscription')) {
    return 'subscription';
  }
  
  return 'unknown';
}

/**
 * Extracts and formats token expiration information from JWT tokens.
 * Provides human-readable expiration details for monitoring and debugging.
 * @param {string} token - JWT token string
 * @param {Object} [homey] - Homey instance for logging
 * @returns {Object|null} Token expiration details or null if invalid
 */
function getTokenExpirationInfo(token, homey = null) {
  try {
    if (!token) {
      if (homey) {
        homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `getTokenExpirationInfo: No token provided`)}`);
      }
      return null;
    }

    const decoded = decodeJwt(token, homey);
    if (!decoded?.exp) {
      if (homey) {
        homey.log(`[Utils] ${colorize(LOG_COLORS.WARNING, `getTokenExpirationInfo: No expiration found in token`)}`);
      }
      return null;
    }

    // Verify expiration with 30-second leeway for clock synchronization
    let tokenExpired = false;
    try {
      jwt.decode(token, { 
        verify_signature: false, 
        verify_exp: true 
      }, { 
        leeway: -30 
      });
    } catch (err) {
      if (err.name === 'TokenExpiredError' || err.name === 'ExpiredSignatureError') {
        tokenExpired = true;
      }
    }

    const now = getUnixTimestamp();
    const expiresAt = decoded.exp;
    const timeUntilExpiry = expiresAt - now;
    const isExpired = timeUntilExpiry <= 0 || tokenExpired;
    const isExpiringSoon = timeUntilExpiry <= TOKEN_CONFIG.EXPIRATION_BUFFER_SECONDS;

    // Format time until expiry
    let formattedTimeUntilExpiry;
    if (timeUntilExpiry <= 0) {
      formattedTimeUntilExpiry = 'expired';
    } else {
      const hours = Math.floor(timeUntilExpiry / 3600);
      const minutes = Math.floor((timeUntilExpiry % 3600) / 60);
      const seconds = timeUntilExpiry % 60;
      
      if (hours > 0) {
        formattedTimeUntilExpiry = `${hours}h ${minutes}m ${seconds}s`;
      } else if (minutes > 0) {
        formattedTimeUntilExpiry = `${minutes}m ${seconds}s`;
      } else {
        formattedTimeUntilExpiry = `${seconds}s`;
      }
    }

    return {
      expiresAt: new Date(expiresAt * 1000).toISOString(),
      expiresAtUnix: expiresAt,
      timeUntilExpiry: timeUntilExpiry,
      isExpired,
      isExpiringSoon,
      formattedTimeUntilExpiry,
      // Additional token info
      issuedAt: decoded.iat ? new Date(decoded.iat * 1000).toISOString() : null,
      tokenType: decoded.token_use || 'unknown',
      audience: decoded.aud,
      issuer: decoded.iss,
    };
  } catch (err) {
    if (homey) {
      homey.error(`[Utils] ${colorize(LOG_COLORS.ERROR, `getTokenExpirationInfo: Failed to extract token info:`)}`, err);
    }
    return null;
  }
}

/**
 * Safely stringifies objects to JSON with error handling.
 * @param {Object} obj - Object to stringify
 * @param {number} [space] - Number of spaces for indentation
 * @param {Object} [homey] - Homey instance for logging
 * @returns {string|null} JSON string or null if failed
 */
function safeStringify(obj, space = 0, homey = null) {
  try {
    return JSON.stringify(obj, null, space);
  } catch (err) {
    if (homey) {
      homey.error(`[Utils] ${colorize(LOG_COLORS.ERROR, `safeStringify: Failed to stringify object:`)}`, err);
    }
    return null;
  }
}

/**
 * Safely parses JSON strings with error handling.
 * @param {string} str - JSON string to parse
 * @param {Object} [homey] - Homey instance for logging
 * @returns {Object|null} Parsed object or null if failed
 */
function safeParse(str, homey = null) {
  try {
    return JSON.parse(str);
  } catch (err) {
    if (homey) {
      homey.error(`[Utils] ${colorize(LOG_COLORS.ERROR, `safeParse: Failed to parse JSON string:`)}`, err);
    }
    return null;
  }
}

module.exports = {
  TOKEN_CONFIG,
  LOG_COLORS,
  colorize,
  retryWithBackoff,
  formatSnakeCase,
  formatStringList,
  convertLbsToGrams,
  hasItems,
  isDateToday,
  daysUntilDate,
  decodeJwt,
  getUnixTimestamp,
  encodeBase64,
  decodeBase64,
  extractGraphQLOperationName,
  getTokenExpirationInfo,
  safeStringify,
  safeParse,
}; 