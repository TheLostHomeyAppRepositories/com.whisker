'use strict';

const Homey = require('homey');
const PetApi = require('../../lib/PetApi');
const PetData = require('../../lib/PetData');

module.exports = class PetDevice extends Homey.Device {

  onInit() {
    this.log('Pet device initialized');

    // Retrieve the petId and tokens from paired device data/settings
    this.petId = this.getData().id;
    const { tokens } = this.getSettings();
    if (!tokens) {
      this.error('No tokens found in device settings; cannot initialize PetApi');
      return;
    }

    // Instantiate the PetApi with Cognito tokens
    this.api = new PetApi({ tokens, log: this.log, error: this.error });

    // Initialize the measure_weight capability to null so Homey UI starts empty
    this.setCapabilityValue('measure_weight', null).catch(() => {});

    // Retrieve poll interval from settings
    const pollIntervalSec = this.getSettings().pollInterval;
    this.log(`Scheduling pet data polling every ${pollIntervalSec} seconds`);
    this._pollInterval = setInterval(this._updatePetData.bind(this), pollIntervalSec * 1000);

    // Perform an immediate first fetch, then poll every pollIntervalSec seconds
    this._updatePetData();
    this._registerFlowCards();
  }

  async _updatePetData() {
    this.log('Polling for pet data, petId=', this.petId);
    try {
      // Fetch all pets for the authenticated user
      const allPets = await this.api.getPets();

      // Find the data for our specific pet
      const pet = allPets.find(p => String(p.petId) === this.petId);
      if (!pet) {
        this.error('Pet not found in fetched data');
        return;
      }
      this.log('Received pet update:', pet);

      const petData = new PetData(pet);
      this.petData = petData;

      await this._updateCapabilities(petData);

    } catch (err) {
      this.error('Failed to update pet data:', err);
    }
  }

  async _updateCapabilities(petData) {
    // Update measure_weight capability
    if (petData.weight != null) {
      const weightGrams = petData.weightGrams;
      const oldWeight = this.getCapabilityValue('measure_weight');
      if (weightGrams !== oldWeight) {
        this.log(`Weight changed: ${oldWeight} → ${weightGrams} g`);
        await this.setCapabilityValue('measure_weight', weightGrams);
      }
    }

    // Update gender label capability
    const oldGender = this.getCapabilityValue('label_gender');
    if (petData.genderLabel !== oldGender) {
      this.log(`Gender changed: ${oldGender} → ${petData.genderLabel}`);
      await this.setCapabilityValue('label_gender', petData.genderLabel);
    }

    // Update food label capability
    const oldDiet = this.getCapabilityValue('label_food');
    if (petData.dietLabel !== oldDiet) {
      this.log(`Diet changed: ${oldDiet} → ${petData.dietLabel}`);
      await this.setCapabilityValue('label_food', petData.dietLabel);
      if (this._dietChangedTrigger && petData.dietLabel !== oldDiet) {
        this._dietChangedTrigger.trigger(this, { diet: petData.dietLabel });
      }
    }

    // Update environment label capability
    const oldEnvironment = this.getCapabilityValue('label_environment');
    if (petData.environmentLabel !== oldEnvironment) {
      this.log(`Environment changed: ${oldEnvironment} → ${petData.environmentLabel}`);
      await this.setCapabilityValue('label_environment', petData.environmentLabel);
    }
    if (this._environmentChangedTrigger && petData.environmentLabel !== oldEnvironment) {
      this._environmentChangedTrigger.trigger(this, { environment: petData.environmentLabel });
    }

    // Update birthday label capability
    const oldBirthday = this.getCapabilityValue('label_birthday');
    if (petData.birthdayFormatted !== oldBirthday) {
      this.log(`Birthday changed: ${oldBirthday} → ${petData.birthdayFormatted}`);
      await this.setCapabilityValue('label_birthday', petData.birthdayFormatted);
    }

    // Update breed label capability
    const oldBreeds = this.getCapabilityValue('label_breed');
    if (petData.breedLabel !== oldBreeds) {
      this.log(`Breeds changed: ${oldBreeds} → ${petData.breedLabel}`);
      await this.setCapabilityValue('label_breed', petData.breedLabel);
    }

    // Update age label capability
    const oldAge = this.getCapabilityValue('label_age');
    const newAge = petData.ageLabel;
    if (newAge !== oldAge) {
      this.log(`Age changed: ${oldAge} → ${newAge}`);
      await this.setCapabilityValue('label_age', newAge);
      if (this._ageChangedTrigger && newAge !== oldAge) {
        this._ageChangedTrigger.trigger(this, { age: newAge });
      }
    }

    // Update health alarm capability (true if any healthConcerns present)
    const oldHealthAlarm = this.getCapabilityValue('alarm_health_concern');
    if (petData.hasHealthConcerns !== oldHealthAlarm) {
      this.log(`Health alarm changed: ${oldHealthAlarm} → ${petData.hasHealthConcerns}`);
      await this.setCapabilityValue('alarm_health_concern', petData.hasHealthConcerns);

      // Trigger flow card when a new health concern appears
      if (petData.hasHealthConcerns && !oldHealthAlarm) {
        const concerns = petData.healthConcernsList.join(', ');
        this.log(`Triggering health concern detected with concerns: ${concerns}`);
        this._healthConcernTrigger.trigger(this, { concerns });
      }
    }
  }

  _registerFlowCards() {
    // Register Flow condition for birthday
    this.homey.flow.getConditionCard('birthday_today')
      .registerRunListener(async ({ device }) => {
        const petData = device.petData;
        const result = petData ? petData.isBirthdayToday : false;
        this.log(
          `birthday_today check for ${petData?.name}: ` +
          `today=${new Date().toISOString()}, ` +
          `birthday="${petData?.birthday}", result=${result}`
        );
        return result;
      });

    // Register Flow trigger for health concern detected
    this._healthConcernTrigger = this.homey.flow.getTriggerCard('health_concern_detected');

    // Register Flow trigger for age changed
    this._ageChangedTrigger = this.homey.flow.getTriggerCard('age_changed');

    // Register Flow condition for days until birthday
    this.homey.flow.getConditionCard('days_until_birthday')
      .registerRunListener(async ({ device, days }) => {
        const threshold = parseInt(days, 10);
        const petData = device.petData;
        const result = petData.isDaysUntilBirthday(threshold);
        this.log(
          `days_until_birthday check for ${petData.name}: ` +
          `remaining=${petData.daysUntilBirthday}, threshold=${threshold}, result=${result}`
        );
        return result;
      });

    this._environmentChangedTrigger = this.homey.flow.getTriggerCard('environment_changed');
    this._dietChangedTrigger = this.homey.flow.getTriggerCard('diet_changed');
  }

  onDeleted() {
    // Clear the polling interval when the device is removed
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

};