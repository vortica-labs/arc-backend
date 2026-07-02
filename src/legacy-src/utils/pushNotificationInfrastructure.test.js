const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const {
  assertExpoMessageSize,
  buildExpoMessages,
  buildPushData,
  getExpoRetryDelayMs,
  getPushRequestKey,
  isRetryableExpoRequestError,
  isTransientExpoError
} = require('./pushNotificationService');
const PushDevice = require('../models/PushDevice');
const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
const PushDeliveryRequest = require('../models/PushDeliveryRequest');
const NotificationModel = require('../models/Notification');
const UserModel = require('../models/User');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const serviceSource = read('legacy-src/utils/pushNotificationService.js');
const deviceServiceSource = read('legacy-src/services/pushDeviceService.js');
const notificationRoutes = read('modules/notifications/notifications.routes.ts');
const adminRoutes = read('modules/admin/push.routes.ts');
const queueSource = read('infrastructure/jobs/queue.ts');
const serverSource = read('server.ts');
const authSource = read('legacy-src/controllers/authController.js');
const authMiddlewareSource = read('legacy-src/middleware/auth.js');
const migrationSource = fs.readFileSync(path.resolve(root, '..', 'scripts', 'migrate-push-infrastructure.js'), 'utf8');
const preflightSource = fs.readFileSync(path.resolve(root, '..', 'scripts', 'preflight-push-release.js'), 'utf8');

const stable = getPushRequestKey('507f1f77bcf86cd799439011', {
  _id: '507f1f77bcf86cd799439012',
  updatedAt: new Date('2026-07-02T00:00:00.000Z')
});
assert.equal(stable, getPushRequestKey('507f1f77bcf86cd799439011', {
  _id: '507f1f77bcf86cd799439012',
  updatedAt: new Date('2026-07-02T00:00:00.000Z')
}));
assert.notEqual(stable, getPushRequestKey('507f1f77bcf86cd799439011', {
  _id: '507f1f77bcf86cd799439012',
  updatedAt: new Date('2026-07-02T00:01:00.000Z')
}));
const stableCreatedRevision = getPushRequestKey('507f1f77bcf86cd799439011', {
  _id: '507f1f77bcf86cd799439012',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-02T00:00:00.000Z')
});
assert.equal(stableCreatedRevision, getPushRequestKey('507f1f77bcf86cd799439011', {
  _id: '507f1f77bcf86cd799439012',
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-03T00:00:00.000Z')
}));
assert.equal(getPushRequestKey('ignored', { pushRequestKey: 'a'.repeat(64) }), 'a'.repeat(64));
assert.equal(
  getPushRequestKey('507f1f77bcf86cd799439011', {
    _id: '507f1f77bcf86cd799439012',
    data: { customData: { pushRequestId: 'incoming-call:stable-1' } }
  }),
  getPushRequestKey('507f1f77bcf86cd799439011', {
    data: { customData: { pushRequestId: 'incoming-call:stable-1' } }
  }),
  'transport fallback must reuse the producer request key without a Notification document'
);

assert.equal(isTransientExpoError('MessageRateExceeded'), true);
assert.equal(isTransientExpoError('DeviceNotRegistered'), false);
assert.equal(isRetryableExpoRequestError({ statusCode: 429 }), true);
assert.equal(isRetryableExpoRequestError({ statusCode: 503 }), true);
assert.equal(isRetryableExpoRequestError({ code: 'ExpoRequestTimeout' }), true);
assert.equal(isRetryableExpoRequestError({ code: 'ECONNRESET' }), true);
assert.equal(getExpoRetryDelayMs({ retryAfter: '20' }, 1), 20000);

const callNotification = {
  _id: '507f1f77bcf86cd799439013',
  type: 'call',
  title: 'Incoming call',
  message: 'A teammate is calling',
  data: {
    customData: {
      eventType: 'incoming_call',
      callId: '507f1f77bcf86cd799439014',
      nativeCallId: '89d4a55d-3e3c-4d11-89cb-8df7b4df775b',
      roomId: 'room-1',
      randomRoomId: 'random-1',
      callType: 'video',
      callerId: '507f1f77bcf86cd799439015',
      callerName: 'Test Caller',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  }
};
const [callMessage] = buildExpoMessages(['ExpoPushToken[test-token]'], callNotification, 1);
assert.equal(callMessage.categoryId, 'incoming_call');
assert.equal(callMessage.channelId, 'calls');
assert.equal(callMessage.ttl, 30);
assert.equal(callMessage.priority, 'high');
assert.equal(callMessage._contentAvailable, true);
assert.equal(callMessage.data.callId, '507f1f77bcf86cd799439014');
assert.equal(callMessage.data.nativeCallId, '89d4a55d-3e3c-4d11-89cb-8df7b4df775b');
assert.equal(callMessage.data.roomId, 'room-1');
assert.equal(callMessage.data.callType, 'video');

const [androidCallMessage] = buildExpoMessages([{
  token: 'ExpoPushToken[test-android-token]',
  platform: 'android'
}], callNotification, 1);
assert.equal(androidCallMessage.title, undefined, 'Android calls must be data-only so FCM invokes the native service when killed');
assert.equal(androidCallMessage.body, undefined);
assert.equal(androidCallMessage.channelId, undefined);
assert.equal(androidCallMessage.data.callerName, 'Test Caller');
assert.equal(androidCallMessage.priority, 'high');

const [iosCallStateMessage] = buildExpoMessages([{
  token: 'ExpoPushToken[test-ios-state-token]',
  platform: 'ios'
}], {
  type: 'call',
  title: 'Call updated',
  message: 'Call accepted',
  data: { customData: {
    eventType: 'call_state_update', callId: 'call-state-1',
    nativeCallId: '52dcb2ab-80f7-4ff8-a719-71fc0aa0c517',
    status: 'accepted', callStatus: 'accepted',
    pushOptions: { priority: 'high', ttl: 60, collapseKey: 'call-state-1' }
  } }
}, 0);
assert.equal(iosCallStateMessage.title, undefined, 'iOS call state must use standard content-available APNs, never PushKit');
assert.equal(iosCallStateMessage.body, undefined);
assert.equal(iosCallStateMessage._contentAvailable, true);
assert.equal(iosCallStateMessage.priority, 'normal', 'silent iOS state updates must map to APNs priority 5');

const [longCollapseMessage] = buildExpoMessages([{
  token: 'ExpoPushToken[test-long-collapse]',
  platform: 'android'
}], {
  ...callNotification,
  data: {
    customData: {
      ...callNotification.data.customData,
      callId: 'c'.repeat(160),
      pushOptions: { collapseKey: `incoming-call-${'c'.repeat(160)}` }
    }
  }
}, 0);
assert.equal(Buffer.byteLength(longCollapseMessage.collapseId, 'utf8'), 64);
assert.match(longCollapseMessage.collapseId, /^[a-f\d]{64}$/);

const [randomConnectMessage] = buildExpoMessages(['ExpoPushToken[test-token]'], {
  type: 'call', title: 'Match found', message: 'Join now',
  data: { customData: { eventType: 'random_connect_match', pushOptions: { ttl: 120 } } }
}, 0);
assert.equal(randomConnectMessage.categoryId, undefined);
assert.equal(randomConnectMessage.ttl, 120);

const callData = buildPushData(callNotification);
for (const field of ['eventType', 'callId', 'nativeCallId', 'roomId', 'randomRoomId', 'callType', 'callerId', 'deadlineAt', 'expiresAt']) {
  assert.ok(Object.prototype.hasOwnProperty.call(callData, field), `missing allowlisted call field ${field}`);
}
assert.throws(
  () => assertExpoMessageSize({ data: 'x'.repeat(10000) }),
  (error) => error?.code === 'PushPayloadTooLarge'
);

const attempt = new PushDeliveryAttempt({
  requestKey: 'b'.repeat(64),
  recipient: new mongoose.Types.ObjectId(),
  tokenHash: 'c'.repeat(64),
  payload: {
    token: 'raw-expo-token', authorization: 'Bearer secret', accessToken: 'access-secret',
    refresh_token: 'refresh-secret', nested: { apiKey: 'api-secret' }, safe: 'visible'
  },
  providerResponse: { nested: { nativeToken: 'raw-native-token' }, status: 'ok' }
});
assert.equal(attempt.payload.token, '[REDACTED]');
assert.equal(attempt.payload.authorization, '[REDACTED]');
assert.equal(attempt.payload.accessToken, '[REDACTED]');
assert.equal(attempt.payload.refresh_token, '[REDACTED]');
assert.equal(attempt.payload.nested.apiKey, '[REDACTED]');
assert.equal(attempt.payload.safe, 'visible');
assert.equal(attempt.providerResponse.nested.nativeToken, '[REDACTED]');
const oversized = new PushDeliveryAttempt({
  requestKey: 'd'.repeat(64), recipient: new mongoose.Types.ObjectId(), tokenHash: 'e'.repeat(64),
  payload: { safe: 'x'.repeat(20000) }
});
assert.equal(oversized.payload.truncated, true);
const request = new PushDeliveryRequest({
  requestKey: 'f'.repeat(64), recipient: new mongoose.Types.ObjectId(),
  payload: { fcmToken: 'raw-fcm-token', safe: 'visible' }
});
assert.equal(request.payload.fcmToken, '[REDACTED]');
assert.equal(request.payload.safe, 'visible');
assert(PushDeliveryRequest.schema.indexes().some(([key, options]) => key.requestKey === 1 && options.unique));
assert(PushDeliveryRequest.schema.indexes().some(([key, options]) => key.expiresAt === 1 && options.expireAfterSeconds === 0));

assert.equal(PushDevice.schema.path('token').options.select, false);
assert.equal(PushDevice.schema.path('nativeToken').options.select, false);
assert.equal(PushDevice.schema.path('fcmToken').options.select, false);
assert.equal(PushDevice.schema.path('apnsToken').options.select, false);
assert.equal(PushDevice.schema.path('voipToken').options.select, false);
assert(PushDevice.schema.indexes().some(([key, options]) => key.fcmTokenHash === 1 && options.unique));
assert(PushDevice.schema.indexes().some(([key, options]) => key.apnsTokenHash === 1 && options.unique));
assert(PushDevice.schema.indexes().some(([key, options]) => key.voipTokenHash === 1 && options.unique));
for (const metadataPath of ['deviceModel', 'deviceBrand', 'manufacturer', 'deviceType', 'osName', 'osVersion']) {
  assert(PushDevice.schema.path(metadataPath), `PushDevice.${metadataPath} must be persisted`);
}
assert(PushDevice.schema.indexes().some(([key, options]) => key.installationId === 1 && options.unique));
assert(PushDevice.schema.indexes().some(([key, options]) => key.tokenHash === 1 && options.unique));
assert(PushDeliveryAttempt.schema.indexes().some(([key, options]) =>
  key.requestKey === 1 && key.tokenHash === 1 && options.unique));
assert(PushDeliveryAttempt.schema.indexes().some(([key, options]) => key.expiresAt === 1 && options.expireAfterSeconds === 0));
const serializedUser = new UserModel({
  username: 'push_contract_user', email: 'push-contract@example.test', password: 'not-returned',
  userType: 'player', profile: { displayName: 'Push Contract' },
  pushTokens: [{ token: 'ExpoPushToken[never-return-this]' }],
  notificationClients: [{ clientId: 'android:never-return-this' }]
}).toObject();
assert.equal(serializedUser.password, undefined);
assert.equal(serializedUser.pushTokens, undefined);
assert.equal(serializedUser.notificationClients, undefined);

assert(deviceServiceSource.includes('session.withTransaction'), 'ownership transfer must use a MongoDB transaction');
assert(deviceServiceSource.includes("$pull: {\n        pushTokens"), 'superseded legacy tokens must be removed');
assert(deviceServiceSource.includes('getPushDevicesForUser'), 'delivery must dual-read legacy tokens');
assert(deviceServiceSource.includes('Legacy push-device self-heal failed'), 'legacy devices must self-heal');
assert(deviceServiceSource.includes('canonicalByInstallation'), 'legacy fallback must honor canonical installation ownership');
assert(deviceServiceSource.includes("...(native.provider === 'fcm' ? [{ fcmTokenHash: native.tokenHash }] : [])"));
assert(deviceServiceSource.includes("...(native.provider === 'apns' ? [{ apnsTokenHash: native.tokenHash }] : [])"));
assert(deviceServiceSource.includes('invalidatePushDevicesByHash'));
const invalidLogBlock = deviceServiceSource.slice(
  deviceServiceSource.indexOf("log.info('Invalid push installation removed')"),
  deviceServiceSource.indexOf("log.info('Invalid push installation removed')") + 350
);
assert(!/\btoken\s*:/.test(invalidLogBlock), 'invalid-token log must not contain raw token');

assert(serviceSource.includes("ticketStatus: 'accepted', receiptStatus: 'pending', deliveryStatus: 'provider_accepted'"));
assert(serviceSource.includes("'provider_delivered'"));
assert(serviceSource.includes('providerDeliveredAt'));
assert(serviceSource.includes('clientDeliveredAt'));
assert(serviceSource.includes('pushTargetTokenHashes'), 'durable retry must stay scoped to original device hashes');
assert(serviceSource.includes('pushTargetPlatforms'), 'call-state cleanup must target mobile installations without alerting web');
assert(serviceSource.includes('pushDeliveryAttemptId: String(record._id)'));
assert(serviceSource.includes('retryPushDeliveryAttempts'));
assert(serviceSource.includes('ensurePushDeliveryRequest'));
assert(serviceSource.includes("NO_ACTIVE_INSTALLATION: 'No active push installation is registered for this recipient'"));
assert(serviceSource.includes("PUSH_DISABLED: 'Recipient disabled push notifications'"));
assert(serviceSource.includes('refreshPushDeliveryRequests'));
assert(serviceSource.includes('recoverInterruptedPushRequests'));
assert(serviceSource.includes('recoverPendingNotificationPushes'));
assert(serviceSource.includes("pushDeliveryState: 'processing'"));
assert(serviceSource.includes('PushDeliveryAttempt.exists({ requestKey })'), 'notification recovery must not resubmit an existing token attempt');
assert(serviceSource.includes('Notification push outbox exhausted its retry budget'));
assert(serviceSource.includes('REQUEST_RECOVERY_EXHAUSTED'));
assert(serviceSource.includes("(!isIncomingCall || allowIosVoipFallback || entry.platform !== 'ios' || !entry.voipTokenHash)"));
assert(serviceSource.includes("error.retryAfter = response.headers.get('retry-after')"));
assert(serviceSource.includes("errorCode === 'DeviceNotRegistered'"));

assert(notificationRoutes.includes('installationId: requestedInstallationId'));
assert(notificationRoutes.includes('deviceId'));
assert(notificationRoutes.includes('router.delete("/client-context"'));
assert(notificationRoutes.includes('advanceGenericPushDelivery'));
assert(notificationRoutes.includes('clientDeliveredAt: { $ifNull'));
assert(notificationRoutes.includes('pushTestLimiter'));
assert(authSource.includes('removedPushInstallations'));
assert(authSource.includes("removePushDevices"));
assert(authSource.includes('delete value.pushTokens'));
assert(authSource.includes('delete value.notificationClients'));
assert.equal(authSource.includes('const userResponse = user.toObject()'), false, 'auth responses must use the sanitizer');
assert(authMiddlewareSource.includes("select('-password -pushTokens -notificationClients')"));
assert(authMiddlewareSource.includes('delete cached.pushTokens'));

assert(adminRoutes.includes('requireAdminPermission("users:manage")'));
assert(adminRoutes.includes('auditLog("SEND_ADMIN_TEST_PUSH")'));
assert(adminRoutes.includes('testLimiter'));
assert(adminRoutes.includes('.select("-token -nativeToken -fcmToken -apnsToken -voipToken -tokenHash -nativeTokenHash -fcmTokenHash -apnsTokenHash -voipTokenHash")'));
assert(adminRoutes.includes('Idempotency-Key'));
assert(adminRoutes.includes('auditLog("VIEW_PUSH_REQUESTS")'));

for (const contract of ['"push-send"', '"push-receipts"', 'enqueuePushSend', 'enqueuePushReceipts', 'PushDeliveryAttempt']) {
  assert(queueSource.includes(contract), `queue recovery is missing ${contract}`);
}
assert(queueSource.includes('genericPushService.recoverInterruptedPushRequests(200)'));
assert(serverSource.includes('enqueuePushSend'));
assert(serverSource.includes('enqueuePushReceipts'));
assert(migrationSource.includes('backfillDevices'));
assert(migrationSource.includes('PushDevice.createIndexes()'));
assert(migrationSource.includes('PushDeliveryAttempt.createIndexes()'));
assert(migrationSource.includes('PushDeliveryRequest.createIndexes()'));
assert(preflightSource.includes('loadSecretsManagerEnv'));
assert(preflightSource.includes("run('verify-push-provider-config.js', ['--release'])"));
for (const field of [
  'pushDeliveryState', 'pushDeliveryAttempts', 'pushDeliveryNextAttemptAt',
  'pushDeliveryLeaseAt', 'pushDeliveryLeaseKey', 'pushDeliveryLastError',
  'pushDeliveryCompletedAt'
]) {
  assert(NotificationModel.schema.path(field), `Notification.${field} must support the durable push outbox`);
}
assert(NotificationModel.schema.indexes().some(([key]) =>
  key.pushDeliveryState === 1 && key.pushDeliveryNextAttemptAt === 1 && key.pushDeliveryLeaseAt === 1
));
assert(NotificationModel.schema.indexes().some(([key, options]) =>
  key.recipient === 1 && key['data.customData.notificationCoalesceKey'] === 1 &&
  options.unique && options.partialFilterExpression?.isRead === false
));
assert(migrationSource.includes('backfillVoipProviderRequestIds'));
assert(migrationSource.includes('verifyVoipProviderRequestIds'));

console.log('Push notification infrastructure contracts passed');
