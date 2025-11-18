const Homey = require('homey');
const PetData = require('../../lib/petdata');
const { colorize, LOG_COLORS, handleCapabilityError } = require('../../lib/utils');

module.exports = class PetDevice extends Homey.Device {

  /**
   * Initializes the pet device by setting up capabilities and registering with DataManager.
   * Establishes the device's connection to centralized data management for real-time updates.
   */
  async onInit() {
    this.log(colorize(LOG_COLORS.INFO, 'Initializing pet device'));

    try {
      const data = this.getData();
      this.petId = data.id;

      if (!this.petId) {
        throw new Error('Invalid device data. Missing pet ID.');
      }

      await this._initializeCapabilities();
      await this._registerWithDataManager();

      this.log(colorize(LOG_COLORS.SUCCESS, 'Device initialization completed successfully'));
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to initialize pet device:'), err);
      throw err;
    }
  }

  /**
   * Sets up all device capabilities with initial loading states.
   * Provides immediate user feedback while data is being fetched from the API.
   * @private
   */
  async _initializeCapabilities() {
    const initialCapabilities = {
      // Measurement capabilities
      measure_weight: null,

      // Label capabilities
      label_gender: 'Loading...',
      label_food: 'Loading...',
      label_environment: 'Loading...',
      label_birthday: 'Loading...',
      label_breed: 'Loading...',
      label_age: 'Loading...',

      // Alarm capabilities
      alarm_health_concern: false,
    };

    for (const [capability, value] of Object.entries(initialCapabilities)) {
      this.setCapabilityValue(capability, value).catch((err) => {
        handleCapabilityError(err, capability, 'initialize', this);
      });
    }

    this.log(colorize(LOG_COLORS.INFO, 'Capabilities initialized successfully'));
  }

  /**
   * Registers the device with DataManager for centralized pet polling.
   * Establishes the callback for receiving pet data updates from polling.
   * @private
   */
  async _registerWithDataManager() {
    try {
      const { dataManager } = this.homey.app;
      if (dataManager) {
        this.log(colorize(LOG_COLORS.INFO, 'Registering with DataManager for pet polling'));

        dataManager.registerPetDevice(this.getId(), this.petId, (data, source) => {
          this.log(colorize(LOG_COLORS.INFO, `Received data update from ${source} for pet ${this.petId}`));

          if (data) {
            if (this.petData) {
              const mergedPetData = { ...this.petData.pet, ...data };
              try {
                this.petData.updatePetData(mergedPetData);
              } catch (err) {
                this.error(colorize(LOG_COLORS.WARNING, 'Failed to update petData, creating new instance:'), err);
                this.petData = new PetData({ pet: data });
              }
            } else {
              this.petData = new PetData({ pet: data });
            }

            this._updateCapabilities(this.petData);
            this.log(colorize(LOG_COLORS.SUCCESS, `Pet data updated successfully for ${this.petData.pet?.name || 'Unknown Pet'}`));
          }
        });

        this.log(colorize(LOG_COLORS.SUCCESS, 'Successfully registered with DataManager'));
      } else {
        this.log(colorize(LOG_COLORS.WARNING, 'DataManager not available during registration'));
      }
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to register with DataManager:'), err);
    }
  }

  /**
   * Updates device capabilities based on processed pet data.
   * Tracks changes to trigger appropriate Flow cards for automation.
   * @param {PetData} petData - Processed pet data
   * @private
   */
  _updateCapabilities(petData) {
    if (!petData) return;

    const updates = [
      ['measure_weight', petData.weightInGrams],
      ['label_gender', petData.genderLabel],
      ['label_food', petData.dietLabel],
      ['label_environment', petData.environmentLabel],
      ['label_birthday', petData.birthdayFormatted],
      ['label_breed', petData.breedLabel],
      ['label_age', petData.ageLabel],
      ['alarm_health_concern', petData.hasHealthConcerns],
    ];

    const changes = new Set();

    for (const [capability, newValue] of updates) {
      if (newValue === undefined || newValue === null) continue;

      const oldValue = this.getCapabilityValue(capability);

      if (oldValue === 'Loading...') {
        this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Initializing capability [${capability}]: ${newValue}`)}`);
        this.setCapabilityValue(capability, newValue).catch((err) => {
          handleCapabilityError(err, capability, 'initialize', this);
        });
        continue;
      }

      if (newValue !== oldValue) {
        this.log(`[Capability] ${colorize(LOG_COLORS.CAPABILITY, `Capability [${capability}] changed: ${oldValue} → ${newValue}`)}`);
        this.setCapabilityValue(capability, newValue).catch((err) => {
          handleCapabilityError(err, capability, 'update', this);
        });
        changes.add(capability);
      }
    }

    if (changes.size > 0) {
      this._triggerFlowCards(changes, petData);
    }
  }

  /**
   * Triggers appropriate Flow cards based on detected capability changes.
   * Enables automation when pet information is updated.

   * @param {Set<string>} changes - Set of changed capabilities
   * @param {PetData} petData - Current pet data
   * @private
   */
  _triggerFlowCards(changes, petData) {

    if (changes.has('alarm_health_concern') && petData.hasHealthConcerns) {
      const concerns = petData.healthConcernsList?.join(', ');
      if (concerns) {
        this.log(`[Flow] ${colorize(LOG_COLORS.FLOW, `Triggering [health_concern_detected] (${concerns})`)}`);
        this.homey.flow.getDeviceTriggerCard('health_concern_detected')
          .trigger(this, { concerns })
          .catch((err) => this.error(colorize(LOG_COLORS.ERROR, 'Failed to trigger health_concern_detected:'), err));
      }
    }
  }

  /**
   * Performs cleanup when the device is deleted.
   * Ensures proper unregistration from DataManager to prevent memory leaks.
   */
  onDeleted() {
    this.log(colorize(LOG_COLORS.WARNING, 'Device deleted, performing cleanup'));

    try {
      const { dataManager } = this.homey.app;
      if (dataManager) {
        dataManager.unregisterPetDevice(this.getId());
        this.log(colorize(LOG_COLORS.SUCCESS, 'Successfully unregistered from DataManager'));
      } else {
        this.log(colorize(LOG_COLORS.WARNING, 'DataManager not available during cleanup'));
      }
    } catch (err) {
      this.error(colorize(LOG_COLORS.ERROR, 'Failed to unregister from DataManager:'), err);
    }
  }
};
