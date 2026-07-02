const assert = require('node:assert/strict');

const User = require('../models/User');
const Notification = require('../models/Notification');
const pushService = require('./pushNotificationService');
const jobQueue = require('./jobQueue');
const emitter = require('./notificationEmitter');
const { EMAIL_INTENTS } = require('./notificationChannelPolicy');

const originals = {
  userFindById: User.findById,
  findNotification: Notification.findOne,
  createNotification: Notification.createNotification,
  claimPushDelivery: Notification.claimPushDelivery,
  completePushDelivery: Notification.completePushDelivery,
  retryPushDelivery: Notification.retryPushDelivery,
  sendPushNotification: pushService.sendPushNotification,
  enqueueEmail: jobQueue.enqueueEmail
};
const previousSmtpUser = process.env.SMTP_USER;
const previousSmtpPass = process.env.SMTP_PASS;
process.env.SMTP_USER = 'policy-test@example.com';
process.env.SMTP_PASS = 'test-password';

let settings = {};
let isActive = true;
let lookupError = null;
let existingNotification = null;
let inAppCreates = 0;
let pushes = 0;
let emails = 0;
let outboxClaims = 0;
let outboxCompletions = 0;
const createdPayloads = [];

User.findById = () => ({
  select: () => ({
    lean: async () => {
      if (lookupError) throw lookupError;
      return {
        _id: '507f1f77bcf86cd799439011',
        email: 'recipient@example.com',
        isActive,
        notificationSettings: settings
      };
    }
  })
});
Notification.findOne = async () => existingNotification;
Notification.createNotification = async (payload) => {
  inAppCreates += 1;
  createdPayloads.push(payload);
  assert.equal(payload.sendPush, false, 'emitter must own push dispatch to avoid model-level double push');
  return { ...payload, _id: `507f1f77bcf86cd7994390${String(inAppCreates).padStart(2, '0')}` };
};
Notification.claimPushDelivery = async (_id, leaseKey) => {
  outboxClaims += 1;
  return { _id, leaseKey };
};
Notification.completePushDelivery = async () => {
  outboxCompletions += 1;
  return { acknowledged: true };
};
Notification.retryPushDelivery = async () => ({ acknowledged: true });
pushService.sendPushNotification = async () => {
  pushes += 1;
  return { sent: 1, accepted: 1, failed: 0 };
};
jobQueue.enqueueEmail = async () => {
  emails += 1;
  return { queued: true };
};

const recipient = '507f1f77bcf86cd799439011';

const run = async () => {
  settings = { inAppEnabled: true, pushEnabled: true, likes: true, comments: true, follows: true };
  for (const type of ['like', 'comment', 'follow']) {
    const result = await emitter.createAndEmitNotification({
      recipient,
      type,
      title: `Routine ${type}`,
      message: `A ${type} happened`,
      data: {}
    });
    assert(result, `${type} should still create an in-app notification`);
  }
  assert.equal(inAppCreates, 3, 'like/comment/follow should persist in-app notifications');
  assert.equal(pushes, 3, 'like/comment/follow should still send push');
  assert.equal(emails, 0, 'routine engagement must never enqueue email by default');
  assert(createdPayloads.every((payload) => payload.sendPush === false));

  settings = { inAppEnabled: false, pushEnabled: true, likes: true };
  const pushOnly = await emitter.createAndEmitNotification({
    recipient,
    type: 'like',
    title: 'Push-only like',
    message: 'Still push this',
    data: {}
  });
  assert(pushOnly, 'push-only delivery should report a delivered notification payload');
  assert.equal(inAppCreates, 4, 'push-only delivery must retain a hidden durable outbox row');
  assert.equal(createdPayloads.at(-1).isRead, true);
  assert(createdPayloads.at(-1).archivedAt instanceof Date);
  assert(createdPayloads.at(-1).deletedAt instanceof Date);
  assert.equal(pushes, 4, 'in-app disabled must not suppress push');
  assert.equal(emails, 0);

  settings = { inAppEnabled: true, pushEnabled: false, comments: true };
  await emitter.createAndEmitNotification({
    recipient,
    type: 'comment',
    title: 'Inbox-only comment',
    message: 'Do not push this',
    data: {}
  });
  assert.equal(inAppCreates, 5, 'push disabled must not suppress in-app persistence');
  assert.equal(pushes, 4);

  settings = { inAppEnabled: true, pushEnabled: true, follows: false };
  const categorySuppressed = await emitter.createAndEmitNotification({
    recipient,
    type: 'follow',
    title: 'Muted follow',
    message: 'Muted',
    data: {}
  });
  assert.equal(categorySuppressed, null, 'category preference must suppress both notification channels');
  assert.equal(inAppCreates, 5);
  assert.equal(pushes, 4);

  isActive = false;
  const inactiveSuppressed = await emitter.createAndEmitNotification({
    recipient,
    type: 'system',
    title: 'Inactive recipient',
    message: 'Suppress notification channels',
    data: {}
  });
  assert.equal(inactiveSuppressed, null, 'inactive recipients must not receive in-app or push delivery');
  assert.equal(inAppCreates, 5);
  assert.equal(pushes, 4);
  isActive = true;

  lookupError = new Error('preference lookup unavailable');
  await assert.rejects(
    emitter.createAndEmitNotification({ recipient, type: 'system', title: 'Lookup failure', message: 'Fail closed', data: {} }),
    /preference lookup unavailable/
  );
  assert.equal(inAppCreates, 5);
  assert.equal(pushes, 4);
  lookupError = null;

  settings = { inAppEnabled: true, pushEnabled: true, systemAlerts: true };
  await emitter.createAndEmitNotification({
    recipient,
    type: 'system',
    title: 'Critical platform notice',
    message: 'Typed transactional notification',
    data: {},
    email: { intent: EMAIL_INTENTS.PLATFORM_CRITICAL, eventType: 'service_incident' }
  });
  assert.equal(inAppCreates, 6);
  assert.equal(pushes, 5);
  assert.equal(emails, 1, 'explicit non-engagement transactional intent may enqueue email');

  existingNotification = {
    _id: 'notification-existing',
    recipient,
    type: 'system',
    title: 'Existing durable row',
    message: 'Recover delivery',
    data: { customData: { notificationDedupeKey: 'stable-event', pushRequestId: 'stable-event' } }
  };
  await emitter.createAndEmitNotification({
    recipient,
    type: 'system',
    title: 'Existing durable row',
    message: 'Recover delivery',
    data: { customData: { notificationDedupeKey: 'stable-event', pushRequestId: 'stable-event' } }
  });
  assert.equal(inAppCreates, 6, 'dedupe retries must reuse the existing inbox row');
  assert.equal(pushes, 6, 'dedupe retries must revisit the stable durable push request');
  assert.equal(outboxClaims, 6, 'every push must own a durable outbox lease before provider submission');
  assert.equal(outboxCompletions, 6, 'successful submissions must complete their outbox lease');
  existingNotification = null;

  const channels = emitter.resolveNotificationChannels(
    { type: 'like' },
    { inAppEnabled: false, pushEnabled: true, likes: true }
  );
  assert.deepEqual({ inApp: channels.inApp, push: channels.push }, { inApp: false, push: true });

  console.log('Notification emitter channel independence tests passed');
};

run()
  .finally(() => {
    User.findById = originals.userFindById;
    Notification.findOne = originals.findNotification;
    Notification.createNotification = originals.createNotification;
    Notification.claimPushDelivery = originals.claimPushDelivery;
    Notification.completePushDelivery = originals.completePushDelivery;
    Notification.retryPushDelivery = originals.retryPushDelivery;
    pushService.sendPushNotification = originals.sendPushNotification;
    jobQueue.enqueueEmail = originals.enqueueEmail;
    if (previousSmtpUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = previousSmtpUser;
    if (previousSmtpPass === undefined) delete process.env.SMTP_PASS;
    else process.env.SMTP_PASS = previousSmtpPass;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
