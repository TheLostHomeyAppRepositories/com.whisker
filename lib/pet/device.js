const WhiskerDevice = require('../WhiskerDevice');
const { WhiskerNetworkException } = require('../common/exceptions');
const { convertLbsToGrams } = require('../common/utils');
const {
  formatBreeds,
  formatHealthConcernsLine,
  getAgeUnits,
  hasHealthConcerns,
  mapDiet,
  mapEnvironment,
  mapGender,
  parseBirthday,
} = require('./state');
const petApi = require('./api');

const PET_POLL_KEY = 'pets';
const PET_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Pet profile Homey device: polling-based updates and pet-specific flow triggers.
 */
module.exports = class PetDevice extends WhiskerDevice {

  /**
   * Loads pet id from device data and joins app-level polling when a session exists.
   *
   * @returns {Promise<void>}
   */
  async onInit() {
    this._destroyed = false;

    this.log('Initializing pet device');

    try {
      const data = this.getData();
      this.petId = data.id;

      if (!this.petId) {
        throw new Error(this.homey.__('errors.invalid_device_data_missing_pet_id'));
      }

      await this.onSessionReady();

      this.log('Pet device initialization completed successfully');
    } catch (err) {
      this.error('Failed to initialize pet device:', err);
      this.setUnavailable(err instanceof WhiskerNetworkException
        ? this.homey.__('errors.network_unreachable')
        : err.message);

    }
  }

  /**
   * Registers with centralized pet polling when the app session is available.
   *
   * @returns {Promise<void>}
   */
  async onSessionReady() {
    if (this._destroyed) {
      return;
    }

    const { session } = this.homey.app;
    if (!session?.isSessionValid()) {
      throw new Error(this.homey.__('errors.session_unavailable'));
    }

    await this._registerPetForPolling();
  }

  /**
   * Shares one pets API fetch across pet devices via {@link module:Polling}.
   *
   * @returns {Promise<void>}
   */
  async _registerPetForPolling() {
    try {
      this.log('Registering for pet polling');

      this._registerForPolling(PET_POLL_KEY, {
        pollInterval: PET_POLL_INTERVAL_MS,
        pollFn: (activeSession) => petApi.getPets(activeSession, activeSession.getUserId()),
        metadata: { petId: this.petId },
        selectData: (pets, { petId }) => pets.find((p) => String(p.petId) === String(petId)),
        onDataUpdate: (data, source) => {
          if (this._destroyed) return;

          if (source === 'network_error') {
            this.setUnavailable(this.homey.__('errors.network_unreachable'));
            return;
          }

          this.log(`Received data update from ${source} for pet ${this.petId}`);

          if (!data) {
            return;
          }

          this.setAvailable();

          const previousPet = this.pet;
          this.pet = previousPet ? { ...previousPet, ...data } : data;

          const update = previousPet
            ? Object.fromEntries(
              Object.keys(data).filter((key) => data[key] !== previousPet[key]).map((key) => [key, data[key]]),
            )
            : data;

          this._applyPetUpdate(this.pet, update, { isInitial: !previousPet })
            .then(() => {
              this.log(`Pet data updated successfully for ${this.pet?.name || 'Unknown Pet'}`);
            })
            .catch((err) => this.error('Failed to refresh pet capabilities:', err));
        },
      });

      this.log('Successfully registered for pet polling');

      this.setAvailable();
      this.log('Device marked as available');
    } catch (err) {
      this.error('Failed to register for pet polling:', err);
    }
  }

  /**
   * Localizes age text for string capabilities and Flow tokens backed by label_age.
   *
   * @param {string|null|undefined} birthdayStr
   * @returns {string}
   */
  _formatAgeLabel(birthdayStr) {
    const age = getAgeUnits(birthdayStr);

    if (age.status === 'missing') {
      return this.homey.__('state.unknown');
    }
    if (age.status === 'invalid') {
      return this.homey.__('age.invalid_date');
    }

    const unit = age.unit === 'months' ? 'month' : 'year';
    const key = age.count === 1 ? `age.${unit}` : `age.${unit}s`;

    return this.homey.__(key, { count: age.count });
  }

  /**
   * Localizes birthday text for string capabilities and Flow tokens backed by label_birthday.
   *
   * @param {string|null|undefined} birthdayStr
   * @returns {string}
   */
  _formatBirthdayLabel(birthdayStr) {
    const parsed = parseBirthday(birthdayStr);

    if (parsed.status === 'missing') {
      return this.homey.__('state.unknown');
    }
    if (parsed.status === 'invalid') {
      return this.homey.__('age.invalid_date');
    }

    return parsed.date.toLocaleDateString(this.homey.__language || 'en', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  /**
   * Maps pet profile fields to capabilities. Homey fires `<capability>_changed` Flow cards
   * automatically when enum/string capabilities update via setCapabilityValue.
   *
   * @param {object} pet
   * @param {Object} update
   * @param {{ isInitial?: boolean }} [ctx]
   * @returns {Promise<void>}
   */
  async _applyPetUpdate(pet, update, { isInitial = false } = {}) {
    if (isInitial || 'lastWeightReading' in update) {
      await this._setCapability('measure_weight', convertLbsToGrams(pet.lastWeightReading));
    }

    if (isInitial || 'gender' in update) {
      await this._setCapability('label_gender', mapGender(pet.gender));
    }

    if (isInitial || 'diet' in update) {
      await this._setCapability('label_food', mapDiet(pet.diet));
    }

    if (isInitial || 'environmentType' in update) {
      await this._setCapability('label_environment', mapEnvironment(pet.environmentType));
    }

    if (isInitial || 'birthday' in update) {
      await this._setCapability('label_birthday', this._formatBirthdayLabel(pet.birthday));
      await this._setCapability('label_age', this._formatAgeLabel(pet.birthday));
    }

    if (isInitial || 'breeds' in update) {
      await this._setCapability('label_breed', formatBreeds(pet.breeds) ?? this.homey.__('state.unknown'));
    }

    if (isInitial || 'healthConcerns' in update) {
      if (await this._setCapability('alarm_health_concern', hasHealthConcerns(pet))) {
        const concerns = formatHealthConcernsLine(pet);
        if (concerns) {
          this._triggerFlowCard('health_concern_detected', { concerns });
        }
      }
    }
  }

  /**
   * Unregisters from pet polling when the device is removed from Homey.
   */
  onDeleted() {
    this.log('Device deleted, performing cleanup');
    this.onUninit();
  }

  /**
   * Unregisters from pet polling during driver shutdown or app restart.
   */
  onUninit() {
    if (this._destroyed) return;
    this._destroyed = true;

    try {
      this._unregisterFromPolling(PET_POLL_KEY);
      this.log('Successfully unregistered from pet polling');
    } catch (err) {
      this.error('Failed to unregister from pet polling:', err);
    }
  }
};
