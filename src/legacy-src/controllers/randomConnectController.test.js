const assert = require('assert');
const {
  _private: {
    normalizeTags,
    sanitizePreferredGender,
    isPremiumUser,
    buildSessionPolicy,
    scoreCandidate
  }
} = require('./randomConnectController');

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

const currentEntry = {
  userId: id('u1'),
  joinedAt: new Date()
};

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
