const assert = require('assert');
const {
  _private: { canAccessChallengeVisibility, serializeChallenge }
} = require('./challengeController');

assert.strictEqual(canAccessChallengeVisibility({ visibility: 'public' }), true);
assert.strictEqual(canAccessChallengeVisibility({ visibility: 'followers', isFollower: true }), true);
assert.strictEqual(canAccessChallengeVisibility({ visibility: 'followers', isFollower: false }), false);
assert.strictEqual(canAccessChallengeVisibility({ visibility: 'private', isFollower: true }), false);
assert.strictEqual(canAccessChallengeVisibility({ visibility: 'private', isSelf: true }), true);
assert.strictEqual(
  canAccessChallengeVisibility({ visibility: null, isFollower: true }),
  false,
  'malformed challenge visibility must fail closed'
);

const publicChallenge = serializeChallenge({
  _id: 'challenge-1',
  creator: {
    _id: 'creator-1',
    username: 'creator',
    email: 'must-not-leak@example.com',
    lastSeen: new Date(),
    blockedUsers: ['blocked-user'],
    privacySettings: { profileVisibility: 'private' },
    profile: { displayName: 'Creator', avatar: 'creator.png', bio: 'protected' }
  },
  participants: [{
    user: { _id: 'participant-1', username: 'participant', email: 'participant@example.com' },
    progress: { currentValue: 99 }
  }]
});
assert.strictEqual(publicChallenge.participants, undefined);
assert.strictEqual(publicChallenge.participantCount, 1);
assert.strictEqual(publicChallenge.creator.email, undefined);
assert.strictEqual(publicChallenge.creator.lastSeen, undefined);
assert.strictEqual(publicChallenge.creator.privacySettings, undefined);
assert.strictEqual(publicChallenge.creator.profile.bio, undefined);

console.log('Challenge privacy tests passed');
