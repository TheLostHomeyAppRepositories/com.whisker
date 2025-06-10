class PetData {
  /**
   * Construct PetData instance from raw pet object.
   * @param {object} pet - Raw pet data from API
   */
  constructor(pet) {
    this.petId = pet.petId;
    this.userId = pet.userId;
    this.name = pet.name;
    this.gender = pet.gender;
    this.weight = pet.lastWeightReading;
    this.weightGrams = pet.lastWeightReading != null
      ? Math.round(pet.lastWeightReading * 453.59237)
      : null;
    this.lastWeightReading = pet.lastWeightReading;
    this.birthday = pet.birthday;
    this.birthdayFormatted = this.formatBirthday(pet.birthday);
    this.age = this.calculateAge(pet.birthday);
    this.ageLabel = this.formatAge(pet.birthday);
    this.breeds = pet.breeds;
    this.breedLabel = this.formatBreeds(pet.breeds);
    this.imageUrl = pet.s3ImageURL;
    this.environmentType = pet.environmentType;
    this.isFixed = pet.isFixed;
    this.diet = pet.diet;
    this.isActive = pet.isActive;
    this.healthConcerns = pet.healthConcerns;
    this.hasHealthConcerns = Array.isArray(pet.healthConcerns) && pet.healthConcerns.length > 0;
    this.healthConcernsList = this.formatList(pet.healthConcerns);
    this.genderLabel = this.mapGender(pet.gender);
    this.environmentLabel = this.mapEnvironment(pet.environmentType);
    this.dietLabel = this.mapDiet(pet.diet);
  }

  get isBirthdayToday() {
    if (!this.birthday) return false;
    const today = new Date();
    // Extract year-month-day from birthday string "YYYY-MM-DD HH:MM:SS.sss"
    const [year, month, day] = this.birthday.split(' ')[0].split('-').map(Number);
    // month is 1-based in the parsed string, but Date.getMonth() returns 0-based
    return today.getDate() === day && (today.getMonth() + 1) === month;
  }

  get daysUntilBirthday() {
    if (!this.birthday) return null;
    const today = new Date();
    const birthDate = new Date(this.birthday);
    const nextBirthday = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());

    if (nextBirthday < today) {
      nextBirthday.setFullYear(nextBirthday.getFullYear() + 1);
    }

    const diffMs = nextBirthday - today;
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  }

  /**
   * Check if the number of days until the next birthday matches the given threshold.
   * @param {number} threshold
   * @returns {boolean}
   */
  isDaysUntilBirthday(threshold) {
    const days = this.daysUntilBirthday;
    return days != null && days === threshold;
  }

  mapGender(gender) {
    switch (gender) {
      case 'MALE': return 'Male';
      case 'FEMALE': return 'Female';
      default: return 'Unknown';
    }
  }

  mapEnvironment(env) {
    switch (env) {
      case 'INDOOR': return 'Indoor';
      case 'OUTDOOR': return 'Outdoor';
      case 'INDOOR_OUTDOOR': return 'Indoor & Outdoor';
      default: return 'Unknown';
    }
  }

  mapDiet(diet) {
    switch (diet) {
      case 'DRY_FOOD': return 'Dry food';
      case 'WET_FOOD': return 'Wet food';
      case 'MIXED_FOOD': return 'Mixed food';
      default: return 'Unknown';
    }
  }

  formatBirthday(dateStr) {
    if (!dateStr) return 'Unknown';
    const date = new Date(dateStr);
    if (isNaN(date)) return 'Invalid date';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  formatBreeds(breeds) {
    if (!Array.isArray(breeds) || breeds.length === 0) return 'Unknown';
    return breeds.map(b => {
      return b
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }).join(', ');
  }

  calculateAge(birthdayStr) {
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
   * Convert an array of raw strings into a sorted, human-readable list.
   * @param {string[]} raw
   * @returns {string[]}
   */
  formatList(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    return raw
      .map(item => item
        .toLowerCase()
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')
      )
      .sort((a, b) => a.localeCompare(b));
  }

    /**
   * Format age as "X years" or "Y months" if less than one year.
   * @param {string} birthdayStr
   * @returns {string}
   */
  formatAge(birthdayStr) {
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
}

module.exports = PetData;
