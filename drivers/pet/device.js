'use strict';

const Homey = require('homey');
const PetData = require('../../lib/petdata');

module.exports = class PetDevice extends Homey.Device {

  /**
   * Device initialization - sets up capabilities and registers with DataManager
   */
  async onInit() {
    this.log('\x1b[36mPet device initialized\x1b[0m');

    try {
      // Get pet ID from device data
      const data = this.getData();
      this.petId = data.id;

      if (!this.petId) {
        throw new Error('Invalid device data. Missing pet ID.');
      }

      // Initialize capabilities with loading states
      await this._initializeCapabilities();

      // Register with DataManager for centralized data management
      // This will automatically fetch initial data and set up polling
      await this._registerWithDataManager();

      this.log('\x1b[32mPet device initialization completed successfully\x1b[0m');
    } catch (err) {
      this.error('\x1b[31mFailed to initialize pet device:\x1b[0m', err);
      throw err;
    }
  }

  /**
   * Initialize all device capabilities with loading states
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
      alarm_health_concern: false
    };

    // Set all initial values
    for (const [capability, value] of Object.entries(initialCapabilities)) {
      try {
        await this.setCapabilityValue(capability, value);
      } catch (err) {
        this.error(`Failed to initialize capability ${capability}:`, err);
      }
    }

            this.log('\x1b[32mPet capabilities initialized\x1b[0m');
  }

  /**
   * Register with DataManager and subscribe to weight updates
   * @private
   */
  async _registerWithDataManager() {
    try {
      const dataManager = this.homey.app.dataManager;
      if (dataManager) {
        // Register device with DataManager
        await dataManager.registerDevice(this.getId(), {
          type: 'pet', // This matches DEVICE_TYPES.PET in DataManager
          data: {
            petId: this.petId,
            name: this.petData?.name || 'Unknown Pet'
          },
          onDataUpdate: (data, source) => {
            // Handle data updates from DataManager
            this.log(`\x1b[36mReceived data update from ${source} for pet ${this.petId}\x1b[0m`);
            
            // Process the pet data and update capabilities
            if (data) {
              this.petData = new PetData({ pet: data });
              this._updateCapabilities(this.petData);
              this.log(`\x1b[32mPet data updated via DataManager for ${this.petData.name}\x1b[0m`);
            }
          }
        });

        this.log('\x1b[32mRegistered with DataManager for centralized data management\x1b[0m');
      }
    } catch (err) {
      this.error('\x1b[31mFailed to register with DataManager:\x1b[0m', err);
    }
  }





  /**
   * Update device capabilities based on pet data
   * @param {PetData} petData - Processed pet data
   * @private
   */
  _updateCapabilities(petData) {
    if (!petData) return;

    // Define capability updates
    const updates = [
      ['measure_weight', petData.weightInGrams],
      ['label_gender', petData.genderLabel],
      ['label_food', petData.dietLabel],
      ['label_environment', petData.environmentLabel],
      ['label_birthday', petData.birthdayFormatted],
      ['label_breed', petData.breedLabel],
      ['label_age', petData.ageLabel],
      ['alarm_health_concern', petData.hasHealthConcerns]
    ];

    // Track changes for Flow card triggering
    const changes = new Set();

    // Update capabilities
    for (const [capability, newValue] of updates) {
      if (newValue === undefined || newValue === null) continue;

      const oldValue = this.getCapabilityValue(capability);
      
      // Handle initialization from loading state
      if (oldValue === 'Loading...') {
        this.log(`\x1b[36mInitializing capability ${capability}: ${newValue}\x1b[0m`);
        this.setCapabilityValue(capability, newValue).catch(err => {
          this.error(`\x1b[31mFailed to initialize capability ${capability}:\x1b[0m`, err);
        });
        continue;
      }

      // Only update if value actually changed
      if (newValue !== oldValue) {
        this.log(`\x1b[33m${capability} changed: ${oldValue} → ${newValue}\x1b[0m`);
        this.setCapabilityValue(capability, newValue).catch(err => {
          this.error(`\x1b[31mFailed to update capability ${capability}:\x1b[0m`, err);
        });
        changes.add(capability);
      }
    }

    // Trigger Flow cards for detected changes
    if (changes.size > 0) {
      this._triggerFlowCards(changes, petData);
    }
  }

  /**
   * Trigger Flow cards based on capability changes
   * @param {Set<string>} changes - Set of changed capabilities
   * @param {PetData} petData - Current pet data
   * @private
   */
  _triggerFlowCards(changes, petData) {
    // Diet changed trigger
    if (changes.has('label_food')) {
      this.homey.flow.getDeviceTriggerCard('diet_changed')
        .trigger(this, { diet: petData.dietLabel })
        .catch(err => this.error('\x1b[31mFailed to trigger diet_changed:\x1b[0m', err));
    }

    // Environment changed trigger
    if (changes.has('label_environment')) {
      this.homey.flow.getDeviceTriggerCard('environment_changed')
        .trigger(this, { environment: petData.environmentLabel })
        .catch(err => this.error('\x1b[31mFailed to trigger environment_changed:\x1b[0m', err));
    }

    // Age changed trigger
    if (changes.has('label_age')) {
      this.homey.flow.getDeviceTriggerCard('age_changed')
        .trigger(this, { age: petData.ageLabel })
        .catch(err => this.error('\x1b[31mFailed to trigger age_changed:\x1b[0m', err));
    }

    // Health concern detected trigger
    if (changes.has('alarm_health_concern') && petData.hasHealthConcerns) {
      const concerns = petData.healthConcernsList?.join(', ');
      if (concerns) {
        this.homey.flow.getDeviceTriggerCard('health_concern_detected')
          .trigger(this, { concerns })
          .catch(err => this.error('\x1b[31mFailed to trigger health_concern_detected:\x1b[0m', err));
      }
    }
  }

  /**
   * Refresh pet data via DataManager
   * @public
   */
  async refreshPetData() {
    try {
      this.log('\x1b[33mRefreshing pet data via DataManager...\x1b[0m');
      const dataManager = this.homey.app.dataManager;
      if (dataManager) {
        // Use DataManager's centralized refresh which will update all pet devices efficiently
        await dataManager.refreshDeviceData(this.getId(), true);
        this.log('\x1b[32mPet data refreshed successfully via DataManager\x1b[0m');
      } else {
        throw new Error('DataManager not available. Please restart the app.');
      }
    } catch (err) {
      this.error('\x1b[31mFailed to refresh pet data:\x1b[0m', err);
    }
  }

  /**
   * Device cleanup when deleted
   */
  onDeleted() {
    this.log('\x1b[33mPet device deleted, cleaning up...\x1b[0m');
    
    // Unregister from DataManager (this also handles weight update unsubscription)
    try {
      const dataManager = this.homey.app.dataManager;
      if (dataManager) {
        dataManager.unregisterDevice(this.getId());
        this.log('\x1b[32mUnregistered from DataManager\x1b[0m');
      }
    } catch (err) {
      this.error('\x1b[31mFailed to unregister from DataManager:\x1b[0m', err);
    }
  }
}