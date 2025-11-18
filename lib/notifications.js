/**
 * @module notifications
 * Provides timeline notification creation utilities for device events and updates.
 */

const { colorize, LOG_COLORS, convertLbsToGrams } = require('./utils');

/**
 * Weight matching tolerance in pounds.
 * Accounts for scale variance and minor weight fluctuations when matching detected weight to registered pets.
 */
const WEIGHT_MATCH_TOLERANCE = 0.5;

/**
 * In-memory lock to prevent concurrent notification creation for the same device.
 * Maps device IDs to promises that resolve when notification creation completes.
 */
const notificationLocks = new Map();

/**
 * Creates a cat visit notification based on detected weight.
 * Matches weight to registered pets when available; falls back to generic notifications
 * if no pets are registered, matching fails, or API queries fail.
 *
 * @param {number} weight - Detected weight in pounds
 * @param {string} robotName - Name/nickname of the Litter-Robot
 * @param {Object} dataManager - DataManager instance to check for registered pets
 * @param {Object} session - Session instance to query pets (if pets not provided)
 * @param {Object} homey - Homey instance for creating notifications
 * @param {Array} [pets] - Optional pre-fetched pets array to avoid additional API call
 * @returns {Promise<void>}
 */
async function createCatVisitNotification(weight, robotName, dataManager, session, homey, pets = null) {
  try {
    const hasRegisteredPets = dataManager && dataManager.petDevices && dataManager.petDevices.size > 0;

    if (!hasRegisteredPets) {
      const message = `A cat has visited ${robotName} 🐱`;
      await homey.notifications.createNotification({
        excerpt: message,
      });
      homey.log(`[Notifications] ${colorize(LOG_COLORS.SUCCESS, `Created generic cat visit notification: ${message}`)}`);
      return;
    }

    // Use provided pets array if available to avoid redundant API call
    if (!pets) {
      try {
        pets = await session.getPets();
      } catch (error) {
        homey.error(`[Notifications] ${colorize(LOG_COLORS.ERROR, 'Failed to fetch pets for notification:')}`, error);
        // Fallback to generic notification to ensure user still receives notification despite API failure
        const message = `A cat has visited ${robotName} 🐱`;
        await homey.notifications.createNotification({
          excerpt: message,
        });
        return;
      }
    }

    const activePetsWithWeight = pets.filter(
      (pet) => pet.isActive && pet.lastWeightReading && pet.lastWeightReading > 0,
    );

    if (activePetsWithWeight.length === 0) {
      const message = `A cat has visited ${robotName} 🐱`;
      await homey.notifications.createNotification({
        excerpt: message,
      });
      homey.log(`[Notifications] ${colorize(LOG_COLORS.INFO, 'No pets with weight data, using generic notification')}`);
      return;
    }

    let closestPet = null;
    let smallestDifference = Infinity;

    for (const pet of activePetsWithWeight) {
      const difference = Math.abs(pet.lastWeightReading - weight);
      if (difference < smallestDifference) {
        smallestDifference = difference;
        closestPet = pet;
      }
    }

    if (closestPet && smallestDifference <= WEIGHT_MATCH_TOLERANCE) {
      const weightGrams = convertLbsToGrams(weight);
      const weightFormatted = Math.round(weightGrams);
      const message = `${closestPet.name} has visited ${robotName} and weighed in at ${weightFormatted} g 🐱`;
      await homey.notifications.createNotification({
        excerpt: message,
      });
      homey.log(`[Notifications] ${colorize(LOG_COLORS.SUCCESS, `Created personalized notification: ${message}`)}`);
    } else {
      const message = `A cat has visited ${robotName} 🐱`;
      await homey.notifications.createNotification({
        excerpt: message,
      });
      homey.log(`[Notifications] ${colorize(LOG_COLORS.INFO, `No pet match within tolerance (${smallestDifference.toFixed(2)} lbs difference), using generic notification`)}`);
    }
  } catch (error) {
    homey.error(`[Notifications] ${colorize(LOG_COLORS.ERROR, 'Failed to create cat visit notification:')}`, error);
    // Fallback ensures notification is delivered even if matching logic fails
    try {
      const message = `A cat has visited ${robotName} 🐱`;
      await homey.notifications.createNotification({
        excerpt: message,
      });
    } catch (fallbackError) {
      homey.error(`[Notifications] ${colorize(LOG_COLORS.ERROR, 'Failed to create fallback notification:')}`, fallbackError);
    }
  }
}

/**
 * Creates a notification when a device needs to be re-paired to access new capabilities.
 * Prevents duplicate notifications using persistent storage and in-memory locks
 * to handle concurrent capability failures.
 *
 * @param {Object} device - Device instance (must have getStoreValue, setStoreValue, getName methods)
 * @param {Object} homey - Homey instance for creating notifications
 * @returns {Promise<void>}
 */
async function createUpdateNotification(device, homey) {
  const deviceId = device.getData().id;

  // Wait for existing notification creation to complete to prevent race conditions
  if (notificationLocks.has(deviceId)) {
    await notificationLocks.get(deviceId);
    return;
  }

  const notificationPromise = (async () => {
    try {
      const notificationSent = await device.getStoreValue('capability_update_notification_sent');
      if (notificationSent) {
        return;
      }

      const deviceName = device.getName() || 'device';
      const message = `${deviceName} must be re-paired if you want to use new features. Please fully remove and re-add the device 🔧`;

      await homey.notifications.createNotification({
        excerpt: message,
      });

      await device.setStoreValue('capability_update_notification_sent', true);

      homey.log(`[Notifications] ${colorize(LOG_COLORS.SUCCESS, `Created update notification for ${deviceName}`)}`);
    } catch (error) {
      homey.error(`[Notifications] ${colorize(LOG_COLORS.ERROR, 'Failed to create update notification:')}`, error);
    } finally {
      notificationLocks.delete(deviceId);
    }
  })();

  notificationLocks.set(deviceId, notificationPromise);

  await notificationPromise;
}

module.exports = {
  createCatVisitNotification,
  createUpdateNotification,
  WEIGHT_MATCH_TOLERANCE,
};
