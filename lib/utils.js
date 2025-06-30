'use strict';

/**
 * Utility functions for the Whisker app.
 * Following the pylitterbot pattern for common utilities.
 */

/**
 * Redact sensitive information from objects for logging.
 * @param {Object} obj - The object to redact
 * @param {Array<string>} sensitiveKeys - Keys to redact (default: common sensitive keys)
 * @returns {Object} - Object with sensitive data redacted
 */
function redactSensitiveData(obj, sensitiveKeys = ['password', 'token', 'access_token', 'refresh_token', 'id_token', 'secret', 'key']) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const redacted = Array.isArray(obj) ? [] : {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (sensitiveKeys.some(sensitiveKey => 
      key.toLowerCase().includes(sensitiveKey.toLowerCase())
    )) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value, sensitiveKeys);
    } else {
      redacted[key] = value;
    }
  }
  
  return redacted;
}

/**
 * Get current UTC timestamp.
 * @returns {Date} - Current UTC date
 */
function utcNow() {
  return new Date();
}

/**
 * Format timestamp for logging.
 * @param {Date} date - Date to format
 * @returns {string} - Formatted timestamp
 */
function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

/**
 * Decode base64 string.
 * @param {string} str - Base64 encoded string
 * @returns {string} - Decoded string
 */
function decode(str) {
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Encode string to base64.
 * @param {string} str - String to encode
 * @returns {string} - Base64 encoded string
 */
function encode(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * Deep clone an object.
 * @param {Object} obj - Object to clone
 * @returns {Object} - Cloned object
 */
function deepClone(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item));
  }
  
  const cloned = {};
  for (const [key, value] of Object.entries(obj)) {
    cloned[key] = deepClone(value);
  }
  
  return cloned;
}

/**
 * Check if two objects are deeply equal.
 * @param {Object} obj1 - First object
 * @param {Object} obj2 - Second object
 * @returns {boolean} - True if objects are deeply equal
 */
function deepEqual(obj1, obj2) {
  if (obj1 === obj2) {
    return true;
  }
  
  if (obj1 === null || obj2 === null || typeof obj1 !== 'object' || typeof obj2 !== 'object') {
    return obj1 === obj2;
  }
  
  if (obj1 instanceof Date && obj2 instanceof Date) {
    return obj1.getTime() === obj2.getTime();
  }
  
  if (Array.isArray(obj1) && Array.isArray(obj2)) {
    if (obj1.length !== obj2.length) {
      return false;
    }
    return obj1.every((item, index) => deepEqual(item, obj2[index]));
  }
  
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  
  if (keys1.length !== keys2.length) {
    return false;
  }
  
  return keys1.every(key => keys2.includes(key) && deepEqual(obj1[key], obj2[key]));
}

/**
 * Retry a function with exponential backoff.
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {Promise} - Promise that resolves with function result
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Debounce a function.
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} - Debounced function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Throttle a function.
 * @param {Function} func - Function to throttle
 * @param {number} limit - Time limit in milliseconds
 * @returns {Function} - Throttled function
 */
function throttle(func, limit) {
  let inThrottle;
  return function executedFunction(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

/**
 * Generate a unique identifier.
 * @returns {string} - Unique identifier
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Validate email format.
 * @param {string} email - Email to validate
 * @returns {boolean} - True if email is valid
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Sleep for a specified duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} - Promise that resolves after sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  redactSensitiveData,
  utcNow,
  formatTimestamp,
  decode,
  encode,
  deepClone,
  deepEqual,
  retryWithBackoff,
  debounce,
  throttle,
  generateId,
  isValidEmail,
  sleep,
}; 