/**
 * Data wrapper for pet information that processes pet data from the API,
 * formats values for display, and performs pet-related calculations.
 * Uses caching to avoid recomputing derived values when the underlying pet data hasn't changed.
 */

const {
  convertLbsToGrams, hasItems, formatStringList, isDateToday, daysUntilDate,
} = require('./utils');

class PetData {
  // ============================================================================
  // CONSTANTS AND CONFIGURATION
  // ============================================================================

  /** Gender mapping constants */
  static GenderMap = Object.freeze({
    MALE: 'Male',
    FEMALE: 'Female',
    UNKNOWN: 'Unknown',
  });

  /** Environment mapping constants */
  static EnvironmentMap = Object.freeze({
    INDOOR: 'Indoor',
    OUTDOOR: 'Outdoor',
    INDOOR_OUTDOOR: 'Indoor & Outdoor',
    UNKNOWN: 'Unknown',
  });

  /** Diet mapping constants */
  static DietMap = Object.freeze({
    DRY_FOOD: 'Dry food',
    WET_FOOD: 'Wet food',
    MIXED_FOOD: 'Mixed food',
    UNKNOWN: 'Unknown',
  });

  /** Centralized error messages for consistent error handling */
  static ErrorMessages = Object.freeze({
    INVALID_PET_DATA: 'Invalid pet data provided. Pet data must be an object.',
    MISSING_PET_ID: 'Pet data is missing required petId field.',
    INVALID_BIRTHDAY: 'Invalid birthday format provided.',
    INVALID_WEIGHT: 'Invalid weight value provided.',
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
      ...settings,
    };

    // Initialize caching to avoid recomputing derived values when pet data hasn't changed
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
    return keyProps.map((prop) => this._pet[prop]).join('|');
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
    return convertLbsToGrams(weightInLbs);
  }

  /**
   * Check if pet has health concerns
   * @param {Array|null} concerns - Health concerns array
   * @returns {boolean} True if pet has health concerns
   */
  static hasHealthConcerns(concerns) {
    return hasItems(concerns);
  }

  /**
   * Calculate age in years from birthday
   * @param {string|null} birthdayStr - Birthday string in ISO format
   * @returns {number} Age in years
   */
  static calculateAge(birthdayStr) {
    if (!birthdayStr) return 0;

    const birthday = new Date(birthdayStr);
    if (Number.isNaN(birthday.getTime())) return 0;

    const now = new Date();
    let age = now.getFullYear() - birthday.getFullYear();
    const hasHadBirthdayThisYear = now.getMonth() > birthday.getMonth()
      || (now.getMonth() === birthday.getMonth() && now.getDate() >= birthday.getDate());

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
    if (Number.isNaN(birth.getTime())) return 'Invalid date';

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
    if (Number.isNaN(date.getTime())) return 'Invalid date';

    const locale = useUSDate ? 'en-US' : undefined;
    return date.toLocaleDateString(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  /**
   * Format breeds array as readable string
   * @param {Array|null} breeds - Array of breed strings
   * @returns {string} Formatted breeds string
   */
  static formatBreeds(breeds) {
    if (!hasItems(breeds)) return 'Unknown';

    return formatStringList(breeds).join(', ');
  }

  /**
   * Format list of items (like health concerns) as readable array
   * @param {Array|null} raw - Raw array of items
   * @returns {Array} Formatted and sorted array
   */
  static formatList(raw) {
    return formatStringList(raw);
  }

  /**
   * Check if birthday is today
   * @param {string|null} birthdayStr - Birthday string in ISO format
   * @returns {boolean} True if birthday is today
   */
  static isBirthdayToday(birthdayStr) {
    return isDateToday(birthdayStr);
  }

  /**
   * Calculate days until next birthday
   * @param {string|null} birthdayStr - Birthday string in ISO format
   * @returns {number|null} Days until birthday or null if invalid
   */
  static calculateDaysUntilBirthday(birthdayStr) {
    return daysUntilDate(birthdayStr);
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

  /** @returns {Object} Raw pet data object */
  get pet() {
    return this._pet;
  }

  /** @returns {string} Pet ID */
  get id() {
    return this._pet.petId;
  }

  /** @returns {string} Pet image URL */
  get imageUrl() {
    return this._pet.s3ImageURL;
  }

  // ============================================================================
  // INSTANCE GETTERS (Computed Values)
  // ============================================================================

  /** @returns {number|null} Weight in pounds */
  get weight() {
    return this._pet.lastWeightReading;
  }

  /** @returns {number|null} Weight in grams */
  get weightInGrams() {
    return PetData.calculateWeightGrams(this._pet.lastWeightReading);
  }

  /** @returns {boolean} Whether pet has health concerns */
  get hasHealthConcerns() {
    return PetData.hasHealthConcerns(this._pet.healthConcerns);
  }

  /** @returns {string} Formatted birthday */
  get birthdayFormatted() {
    return PetData.formatBirthday(this._pet.birthday, {
      useUSDate: this._settings.useUSDate,
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
