/**
 * @module notifications
 * Provides timeline notification creation utilities for device events and updates.
 */

const { capabilities } = require('../../app.json');

const litterRobotStatus = capabilities.litter_robot_status;
const litterHopperStatus = capabilities.litter_hopper_status;
const { convertLbsToGrams } = require('./utils');
const petApi = require('../pet/api');
const { matchPetByWeight } = require('../pet/state');

/**
 * Creates a Homey timeline notification.
 *
 * @param {Object} homey
 * @param {string} excerpt
 * @returns {Promise<void>}
 */
async function createTimelineNotification(homey, excerpt) {
  await homey.notifications.createNotification({ excerpt });
}

/**
 * Creates a timeline notification at most once per device, keyed by device store.
 *
 * @param {Object} device
 * @param {Object} homey
 * @param {string} excerpt
 * @param {string} storeKey
 * @returns {Promise<boolean>}
 */
async function createTimelineNotificationOnce(device, homey, excerpt, storeKey) {
  if (await device.getStoreValue(storeKey)) {
    return false;
  }

  await createTimelineNotification(homey, excerpt);
  await device.setStoreValue(storeKey, true);
  return true;
}

/**
 * Posts a cat visit timeline notification when robot weight changes.
 *
 * @param {Object} params
 * @param {number} params.weight - Detected weight in pounds
 * @param {number|undefined} params.previousWeight - Prior weight; omit on initial sync
 * @param {string} params.robotName
 * @param {Object} params.homey
 * @param {Object} params.session
 * @param {boolean} [params.hasPetDevices=false]
 * @param {boolean} [params.enabled=true]
 * @returns {Promise<void>}
 */
async function notifyCatVisit({
  weight,
  previousWeight,
  robotName,
  homey,
  session,
  hasPetDevices = false,
  enabled = true,
}) {
  if (!enabled || previousWeight === undefined || !(weight > 0) || weight === previousWeight) {
    return;
  }

  let excerpt = homey.__('notifications.cat_visit_generic', { robot: robotName });

  if (hasPetDevices) {
    try {
      const pets = await petApi.getPets(session, session.getUserId());
      const pet = matchPetByWeight(pets, weight);
      if (pet) {
        excerpt = homey.__('notifications.cat_visit', {
          name: pet.name,
          robot: robotName,
          grams: Math.round(convertLbsToGrams(weight)),
        });
      }
    } catch (err) {
      homey.error('[Notifications] Failed to fetch pets for cat visit notification:', err);
    }
  }

  await createTimelineNotification(homey, excerpt);
}

/**
 * Posts a waste drawer full timeline notification when the alarm capability becomes true.
 *
 * @param {Object} params
 * @param {string} params.robotName
 * @param {Object} params.homey
 * @param {boolean} [params.enabled=true]
 * @returns {Promise<void>}
 */
async function notifyWasteDrawerFull({
  robotName,
  homey,
  enabled = true,
}) {
  if (!enabled) {
    return;
  }

  const excerpt = homey.__('notifications.waste_drawer_full', { robot: robotName });
  await createTimelineNotification(homey, excerpt);
}

/**
 * Posts a robot fault timeline notification when alarm_problem becomes true.
 *
 * @param {Object} params
 * @param {string} params.robotName
 * @param {string} params.faultCode
 * @param {Object} params.homey
 * @param {boolean} [params.enabled=true]
 * @returns {Promise<void>}
 */
async function notifyRobotFault({
  robotName,
  faultCode,
  homey,
  enabled = true,
}) {
  if (!enabled || !faultCode) {
    return;
  }

  const lang = typeof homey.i18n?.getLanguage === 'function' ? homey.i18n.getLanguage() : 'en';
  const entry = litterHopperStatus.values.find((value) => value.id === faultCode)
    || litterRobotStatus.values.find((value) => value.id === faultCode);
  const fault = entry?.title?.[lang] || entry?.title?.en;

  const excerpt = fault
    ? homey.__('notifications.robot_fault', { robot: robotName, fault })
    : homey.__('notifications.robot_fault_generic', { robot: robotName });

  await createTimelineNotification(homey, excerpt);
}

module.exports = {
  createTimelineNotification,
  createTimelineNotificationOnce,
  notifyCatVisit,
  notifyWasteDrawerFull,
  notifyRobotFault,
};
