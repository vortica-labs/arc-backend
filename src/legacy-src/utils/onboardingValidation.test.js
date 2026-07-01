const assert = require('assert');
const { parseDateOnly, validateOnboardingProfile } = require('./onboardingValidation');

const now = new Date('2026-07-01T12:00:00.000Z');

const valid = validateOnboardingProfile({
  userType: ' TEAM ',
  displayName: '  ARC Team  ',
  gender: 'PREFER_NOT_TO_SAY',
  dob: '2000-02-29',
  bio: '  Competitive team  '
}, now);

assert.deepStrictEqual(valid.value, {
  userType: 'team',
  displayName: 'ARC Team',
  gender: 'prefer_not_to_say',
  dob: new Date('2000-02-29T00:00:00.000Z'),
  bio: 'Competitive team'
});

const optional = validateOnboardingProfile({
  userType: 'player',
  displayName: 'Player'
}, now);
assert.strictEqual(optional.error, undefined);
assert.strictEqual(optional.value.gender, '');
assert.strictEqual(optional.value.dob, null);
assert.strictEqual(optional.value.bio, '');

assert.strictEqual(parseDateOnly('2024-02-30'), null);
assert.strictEqual(
  validateOnboardingProfile({ userType: 'player', displayName: 'Player', dob: '2024-02-30' }, now).error,
  'Please enter a valid date of birth'
);
assert.strictEqual(
  validateOnboardingProfile({ userType: 'player', displayName: 'Player', dob: '2013-07-02' }, now).error,
  'You must be at least 13 years old'
);
assert.strictEqual(
  validateOnboardingProfile({ userType: 'player', displayName: 'Player', dob: '1925-06-30' }, now).error,
  'Please enter a valid date of birth'
);
assert.strictEqual(
  validateOnboardingProfile({ userType: 'creator', displayName: 'Player' }, now).error,
  'User type must be either player or team'
);
assert.strictEqual(
  validateOnboardingProfile({ userType: 'player', displayName: '' }, now).error,
  'Display name is required and must be less than 50 characters'
);
assert.strictEqual(
  validateOnboardingProfile({ userType: 'player', displayName: 'Player', gender: 'unknown' }, now).error,
  'Gender must be male, female, other, or prefer_not_to_say'
);
assert.strictEqual(
  validateOnboardingProfile({ userType: 'player', displayName: 'Player', bio: 'x'.repeat(501) }, now).error,
  'Bio cannot exceed 500 characters'
);

console.log('Onboarding validation tests passed');
