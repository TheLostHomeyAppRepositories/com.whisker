'use strict';

/**
 * PetData is a wrapper around pet information and API data, providing
 * methods to interpret pet data and manage pet-related calculations.
 * 
 * This class handles all data transformation, formatting, and calculations
 * for pet information from the Whisker API.
 */
class PetData {
  // ============================================================================
  // CONSTANTS AND CONFIGURATION
  // ============================================================================

  /** Default configuration values */
  static Defaults = Object.freeze({
    LBS_TO_GRAMS: 453.59237,
    DEFAULT_TIMEZONE: 'UTC'
  });

  /** Gender mapping constants */
  static GenderMap = Object.freeze({
    MALE: 'Male',
    FEMALE: 'Female',
    UNKNOWN: 'Unknown'
  });

  /** Environment mapping constants */
  static EnvironmentMap = Object.freeze({
    INDOOR: 'Indoor',
    OUTDOOR: 'Outdoor',
    INDOOR_OUTDOOR: 'Indoor & Outdoor',
    UNKNOWN: 'Unknown'
  });

  /** Diet mapping constants */
  static DietMap = Object.freeze({
    DRY_FOOD: 'Dry food',
    WET_FOOD: 'Wet food',
    MIXED_FOOD: 'Mixed food',
    UNKNOWN: 'Unknown'
  });

  /** Error messages for better consistency and maintenance */
  static ErrorMessages = Object.freeze({
    INVALID_PET_DATA: 'Invalid pet data provided. Pet data must be an object.',
    MISSING_PET_ID: 'Pet data is missing required petId field.',
    INVALID_BIRTHDAY: 'Invalid birthday format provided.',
    INVALID_WEIGHT: 'Invalid weight value provided.'
  });

  // ============================================================================
  // CONSTRUCTOR AND INITIALIZATION
  // ============================================================================

  /**
   * Creates a new PetData instance
   * @param {Object} params
   * @param {Object} params.pet - Pet data object from API
   * @param {Object} [params.settings={}] - Optional settings for formatting
   * @throws {Error} If required parameters are missing or invalid
   */
  constructor({ pet, settings = {} } = {}) {
    // Validate required parameters
    if (!pet || typeof pet !== 'object') {
      throw new Error(PetData.ErrorMessages.INVALID_PET_DATA);
    }
    if (!pet.petId) {
      throw new Error(PetData.ErrorMessages.MISSING_PET_ID);
    }

    this._pet = pet;
    this._settings = {
      use12hFormat: false,
      useUSDate: false,
      ...settings
    };

    // Cache frequently accessed values for performance
    this._cachedAge = null;
    this._cachedBirthdayInfo = null;
    this._lastPetHash = this._computePetHash();
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Computes a simple hash of pet data for change detection
   * @private
   * @returns {string} Hash string
   */
  _computePetHash() {
    const keyProps = ['petId', 'name', 'birthday', 'lastWeightReading', 'isActive'];
    return keyProps.map(prop => this._pet[prop]).join('|');
  }

  /**
   * Checks if pet data has changed and invalidates cache if needed
   * @private
   */
  _invalidateCacheIfNeeded() {
    const currentHash = this._computePetHash();
    if (currentHash !== this._lastPetHash) {
      this._cachedAge = null;
      this._cachedBirthdayInfo = null;
      this._lastPetHash = currentHash;
    }
  }

  // ============================================================================
  // STATIC HELPER METHODS
  // ============================================================================

  /**
   * Calculate weight in grams from pounds
   * @param {number|null} weightInLbs - Weight in pounds
   * @returns {number|null} Weight in grams or null if invalid
   */
  static calculateWeightGrams(weightInLbs) {
    if (weightInLbs == null || isNaN(weightInLbs)) return null;
    return Math.round(weightInLbs * PetData.Defaults.LBS_TO_GRAMS);
  }

  /**
   * Check if pet has health concerns
   * @param {Array|null} concerns - Health concerns array
   * @returns {boolean} True if pet has health concerns
   */
  static hasHealthConcerns(concerns) {
    return Array.isArray(concerns) && concerns.length > 0;
  }

  /**
   * Calculate age in years from birthday
   * @param {string|null} birthdayStr - Birthday string in ISO format
   * @returns {number} Age in years
   */
  static calculateAge(birthdayStr) {
    if (!birthdayStr) return 0;
    
    const birthday = new Date(birthdayStr);
    if (isNaN(birthday)) return 0;
    
    const now = new Date();
    let age = now.getFullYear() - birthday.getFullYear();
    const hasHadBirthdayThisYear =
      now.getMonth() > birthday.getMonth() ||
      (now.getMonth() === birthday.getMonth() && now.getDate() >= birthday.getDate());
    
    if (!hasHadBirthdayThisYear) {
      age--;
    }
    
    return age;
  }

  /**
   * Format age as human-readable string
   * @param {string|null} birthdayStr - Birthday string in ISO format
   * @returns {string} Formatted age string
   */
  static formatAge(birthdayStr) {
    if (!birthdayStr) return 'Unknown';
    
    const birth = new Date(birthdayStr);
    if (isNaN(birth)) return 'Invalid date';
    
    const now = new Date();
    let years = now.getFullYear() - birth.getFullYear();
    let months = now.getMonth() - birth.getMonth();
    
    if (now.getDate() < birth.getDate()) months--;
    if (months < 0) {
      years--;
      months += 12;
    }
    
    if (years < 1) {
      return `${months} month${months !== 1 ? 's' : ''}`;
    }
    
    return `${years} year${years !== 1 ? 's' : ''}`;
  }

  /**
   * Format birthday as localized date string
   * @param {string|null} dateStr - Birthday string in ISO format
   * @param {Object} opts - Formatting options
   * @param {boolean} [opts.useUSDate=false] - Force US date format
   * @returns {string} Formatted birthday string
   */
  static formatBirthday(dateStr, { useUSDate = false } = {}) {
    if (!dateStr) return 'Unknown';
    
    const date = new Date(dateStr);
    if (isNaN(date)) return 'Invalid date';
    
    const locale = useUSDate ? 'en-US' : undefined;
    return date.toLocaleDateString(locale, { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  }

  /**
   * Format breeds array as readable string
   * @param {Array|null} breeds - Array of breed strings
   * @returns {string} Formatted breeds string
   */
  static formatBreeds(breeds) {
    if (!Array.isArray(breeds) || breeds.length === 0) return 'Unknown';
    
    return breeds.map(breed => {
      return breed
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }).join(', ');
  }

  /**
   * Format list of items (like health concerns) as readable array
   * @param {Array|null} raw - Raw array of items
   * @returns {Array} Formatted and sorted array
   */
  static formatList(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    
    return raw
      .map(item => item
        .toLowerCase()
        .split('_')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
      )
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * Check if birthday is today
   * @param {string|null} birthdayStr - Birthday string in ISO format
   * @returns {boolean} True if birthday is today
   */
  static isBirthdayToday(birthdayStr) {
    if (!birthdayStr) return false;
    
    const today = new Date();
    const [year, month, day] = birthdayStr.split(' ')[0].split('-').map(Number);
    return today.getDate() === day && (today.getMonth() + 1) === month;
  }

  /**
   * Calculate days until next birthday
   * @param {string|null} birthdayStr - Birthday string in ISO format
   * @returns {number|null} Days until birthday or null if invalid
   */
  static calculateDaysUntilBirthday(birthdayStr) {
    if (!birthdayStr) return null;
    
    const today = new Date();
    const birthDate = new Date(birthdayStr);
    const nextBirthday = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());

    if (nextBirthday < today) {
      nextBirthday.setFullYear(nextBirthday.getFullYear() + 1);
    }

    const diffMs = nextBirthday - today;
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  // ============================================================================
  // MAPPING METHODS
  // ============================================================================

  /**
   * Map gender value to display string
   * @param {string} gender - Raw gender value
   * @returns {string} Mapped gender string
   */
  static mapGender(gender) {
    return PetData.GenderMap[gender] || PetData.GenderMap.UNKNOWN;
  }

  /**
   * Map environment type to display string
   * @param {string} env - Raw environment value
   * @returns {string} Mapped environment string
   */
  static mapEnvironment(env) {
    return PetData.EnvironmentMap[env] || PetData.EnvironmentMap.UNKNOWN;
  }

  /**
   * Map diet type to display string
   * @param {string} diet - Raw diet value
   * @returns {string} Mapped diet string
   */
  static mapDiet(diet) {
    return PetData.DietMap[diet] || PetData.DietMap.UNKNOWN;
  }

  // ============================================================================
  // INSTANCE GETTERS (Basic Properties)
  // ============================================================================

  /** @returns {string} Pet ID */
  get id() { return this._pet.petId; }

  /** @returns {string} User ID */
  get userId() { return this._pet.userId; }

  /** @returns {string} Pet name */
  get name() { return this._pet.name; }

  /** @returns {string} Pet gender */
  get gender() { return this._pet.gender; }

  /** @returns {string} Pet birthday */
  get birthday() { return this._pet.birthday; }

  /** @returns {Array} Pet breeds */
  get breeds() { return this._pet.breeds; }

  /** @returns {string} Pet image URL */
  get imageUrl() { return this._pet.s3ImageURL; }

  /** @returns {string} Environment type */
  get environmentType() { return this._pet.environmentType; }

  /** @returns {boolean} Whether pet is fixed */
  get isFixed() { return this._pet.isFixed; }

  /** @returns {string} Pet diet */
  get diet() { return this._pet.diet; }

  /** @returns {boolean} Whether pet is active */
  get isActive() { return this._pet.isActive; }

  /** @returns {Array} Health concerns */
  get healthConcerns() { return this._pet.healthConcerns; }

  // ============================================================================
  // INSTANCE GETTERS (Computed Values)
  // ============================================================================

  /** @returns {number|null} Weight in pounds */
  get weight() { return this._pet.lastWeightReading; }

  /** @returns {number|null} Weight in grams */
  get weightInGrams() {
    return PetData.calculateWeightGrams(this._pet.lastWeightReading);
  }

  /** @returns {number|null} Last weight reading */
  get lastWeightReading() { return this._pet.lastWeightReading; }

  /** @returns {boolean} Whether pet has health concerns */
  get hasHealthConcerns() {
    return PetData.hasHealthConcerns(this._pet.healthConcerns);
  }

  /** @returns {string} Formatted birthday */
  get birthdayFormatted() {
    return PetData.formatBirthday(this._pet.birthday, {
      useUSDate: this._settings.useUSDate
    });
  }

  /** @returns {number} Pet age in years */
  get age() {
    this._invalidateCacheIfNeeded();
    if (this._cachedAge === null) {
      this._cachedAge = PetData.calculateAge(this._pet.birthday);
    }
    return this._cachedAge;
  }

  /** @returns {string} Formatted age string */
  get ageLabel() {
    return PetData.formatAge(this._pet.birthday);
  }

  /** @returns {string} Formatted breeds string */
  get breedLabel() {
    return PetData.formatBreeds(this._pet.breeds);
  }

  /** @returns {Array} Formatted health concerns list */
  get healthConcernsList() {
    return PetData.formatList(this._pet.healthConcerns);
  }

  /** @returns {string} Mapped gender label */
  get genderLabel() {
    return PetData.mapGender(this._pet.gender);
  }

  /** @returns {string} Mapped environment label */
  get environmentLabel() {
    return PetData.mapEnvironment(this._pet.environmentType);
  }

  /** @returns {string} Mapped diet label */
  get dietLabel() {
    return PetData.mapDiet(this._pet.diet);
  }

  /** @returns {boolean} Whether birthday is today */
  get isBirthdayToday() {
    return PetData.isBirthdayToday(this._pet.birthday);
  }

  /** @returns {number|null} Days until next birthday */
  get daysUntilBirthday() {
    this._invalidateCacheIfNeeded();
    if (this._cachedBirthdayInfo === null) {
      this._cachedBirthdayInfo = PetData.calculateDaysUntilBirthday(this._pet.birthday);
    }
    return this._cachedBirthdayInfo;
  }

  // ============================================================================
  // INSTANCE METHODS
  // ============================================================================

  /**
   * Check if the number of days until the next birthday matches the given threshold
   * @param {number} threshold - Days threshold to check
   * @returns {boolean} True if days until birthday matches threshold
   */
  isDaysUntilBirthday(threshold) {
    const days = this.daysUntilBirthday;
    return days != null && days === threshold;
  }

  /**
   * Update pet data directly (for API updates)
   * @param {Object} newPetData - Updated pet data
   */
  updatePetData(newPetData) {
    if (!newPetData || typeof newPetData !== 'object') {
      throw new Error(PetData.ErrorMessages.INVALID_PET_DATA);
    }
    
    this._pet = { ...this._pet, ...newPetData };
    this._invalidateCacheIfNeeded();
  }
}

module.exports = PetData;
