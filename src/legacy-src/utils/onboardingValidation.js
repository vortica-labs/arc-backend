const ONBOARDING_USER_TYPES = new Set(['player', 'team']);
const ONBOARDING_GENDERS = new Set(['male', 'female', 'other', 'prefer_not_to_say']);

const parseDateOnly = (value) => {
  if (typeof value !== 'string') return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
};

const getAge = (dob, today) => {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const birthdayHasPassed =
    today.getUTCMonth() > dob.getUTCMonth() ||
    (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() >= dob.getUTCDate());

  if (!birthdayHasPassed) age -= 1;
  return age;
};

/**
 * Shared server-side validation for the profile fields collected by every
 * signup provider. Email/password/OTP are authentication-provider concerns
 * and are intentionally validated outside this helper.
 */
const validateOnboardingProfile = (input = {}, now = new Date()) => {
  const userType = typeof input.userType === 'string' ? input.userType.trim().toLowerCase() : '';
  if (!ONBOARDING_USER_TYPES.has(userType)) {
    return { error: 'User type must be either player or team' };
  }

  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (!displayName || displayName.length > 50) {
    return { error: 'Display name is required and must be less than 50 characters' };
  }

  const gender = input.gender == null ? '' : String(input.gender).trim().toLowerCase();
  if (gender && !ONBOARDING_GENDERS.has(gender)) {
    return { error: 'Gender must be male, female, other, or prefer_not_to_say' };
  }

  let dob = null;
  const rawDob = input.dob == null ? '' : String(input.dob).trim();
  if (rawDob) {
    dob = parseDateOnly(rawDob);
    if (!dob) {
      return { error: 'Please enter a valid date of birth' };
    }

    const age = getAge(dob, now);
    if (age < 13) {
      return { error: 'You must be at least 13 years old' };
    }
    if (age > 100) {
      return { error: 'Please enter a valid date of birth' };
    }
  }

  const bio = input.bio == null ? '' : String(input.bio).trim();
  if (bio.length > 500) {
    return { error: 'Bio cannot exceed 500 characters' };
  }

  return {
    value: {
      userType,
      displayName,
      gender,
      dob,
      bio
    }
  };
};

module.exports = {
  ONBOARDING_GENDERS,
  ONBOARDING_USER_TYPES,
  parseDateOnly,
  validateOnboardingProfile
};
