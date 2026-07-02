const assert = require('assert');
const fs = require('fs');
const {
  _private: {
    normalizeTags,
    sanitizePreferredGender,
    normalizeMatchmakingGender,
    evaluateGenderCompatibility,
    buildGenderCandidateQuery,
    buildCompatiblePreferenceQuery,
    isPremiumUser,
    buildSessionPolicy,
    buildConnectionPayload,
    scoreCandidate,
    buildGenderFilterUserIds,
    canPrivacyMatchUsers
  }
} = require('./randomConnectController');
const RandomConnection = require('../models/RandomConnection');
const ConnectionQueue = require('../models/ConnectionQueue');
const mongoose = require('mongoose');

const id = (value) => ({ toString: () => value });

const freeUser = {
  isPremium: false,
  membership: { tier: 'free', validUntil: null }
};

const premiumUser = {
  isPremium: true,
  membership: { tier: 'player_pro', validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) }
};

const expiredPremiumUser = {
  isPremium: true,
  membership: { tier: 'player_pro', validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) }
};

assert.deepStrictEqual(normalizeTags([' Anime ', 'anime', 'Gaming', '', 'a'.repeat(31)]), ['anime', 'gaming']);
assert.strictEqual(sanitizePreferredGender('male'), 'male');
assert.strictEqual(sanitizePreferredGender('other'), '');
assert.strictEqual(sanitizePreferredGender(' Male '), 'male');
assert.strictEqual(sanitizePreferredGender('F'), 'female');
assert.strictEqual(sanitizePreferredGender('Anyone'), '');
assert.strictEqual(normalizeMatchmakingGender(' M '), 'male');
assert.strictEqual(normalizeMatchmakingGender('FEMALE '), 'female');
assert.strictEqual(normalizeMatchmakingGender(undefined), '');
assert(buildGenderCandidateQuery('male').test(' Male '));
assert(buildGenderCandidateQuery('F').test(' female '));
const reciprocalQuery = buildCompatiblePreferenceQuery(' Male ');
assert.strictEqual(reciprocalQuery.$or.length, 4);
assert(reciprocalQuery.$or[3].preferredGender.test(' M '));
assert.strictEqual(buildCompatiblePreferenceQuery('').$or.length, 3);

const normalizedQueueEntry = new ConnectionQueue({
  userId: new mongoose.Types.ObjectId(),
  gender: ' Male ',
  preferredGender: ' F '
});
assert.strictEqual(normalizedQueueEntry.gender, 'male');
assert.strictEqual(normalizedQueueEntry.preferredGender, 'female');

const authControllerSource = fs.readFileSync(require.resolve('./authController'), 'utf8');
const updateProfileStart = authControllerSource.indexOf('const updateProfile = async');
const liveQueueSync = authControllerSource.indexOf('ConnectionQueue.updateMany', updateProfileStart);
const changePasswordStart = authControllerSource.indexOf('const changePassword = async');
assert(updateProfileStart >= 0 && liveQueueSync > updateProfileStart && liveQueueSync < changePasswordStart);

assert.strictEqual(isPremiumUser(freeUser), false);
assert.strictEqual(isPremiumUser(premiumUser), true);
assert.strictEqual(isPremiumUser(expiredPremiumUser), false);

assert.deepStrictEqual(buildSessionPolicy(freeUser, freeUser), {
  isLimited: true,
  durationLimitSeconds: 180,
  limitReason: 'free_to_free'
});
assert.deepStrictEqual(buildSessionPolicy(premiumUser, freeUser), {
  isLimited: false,
  durationLimitSeconds: null,
  limitReason: 'premium_unlimited'
});

const privacyUserA = { _id: id('privacy-a'), isActive: true, blockedUsers: [] };
const privacyUserB = { _id: id('privacy-b'), isActive: true, blockedUsers: [] };
assert.strictEqual(canPrivacyMatchUsers(privacyUserA, privacyUserB), true);
assert.strictEqual(
  canPrivacyMatchUsers({ ...privacyUserA, blockedUsers: [privacyUserB._id] }, privacyUserB),
  false,
  'Random Connect must exclude users blocked by the seeker'
);
assert.strictEqual(
  canPrivacyMatchUsers(privacyUserA, { ...privacyUserB, blockedUsers: [privacyUserA._id] }),
  false,
  'Random Connect must exclude users who blocked the seeker'
);
assert.strictEqual(
  canPrivacyMatchUsers(privacyUserA, { ...privacyUserB, isActive: false }),
  false,
  'Random Connect must exclude inactive queue users'
);

const publicConnectionPayload = buildConnectionPayload({
  roomId: 'privacy-room',
  status: 'active',
  participants: [{
    userId: id('privacy-a'),
    username: 'privacy-a',
    displayName: 'Privacy A',
    avatar: 'avatar.png',
    videoEnabled: true,
    isPremium: true,
    membershipTier: 'player_pro'
  }]
});
assert.strictEqual(publicConnectionPayload.participants[0].isPremium, undefined);
assert.strictEqual(publicConnectionPayload.participants[0].membershipTier, undefined);

const filteredUser = id('filter-user');
const unfilteredUser = id('no-filter-user');
const alsoFilteredUser = id('also-filter-user');
assert.deepStrictEqual(
  buildGenderFilterUserIds(
    { userId: filteredUser, preferredGender: 'female' },
    { userId: unfilteredUser, preferredGender: '' },
    { userId: alsoFilteredUser, preferredGender: 'male' },
    { userId: filteredUser, preferredGender: 'female' }
  ),
  [filteredUser, alsoFilteredUser],
  'quota attribution must include only users who selected a gender filter and deduplicate them'
);

const randomConnectionIndexes = RandomConnection.schema.indexes();
assert(
  randomConnectionIndexes.some(([fields]) => fields.genderFilterUserIds === 1 && fields.status === 1 && fields.startTime === -1),
  'RandomConnection must index per-user gender-filter quota lookups'
);

const currentEntry = {
  userId: id('u1'),
  joinedAt: new Date()
};

const compatibleGenderPairs = [
  [{ gender: 'male', preferredGender: 'male' }, { gender: 'male', preferredGender: 'male' }],
  [{ gender: 'male', preferredGender: 'female' }, { gender: 'female', preferredGender: 'male' }],
  [{ gender: 'female', preferredGender: 'male' }, { gender: 'male', preferredGender: 'female' }],
  [{ gender: 'female', preferredGender: 'female' }, { gender: 'female', preferredGender: 'female' }],
  [{ gender: 'male', preferredGender: '' }, { gender: 'female', preferredGender: '' }],
  [{ gender: 'female', preferredGender: '' }, { gender: 'male', preferredGender: '' }],
  [{ gender: 'female', preferredGender: 'male' }, { gender: ' Male ', preferredGender: '' }]
];
for (const platformPair of ['web-web', 'web-mobile', 'mobile-web', 'mobile-mobile']) {
  for (const subscriptionPair of ['free-free', 'premium-premium', 'free-premium', 'premium-free']) {
    for (const [seeker, candidate] of compatibleGenderPairs) {
      assert.strictEqual(
        evaluateGenderCompatibility(
          { ...seeker, platformPair, subscriptionPair },
          { ...candidate, platformPair, subscriptionPair }
        ).compatible,
        true,
        `${platformPair}/${subscriptionPair} should preserve compatible mutual gender preferences`
      );
    }
  }
}

assert.strictEqual(
  evaluateGenderCompatibility(
    { gender: 'female', preferredGender: 'female' },
    { gender: 'male', preferredGender: '' }
  ).reason,
  'seeker_preference_mismatch'
);
assert.strictEqual(
  evaluateGenderCompatibility(
    { gender: 'male', preferredGender: '' },
    { gender: 'female', preferredGender: 'female' }
  ).reason,
  'candidate_preference_mismatch'
);

const exact = scoreCandidate({
  currentEntry,
  candidate: { userId: id('u2'), tags: ['anime', 'gaming'], joinedAt: new Date() },
  tags: ['anime', 'gaming'],
  selectedGame: null,
  currentGender: 'male',
  allowFallback: false,
  recentPartnerIds: new Set()
});
assert.strictEqual(exact.matchQuality, 'exact_tag');
assert.deepStrictEqual(exact.commonTags, ['anime', 'gaming']);

const reciprocalMismatch = scoreCandidate({
  currentEntry,
  candidate: { userId: id('u3'), tags: ['anime'], preferredGender: 'female', joinedAt: new Date() },
  tags: ['anime'],
  selectedGame: null,
  currentGender: 'male',
  allowFallback: false,
  recentPartnerIds: new Set()
});
assert.strictEqual(reciprocalMismatch, null);

const seekerMismatch = scoreCandidate({
  currentEntry: { userId: id('u1'), gender: 'female', preferredGender: 'female', joinedAt: new Date() },
  candidate: { userId: id('u3b'), gender: 'male', preferredGender: '', joinedAt: new Date() },
  tags: [],
  selectedGame: null,
  currentGender: 'female',
  allowFallback: true,
  recentPartnerIds: new Set()
});
assert.strictEqual(seekerMismatch, null);

const normalizedReciprocalMatch = scoreCandidate({
  currentEntry: { userId: id('u1'), gender: ' Male ', preferredGender: '', joinedAt: new Date() },
  candidate: { userId: id('u3c'), gender: 'female', preferredGender: 'M', joinedAt: new Date() },
  tags: [],
  selectedGame: null,
  currentGender: ' Male ',
  allowFallback: true,
  recentPartnerIds: new Set()
});
assert.notStrictEqual(normalizedReciprocalMatch, null);

const noFallback = scoreCandidate({
  currentEntry,
  candidate: { userId: id('u4'), tags: ['sports'], joinedAt: new Date() },
  tags: ['anime'],
  selectedGame: null,
  currentGender: 'male',
  allowFallback: false,
  recentPartnerIds: new Set()
});
assert.strictEqual(noFallback, null);

const expanded = scoreCandidate({
  currentEntry,
  candidate: { userId: id('u5'), tags: ['sports'], joinedAt: new Date() },
  tags: ['anime'],
  selectedGame: null,
  currentGender: 'male',
  allowFallback: true,
  recentPartnerIds: new Set()
});
assert.strictEqual(expanded.matchQuality, 'expanded');

const recentBlocked = scoreCandidate({
  currentEntry,
  candidate: { userId: id('u6'), tags: ['anime'], joinedAt: new Date() },
  tags: ['anime'],
  selectedGame: null,
  currentGender: 'male',
  allowFallback: false,
  recentPartnerIds: new Set(['u6'])
});
assert.strictEqual(recentBlocked, null);

console.log('Random Connect controller tests passed');
