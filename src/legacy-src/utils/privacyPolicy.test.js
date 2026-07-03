const assert = require('assert');
const mongoose = require('mongoose');
const User = require('../models/User');
const Follow = require('../models/Follow');
const FollowRequest = require('../models/FollowRequest');
const {
  idString,
  normalizePrivacySettings,
  canonicalToLegacyAliases,
  buildPrivacyAccess,
  resolvePrivacyAccess,
  filterPostsForViewer,
  minimalProfile,
  privacySettingsResponse
} = require('./privacyPolicy');
const { formatUserDTO } = require('./dto');
const { publishPrivacySettingsUpdate, removePresenceSubscription } = require('./presencePrivacy');

const objectId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
assert.strictEqual(idString(objectId), '507f1f77bcf86cd799439011');
assert.strictEqual(idString({ _id: objectId }), '507f1f77bcf86cd799439011');
assert.strictEqual(idString(new User({
  _id: objectId,
  username: 'identity_contract',
  userType: 'player'
})), '507f1f77bcf86cd799439011');

assert.deepStrictEqual(normalizePrivacySettings({}), {
  profileVisibility: 'public',
  allowMessageFrom: 'everyone',
  showOnlineStatus: true,
  allowFollowRequests: true,
  showPostsToFollowers: true
});

assert.deepStrictEqual(normalizePrivacySettings({
  accountType: 'private',
  whoCanMessage: 'people_you_follow',
  showActivityStatus: false
}), {
  profileVisibility: 'private',
  allowMessageFrom: 'followers',
  showOnlineStatus: false,
  allowFollowRequests: true,
  showPostsToFollowers: true
});

assert.deepStrictEqual(normalizePrivacySettings({
  profileVisibility: 'invalid',
  accountType: 'public',
  allowMessageFrom: 'invalid',
  whoCanMessage: 'anyone',
  showOnlineStatus: 'invalid',
  showActivityStatus: true,
  allowFollowRequests: 'false',
  showPostsToFollowers: 'false'
}), {
  profileVisibility: 'private',
  allowMessageFrom: 'none',
  showOnlineStatus: false,
  allowFollowRequests: false,
  showPostsToFollowers: false
});

assert.deepStrictEqual(normalizePrivacySettings({
  profileVisibility: null,
  accountType: 'public',
  allowMessageFrom: null,
  whoCanMessage: 'anyone',
  showOnlineStatus: null,
  showActivityStatus: true
}), {
  profileVisibility: 'private',
  allowMessageFrom: 'none',
  showOnlineStatus: false,
  allowFollowRequests: true,
  showPostsToFollowers: true
});

assert.deepStrictEqual(normalizePrivacySettings({
  profileVisibility: 'invalid',
  allowMessageFrom: 'invalid',
  showOnlineStatus: 'invalid',
  allowFollowRequests: 'invalid',
  showPostsToFollowers: 'invalid'
}), {
  profileVisibility: 'private',
  allowMessageFrom: 'none',
  showOnlineStatus: false,
  allowFollowRequests: false,
  showPostsToFollowers: false
});

assert.deepStrictEqual(canonicalToLegacyAliases({
  profileVisibility: 'followers',
  allowMessageFrom: 'none',
  showOnlineStatus: false,
  allowFollowRequests: false,
  showPostsToFollowers: false
}), {
  accountType: 'private',
  whoCanMessage: 'nobody',
  showActivityStatus: false
});

const publicAccess = buildPrivacyAccess({ settings: { profileVisibility: 'public' } });
assert.strictEqual(publicAccess.canViewProfile, true);
assert.strictEqual(publicAccess.canViewPosts, true);

for (const profileVisibility of ['followers', 'private']) {
  const stranger = buildPrivacyAccess({ settings: { profileVisibility } });
  assert.strictEqual(stranger.restricted, true);
  assert.strictEqual(stranger.canViewProfile, false);
  assert.strictEqual(stranger.canViewPosts, false);
  assert.strictEqual(stranger.reason, profileVisibility === 'private' ? 'private_account' : 'followers_only');

  const follower = buildPrivacyAccess({ settings: { profileVisibility }, isFollower: true });
  assert.strictEqual(follower.canViewProfile, true);
  assert.strictEqual(follower.canViewPosts, true);
}

const postsHidden = buildPrivacyAccess({
  settings: { profileVisibility: 'public', showPostsToFollowers: false }
});
assert.strictEqual(postsHidden.canViewProfile, true);
assert.strictEqual(postsHidden.canViewPosts, false);
assert.strictEqual(postsHidden.canViewClips, false);
assert.strictEqual(postsHidden.reason, 'posts_hidden');

// Corrupted persisted values must never widen access. Missing values retain
// the historical public default, while present malformed values fail closed.
const malformedVisibility = buildPrivacyAccess({
  settings: { profileVisibility: 'unexpected-value' }
});
assert.strictEqual(malformedVisibility.canViewProfile, false);
assert.strictEqual(malformedVisibility.canViewPosts, false);

assert.strictEqual(buildPrivacyAccess({ settings: { allowMessageFrom: 'everyone' } }).canMessage, true);
assert.strictEqual(buildPrivacyAccess({ settings: { allowMessageFrom: 'followers' } }).canMessage, false);
assert.strictEqual(buildPrivacyAccess({ settings: { allowMessageFrom: 'followers' }, isFollower: true }).canMessage, true);
assert.strictEqual(buildPrivacyAccess({ settings: { allowMessageFrom: 'none' } }).canMessage, false);
assert.strictEqual(buildPrivacyAccess({ settings: { allowMessageFrom: 'none' }, existingConversation: true }).canMessage, true);
assert.strictEqual(buildPrivacyAccess({ settings: { showOnlineStatus: false } }).canSeeOnlineStatus, false);
assert.strictEqual(buildPrivacyAccess({ settings: { allowFollowRequests: false } }).canFollow, false);

const blocked = buildPrivacyAccess({ settings: {}, blocked: true, existingConversation: true, isFollower: true });
assert.strictEqual(blocked.canViewProfile, false);
assert.strictEqual(blocked.canMessage, false);
assert.strictEqual(blocked.canFollow, false);
assert.strictEqual(blocked.reason, 'blocked');

const minimal = minimalProfile({
  _id: 'u1',
  username: 'private_user',
  userType: 'player',
  email: 'secret@example.com',
  lastSeen: new Date(),
  profile: { displayName: 'Private User', avatar: 'avatar.jpg', bio: 'secret', location: 'secret' },
  privacySettings: { profileVisibility: 'private' }
});
assert.deepStrictEqual(Object.keys(minimal).sort(), ['_id', 'avatar', 'profile', 'profilePicture', 'userType', 'username']);
assert.deepStrictEqual(minimal.profile, { displayName: 'Private User', avatar: 'avatar.jpg' });

const response = privacySettingsResponse({
  profileVisibility: 'followers',
  allowMessageFrom: 'followers',
  showOnlineStatus: false,
  allowFollowRequests: false,
  showPostsToFollowers: false
});
assert.strictEqual(response.data.profileVisibility, 'followers');
assert.strictEqual(response.privacySettings.accountType, 'private');
assert.strictEqual(response.privacySettings.whoCanMessage, 'people_you_follow');

const privacyPath = User.schema.path('privacySettings.profileVisibility');
assert(privacyPath, 'User schema must persist profileVisibility');
assert(User.schema.path('privacySettings.allowMessageFrom'));
assert(User.schema.path('privacySettings.showOnlineStatus'));
assert(User.schema.path('privacySettings.allowFollowRequests'));
assert(User.schema.path('privacySettings.showPostsToFollowers'));
assert(FollowRequest.schema.indexes().some(([key, options]) => key.requester === 1 && key.target === 1 && options.unique));

const publicDto = formatUserDTO({
  _id: 'u2',
  username: 'public_user',
  profile: { displayName: 'Public', avatar: 'avatar.jpg' },
  email: 'secret@example.com',
  appleId: 'secret-apple-id',
  googleId: 'secret-google-id',
  pushTokens: [{ token: 'secret-device-token' }],
  notificationClients: [{ clientId: 'secret-client' }],
  resetPasswordToken: 'secret-reset-token',
  emailVerificationToken: 'secret-verification-token',
  lastSeen: new Date(),
  savedPosts: [{ post: 'p1' }],
  posts: ['p1'],
  notificationSettings: { pushEnabled: true },
  mutedChats: ['u3'],
  pinnedChats: ['u3'],
  pinnedGroups: ['g1'],
  adminControls: { loginDisabled: true },
  adminWarnings: [{ reason: 'private' }],
  adminPermissions: ['private'],
  membership: { tier: 'player_pro', credits: 100 },
  privacySettings: { profileVisibility: 'public' }
}, false, false, false);
for (const privateField of [
  'email', 'appleId', 'googleId', 'pushTokens', 'notificationClients',
  'resetPasswordToken', 'emailVerificationToken', 'lastSeen', 'savedPosts', 'posts', 'notificationSettings',
  'mutedChats', 'pinnedChats', 'pinnedGroups', 'adminControls', 'adminWarnings',
  'adminPermissions', 'membership', 'privacySettings'
]) assert.strictEqual(Object.prototype.hasOwnProperty.call(publicDto, privateField), false, `${privateField} must be private`);

const selfDto = formatUserDTO({
  _id: 'u2',
  username: 'public_user',
  email: 'secret@example.com',
  appleId: 'secret-apple-id',
  pushTokens: [{ token: 'secret-device-token' }],
  notificationClients: [{ clientId: 'secret-client' }],
  resetPasswordToken: 'secret-reset-token'
}, false, true, true);
for (const privateField of ['email', 'appleId', 'pushTokens', 'notificationClients', 'resetPasswordToken']) {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(selfDto, privateField), false, `${privateField} must never be serialized`);
}

const presenceRevocationCalls = [];
const mockIo = {
  to(room) {
    return {
      emit(event, payload) {
        presenceRevocationCalls.push({ action: 'emit', room, event, payload });
      }
    };
  },
  in(room) {
    return {
      socketsLeave(targetRoom) {
        presenceRevocationCalls.push({ action: 'leave', room, targetRoom });
      }
    };
  }
};
removePresenceSubscription(mockIo, 'viewer-1', 'target-1');
assert.deepStrictEqual(presenceRevocationCalls.map(({ action }) => action), ['emit', 'leave']);
assert.strictEqual(presenceRevocationCalls[0].room, 'user-viewer-1');
assert.strictEqual(presenceRevocationCalls[0].event, 'presence:updated');
assert.strictEqual(presenceRevocationCalls[0].payload.userId, 'target-1');
assert.strictEqual(presenceRevocationCalls[0].payload.hidden, true);
assert.strictEqual(presenceRevocationCalls[1].targetRoom, 'presence-target-1');

presenceRevocationCalls.length = 0;
const updatePayload = publishPrivacySettingsUpdate(mockIo, 'target-1');
assert.strictEqual(updatePayload.userId, 'target-1');
assert.deepStrictEqual(
  presenceRevocationCalls.map(({ room, event }) => ({ room, event })),
  [
    { room: 'user-target-1', event: 'privacy-settings-updated' },
    { room: 'presence-target-1', event: 'privacy-settings-updated' }
  ]
);

(async () => {
  const originalIsFollowing = Follow.isFollowing;
  const originalFindById = User.findById;
  let guestRelationshipLookupAttempted = false;
  Follow.isFollowing = async () => {
    guestRelationshipLookupAttempted = true;
    throw new Error('guest must not query Follow');
  };
  User.findById = () => {
    guestRelationshipLookupAttempted = true;
    throw new Error('guest must not query User relationships');
  };
  try {
    const guestAccess = await resolvePrivacyAccess({
      viewer: { _id: 'guest_00000000-0000-4000-8000-000000000000', userType: 'guest' },
      targetUser: {
        _id: objectId,
        isActive: true,
        blockedUsers: [],
        privacySettings: { profileVisibility: 'public' }
      }
    });
    assert.strictEqual(guestAccess.access.canViewProfile, true);
    assert.strictEqual(guestAccess.access.canViewPosts, true);
    assert.strictEqual(guestRelationshipLookupAttempted, false);
  } finally {
    Follow.isFollowing = originalIsFollowing;
    User.findById = originalFindById;
  }

  const author = {
    _id: '507f1f77bcf86cd799439011',
    username: 'author',
    isActive: true,
    privacySettings: { profileVisibility: 'public', showPostsToFollowers: true },
    blockedUsers: []
  };
  const visible = await filterPostsForViewer([
    { _id: '507f1f77bcf86cd799439012', author, isActive: true },
    { _id: '507f1f77bcf86cd799439013', author, isActive: true, visibility: 'corrupt' }
  ], null);
  assert.deepStrictEqual(visible.map((post) => String(post._id)), ['507f1f77bcf86cd799439012']);
  console.log('privacy policy tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
