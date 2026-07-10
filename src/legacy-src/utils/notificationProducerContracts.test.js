const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const legacyRoot = path.resolve(__dirname, '..');
const backendRoot = path.resolve(legacyRoot, '..');
const readLegacy = (relativePath) => fs.readFileSync(path.join(legacyRoot, relativePath), 'utf8');

const messageController = readLegacy('controllers/messageController.js');
const callController = readLegacy('controllers/callController.js');
const notificationService = readLegacy('utils/notificationService.js');
const notificationModel = readLegacy('models/Notification.js');
const recruitmentController = readLegacy('controllers/recruitmentController.js');
const scrimController = readLegacy('controllers/scrimController.js');
const tournamentController = readLegacy('controllers/tournamentController.js');
const userController = readLegacy('controllers/userController.js');
const leaveRequestController = readLegacy('controllers/leaveRequestController.js');
const randomConnectController = readLegacy('controllers/randomConnectController.js');
const premiumMembershipService = readLegacy('services/premiumMembershipService.js');
const notificationEmitter = readLegacy('utils/notificationEmitter.js');
const jobQueueBridge = readLegacy('utils/jobQueue.js');
const infrastructureQueue = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'jobs', 'queue.ts'), 'utf8');
const pushMigration = fs.readFileSync(path.join(backendRoot, '..', 'scripts', 'migrate-push-infrastructure.js'), 'utf8');
const socketSource = fs.readFileSync(path.join(backendRoot, 'modules', 'legacy', 'legacy.socket.ts'), 'utf8');

const controllerWriteBypasses = fs.readdirSync(path.join(legacyRoot, 'controllers'))
  .filter((name) => name.endsWith('.js'))
  .filter((name) => /Notification\.(?:create|createNotification|insertMany|bulkWrite)\s*\(/.test(readLegacy(`controllers/${name}`)));
assert.deepEqual(
  controllerWriteBypasses,
  [],
  `controllers must use canonical preference-aware producers: ${controllerWriteBypasses.join(', ')}`
);
const serviceNotificationCreators = fs.readdirSync(path.join(legacyRoot, 'services'))
  .filter((name) => name.endsWith('.js'))
  .filter((name) => /Notification\.(?:create|createNotification|insertMany|bulkWrite)\s*\(/.test(readLegacy(`services/${name}`)));
assert.deepEqual(serviceNotificationCreators, []);

assert(messageController.includes('await createMessageNotification(outcome.invite.team, userId, responseMsg._id, {'));
assert(messageController.includes('await createMessageNotification(targetUserId, callerId, message._id, {'));
assert(messageController.includes('await createMessageNotification(recipientIdResolved, senderId, message._id, {'));
assert(messageController.includes('deepLink: `/conversation/direct_${senderId}`'));
assert(messageController.includes('deepLink: `/conversation/${chatRoomId}`'));
assert(messageController.includes('groupRecipientIds.map((recipientId) => createMessageNotification'));
assert(messageController.includes('await createMessageNotification(mentionedId, senderId, message._id, {'));
assert(messageController.includes("messageKind: 'mention'"), 'group mentions must use message preferences and group mute state');
assert(messageController.includes("if (result.status === 'rejected')"), 'group notification fan-out failures must be surfaced');
assert(!messageController.includes('recipientIsOnline'), 'direct-message notification delivery must not use process-local socket presence');
assert(!messageController.includes(".emit('notification'"), 'notification-center events must use the canonical new-notification emitter');

assert(notificationService.includes('const channels = resolveNotificationChannels('));
assert(notificationService.includes('emitNotification(recipientId, existing)'));
assert(notificationService.includes('await sendPushNotification(recipientId, claimed)'));
assert(notificationService.includes('title: notificationTitle'));
assert(notificationService.includes("pushDeliveryState: channels.push ? 'pending' : 'not_requested'"));
assert(notificationService.includes('pushDeliveryAttempts: 0'), 'each replacement message must receive a fresh outbox retry budget');
assert(notificationService.includes('notificationCoalesceKey'));
assert(notificationService.includes('__coalesceConflictRetried'), 'duplicate first-message inserts must refetch and update the winner');
assert(notificationService.includes('await Notification.claimPushDelivery(existing._id, leaseKey)'));
assert(notificationService.includes("'data.customData.conversationId': conversationId"));
assert(notificationService.includes('messageKind'));
assert(notificationService.includes('media: { hasMedia'));
assert(notificationModel.includes('await sendPushNotification(notification.recipient, claimed)'), 'notification writes must send the atomically claimed revision');
assert(notificationEmitter.includes('const normalizedNotificationData = normalizeNotificationPayload(notificationData)'));
assert(notificationEmitter.includes('notificationDedupeKey'));
assert(notificationEmitter.includes("pushDeliveryState: channels.push ? 'pending' : 'not_requested'"));
assert(notificationEmitter.includes('await Notification.claimPushDelivery(notification._id, leaseKey)'));
assert(notificationEmitter.includes('deliveryNotification = await Notification.claimPushDelivery'), 'canonical delivery must send the atomically claimed revision');
assert(notificationEmitter.includes('deletedAt: new Date()'), 'push-only deliveries must retain a hidden durable outbox row');
assert(!notificationEmitter.includes('getRecipientDeliveryContext(notificationData).catch'), 'preference lookup must never fail open');

const { normalizeNotificationPayload, resolveNotificationChannels } = require('./notificationEmitter');
const { buildMessageNotificationBody } = require('./notificationService');
assert.deepEqual(normalizeNotificationPayload({
  type: 'recruitment',
  data: { recruitmentId: 'recruitment-1', applicationId: 'application-1', deepLink: '/recruitment/1' }
}).data, {
  deepLink: '/recruitment/1',
  customData: { recruitmentId: 'recruitment-1', applicationId: 'application-1' }
});
assert.deepEqual(resolveNotificationChannels({ type: 'message' }, {
  inAppEnabled: true,
  pushEnabled: true,
  messages: false
}), {
  preferenceKey: 'messages',
  categoryAllowed: false,
  inApp: false,
  push: false
});
assert.equal(buildMessageNotificationBody('PlayerOne', 'text'), 'You received a new message from PlayerOne');
assert.equal(buildMessageNotificationBody('PlayerOne', 'media', 'audio'), 'You received a voice message from PlayerOne');
assert.equal(buildMessageNotificationBody('PlayerOne', 'media', 'image'), 'You received an image from PlayerOne');
assert.equal(buildMessageNotificationBody('PlayerOne', 'media', 'video'), 'You received a video from PlayerOne');

assert(recruitmentController.includes("type: 'recruitment'"), 'recruitment decisions must honor recruitment preferences');
for (const eventType of [
  'recruitment_application_submitted',
  'recruitment_application_withdrawn',
  'recruitment_profile_interest',
  'recruitment_application_status',
  'recruitment_post_status',
  'recruitment_post_deleted'
]) {
  assert(recruitmentController.includes(`eventType: '${eventType}'`), `missing durable ${eventType} producer`);
}
assert(recruitmentController.includes(".emit('newMessage'"), 'persisted recruitment DMs must use the chat transport event');
assert(!recruitmentController.includes("emitNotification(applicantId.toString(), { type: 'newMessage'"), 'chat events must not masquerade as notification-center rows');
assert(scrimController.includes('customData: {\n            scrimId: scrim._id'), 'scrim broadcasts must route through scrim preferences');
for (const eventType of [
  'scrim_registration_joined',
  'scrim_registration_left',
  'scrim_updated',
  'scrim_match_results',
  'scrim_cancelled',
  'scrim_final_results'
]) {
  assert(scrimController.includes(`eventType: '${eventType}'`), `missing durable ${eventType} producer`);
}
assert(scrimController.includes('notificationDedupeKey: broadcastDeliveryKey'));
assert(tournamentController.includes("type: 'tournament',\n      title: 'New Tournament Registration'"));
assert(
  tournamentController.includes('enqueue = enqueueBulkNotifications')
    && tournamentController.includes('await enqueue('),
  'large tournament fan-out must use the durable bulk producer'
);
assert(!tournamentController.includes('Notification.createNotification('));
assert(!tournamentController.includes('Notification.bulkWrite('));
for (const eventType of [
  'tournament_registration_left',
  'tournament_deleted',
  'tournament_cancelled',
  'tournament_participant_removed',
  'tournament_group_assigned',
  'tournament_qualified',
  'tournament_final_results'
]) {
  assert(tournamentController.includes(`eventType: '${eventType}'`), `missing durable ${eventType} producer`);
}
assert(userController.includes('await createMessageNotification(playerId, teamId, message._id, {'));
assert(userController.includes('Follow notification delivery failed'));
assert(userController.includes('await createFollowNotification(targetUserId, currentUserId)'));
assert(!userController.includes('createFollowNotification(targetUserId, currentUserId).catch(() => {})'));
assert(!userController.includes('Notification.createNotification('));
assert(!userController.includes('emitNotificationToMultiple('));

assert(leaveRequestController.includes('createAndEmitNotification({'));
assert(!leaveRequestController.includes('Notification.createNotification('));
assert(!leaveRequestController.includes('emitNotificationToMultiple('));

assert(infrastructureQueue.includes('createAndEmitNotification({'));
assert(infrastructureQueue.includes('notificationDedupeKey: effectiveDeliveryKey'));
assert(!infrastructureQueue.includes('Notification.insertMany('), 'bulk worker must not bypass preferences or canonical push delivery');
assert(jobQueueBridge.includes("pushSource: 'bulk'"));
assert(!jobQueueBridge.includes('Notification.bulkWrite('), 'queue fallback must not silently insert without push delivery');
assert(pushMigration.includes('await Notification.createIndexes()'), 'production migration must install notification delivery-dedupe indexes');
assert(pushMigration.includes('reconcileMessageNotificationCoalesceKeys'));

assert(premiumMembershipService.includes('notificationDedupeKey: deliveryKey'));
assert(premiumMembershipService.includes('await createAndEmitNotification({'), 'premium lifecycle must use the canonical durable notification outbox');
assert(premiumMembershipService.includes('Premium lifecycle notification failed'));

assert(socketSource.includes('socket.on("call-request", async'));
assert(socketSource.includes('buildIncomingCallNotification'));
assert(socketSource.includes('notificationDedupeKey: `incoming-call:${callId}`'));
assert(!socketSource.includes('Notification.exists('), 'incoming-call retries must revisit the stable push attempt');
assert(socketSource.includes('createAndEmitNotification'));
assert(socketSource.includes('deadlineAt'));
assert(socketSource.includes('blockedUsers'));

assert(callController.includes("const { createAndEmitNotification } = require('../utils/notificationEmitter')"));
assert(callController.includes("eventType: 'incoming_call'"));
assert(callController.includes('callerBlockedTarget'));
assert(callController.includes('targetBlockedCaller'));
assert(!callController.includes("require('../models/Notification')"));

assert(randomConnectController.includes("eventType: 'random_connect_match'"));
assert(randomConnectController.includes('notificationDedupeKey: `random-connect-match:${roomId}`'));
assert(randomConnectController.includes('await Promise.all(recipients.map(async (recipientId) => {'));
assert(!randomConnectController.includes('Notification.exists('), 'dedupe retries must revisit the stable push attempt instead of returning early');
assert(!tournamentController.includes('Notification.create({'), 'tournament notifications must not bypass push delivery');
assert(randomConnectController.includes("deepLink: '/random-connect'"));
assert(randomConnectController.includes('await notifyRandomConnectMatch([userId1Str, userId2Str]'));
assert(!randomConnectController.includes('Retry emit #'), 'random match delivery must not flood sockets with duplicate retries');

console.log('Notification producer contract tests passed');
