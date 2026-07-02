const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sanitizePublicTournament, sanitizePublicScrim } = require('./tournamentPublicDto');
const {
  redactRestrictedNotification,
  redactRestrictedPostNotification
} = require('./notificationPrivacy');

const privateTeam = {
  _id: 'team-1',
  username: 'private-team',
  userType: 'team',
  email: 'must-not-leak@example.com',
  privacySettings: { profileVisibility: 'private' },
  blockedUsers: ['blocked-user'],
  lastSeen: new Date(),
  profile: { displayName: 'Private Team', avatar: 'team.png', bio: 'protected bio' },
  teamInfo: {
    members: [{ user: { _id: 'member-1', username: 'member' }, role: 'Captain' }],
    staff: [{ user: 'staff-1', role: 'Coach' }],
    rosters: [{ game: 'BGMI', players: [{ user: 'member-1' }] }]
  }
};

const publicTournament = sanitizePublicTournament({
  _id: 'tournament-1',
  name: 'Public tournament',
  host: privateTeam,
  participants: [privateTeam],
  teams: [privateTeam],
  groups: [{
    _id: 'group-1',
    participants: [privateTeam],
    broadcastChannelId: 'private-channel'
  }],
  matches: [{
    team1: privateTeam,
    createdBy: 'host-admin',
    lastModifiedBy: 'host-admin',
    rescheduleReason: 'private workflow note'
  }],
  tournamentMessages: [{ message: 'private tournament message' }],
  groupMessages: [{ messages: [{ message: 'private group message' }] }],
  broadcastChannels: [{ channelId: 'private-channel' }]
});

assert.strictEqual(publicTournament.tournamentMessages, undefined);
assert.strictEqual(publicTournament.groupMessages, undefined);
assert.strictEqual(publicTournament.broadcastChannels, undefined);
assert.strictEqual(publicTournament.teams[0].teamInfo, undefined);
assert.strictEqual(publicTournament.teams[0].email, undefined);
assert.strictEqual(publicTournament.teams[0].privacySettings, undefined);
assert.strictEqual(publicTournament.teams[0].profile.bio, undefined);
assert.strictEqual(publicTournament.groups[0].broadcastChannelId, undefined);
assert.strictEqual(publicTournament.matches[0].createdBy, undefined);
assert.strictEqual(publicTournament.matches[0].lastModifiedBy, undefined);
assert.strictEqual(publicTournament.matches[0].rescheduleReason, undefined);
assert.deepStrictEqual(Object.keys(publicTournament.teams[0]).sort(), [
  '_id', 'avatar', 'profile', 'profilePicture', 'userType', 'username'
]);

const publicScrim = sanitizePublicScrim({
  _id: 'scrim-1',
  host: privateTeam,
  registeredTeams: [privateTeam],
  broadcasts: [{ message: 'registered teams only' }]
});
assert.strictEqual(publicScrim.broadcasts, undefined);
assert.strictEqual(publicScrim.registeredTeams[0].teamInfo, undefined);
assert.strictEqual(publicScrim.registeredTeams[0].privacySettings, undefined);

const redactedNotification = redactRestrictedPostNotification({
  _id: 'notification-1',
  sender: { _id: 'blocked-sender', username: 'blocked-sender' },
  title: 'You were mentioned',
  message: 'Private post excerpt that must not survive',
  data: {
    postId: 'private-post',
    deepLink: '/posts/private-post',
    customData: {
      postId: 'private-post',
      sharedPostId: 'private-post',
      url: '/post/private-post'
    }
  }
});
assert.strictEqual(redactedNotification.sender, null);
assert.strictEqual(redactedNotification.data.postId, undefined);
assert.strictEqual(redactedNotification.data.deepLink, undefined);
assert.strictEqual(redactedNotification.data.customData.postId, undefined);
assert.strictEqual(redactedNotification.data.customData.sharedPostId, undefined);
assert.strictEqual(redactedNotification.data.customData.url, undefined);
assert.strictEqual(redactedNotification.data.customData.contentUnavailable, true);
assert(!redactedNotification.message.includes('Private post excerpt'));

const redactedBlockedSender = redactRestrictedNotification({
  type: 'message',
  sender: { _id: 'blocked-user' },
  message: 'private message preview',
  data: {
    messageId: 'message-1',
    storyId: 'story-1',
    recruitmentId: 'recruitment-1',
    profileId: 'user-1',
    scrimId: 'scrim-1',
    deepLink: '/conversation/private-chat',
    customData: { conversationId: 'private-chat', storyId: 'story-1', profileId: 'user-1' }
  }
});
assert.strictEqual(redactedBlockedSender.sender, null);
assert.strictEqual(redactedBlockedSender.data.messageId, undefined);
assert.strictEqual(redactedBlockedSender.data.storyId, undefined);
assert.strictEqual(redactedBlockedSender.data.recruitmentId, undefined);
assert.strictEqual(redactedBlockedSender.data.profileId, undefined);
assert.strictEqual(redactedBlockedSender.data.scrimId, undefined);
assert.strictEqual(redactedBlockedSender.data.deepLink, undefined);
assert.strictEqual(redactedBlockedSender.data.customData.conversationId, undefined);
assert.strictEqual(redactedBlockedSender.data.customData.storyId, undefined);
assert.strictEqual(redactedBlockedSender.data.customData.profileId, undefined);

const backendRoot = path.resolve(__dirname, '../..');
const tournamentController = fs.readFileSync(
  path.join(backendRoot, 'legacy-src/controllers/tournamentController.js'),
  'utf8'
);
const notificationRoutes = fs.readFileSync(
  path.join(backendRoot, 'modules/notifications/notifications.routes.ts'),
  'utf8'
);
const legacyNotificationRoutes = fs.readFileSync(
  path.join(backendRoot, 'legacy-src/routes/notifications.js'),
  'utf8'
);
const notificationService = fs.readFileSync(
  path.join(backendRoot, 'legacy-src/utils/notificationService.js'),
  'utf8'
);
const scrimController = fs.readFileSync(
  path.join(backendRoot, 'legacy-src/controllers/scrimController.js'),
  'utf8'
);
const scrimRoutes = fs.readFileSync(
  path.join(backendRoot, 'modules/scrims/scrims.routes.ts'),
  'utf8'
);
const challengeController = fs.readFileSync(
  path.join(backendRoot, 'legacy-src/controllers/challengeController.js'),
  'utf8'
);
const challengeRoutes = fs.readFileSync(
  path.join(backendRoot, 'modules/challenges/challenges.routes.ts'),
  'utf8'
);
const followModel = fs.readFileSync(
  path.join(backendRoot, 'legacy-src/models/Follow.js'),
  'utf8'
);
const userController = fs.readFileSync(
  path.join(backendRoot, 'legacy-src/controllers/userController.js'),
  'utf8'
);

assert((tournamentController.match(/sanitizePublicTournament\(processTournament\(tournament\)\)/g) || []).length >= 2);
assert(tournamentController.includes('.map(sanitizePublicTournament)'));
assert(tournamentController.includes("PUBLIC_TOURNAMENT_SELECT = '-groupMessages -tournamentMessages -broadcastChannels'"));
assert(tournamentController.includes('host: host._id'));
assert(tournamentController.includes('canReadTournamentMessages(tournament, req.user._id)'));
assert(tournamentController.includes('canReadGroupMessages(tournament, group, req.user._id)'));
assert(tournamentController.includes("code: 'TOURNAMENT_MESSAGE_ACCESS_DENIED'"));
assert(tournamentController.includes("code: 'GROUP_MESSAGE_ACCESS_DENIED'"));
assert(!tournamentController.includes("io.emit('broadcast_message'"));
assert(tournamentController.includes("io.to(`user-${recipientId}`).emit('broadcast_message', payload)"));
assert(!notificationRoutes.includes('.populate("data.postId", "content.text")'));
assert(notificationRoutes.includes('sanitizeNotificationsForViewer(notificationDocuments, req.user)'));
assert(!legacyNotificationRoutes.includes(".populate('data.postId', 'content.text')"));
assert(legacyNotificationRoutes.includes('sanitizeNotificationsForViewer(notificationDocuments, req.user)'));
assert(notificationService.includes('resolvePostAccess({ post, viewer: recipient })'));
assert(notificationService.includes('Mention notification suppressed by current post privacy'));
assert(scrimController.includes('scrims: scrims.map(sanitizePublicScrim)'));
assert(scrimController.includes('const safeScrim = sanitizePublicScrim(scrim)'));
assert(scrimController.includes('canReadScrimBroadcasts(scrim, req.user?._id)'));
assert(scrimRoutes.includes('router.get("/code/:code", publicOptionalAuth, scrimController.getScrim)'));
assert(scrimRoutes.includes('.get(publicOptionalAuth, scrimController.getScrim)'));
assert(challengeController.includes('from: Follow.collection.name'));
assert(challengeController.includes('resolveChallengeAccess({ challenge, viewer: req.user })'));
assert(challengeController.includes("$type: '$__creator.privacySettings.profileVisibility'"));
assert(challengeController.includes("default: 'private'"));
assert(challengeController.includes('$project: { participants: 0, __creator: 0, __viewerFollow: 0 }'));
assert(!challengeController.includes('req.user.following'));
const staticChallengesRoute = challengeRoutes.indexOf('router.get("/my/challenges"');
const dynamicChallengeRoute = challengeRoutes.indexOf('router.get("/:id"');
assert(staticChallengesRoute >= 0 && staticChallengesRoute < dynamicChallengeRoute);
assert(challengeRoutes.includes('router.get("/", publicOptionalAuth, challengesController.getChallenges)'));
assert(challengeRoutes.includes('router.get("/:id", publicOptionalAuth, challengesController.getChallenge)'));
assert(!tournamentController.includes('stack: error.stack'));
assert(followModel.includes('buildVisibleUserMatch({ excludeUserIds, search })'));
assert(followModel.indexOf('buildVisibleUserMatch({ excludeUserIds, search })') < followModel.indexOf('$facet'));
assert(userController.includes('Follow.getFollowers(targetPrivacy.target._id, { page, limit, search, excludeUserIds })'));
assert(userController.includes('Follow.getFollowing(targetPrivacy.target._id, { page, limit, search, excludeUserIds })'));

console.log('Peripheral privacy endpoint tests passed');
