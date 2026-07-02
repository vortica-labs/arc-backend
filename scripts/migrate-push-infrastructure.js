#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { createHash, randomUUID } = require('crypto');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}

const verifyOnly = process.argv.includes('--verify');
const modelRoot = path.resolve(__dirname, '..', 'src', 'legacy-src', 'models');
const User = require(path.join(modelRoot, 'User.js'));
const PushDevice = require(path.join(modelRoot, 'PushDevice.js'));
const PushDeliveryAttempt = require(path.join(modelRoot, 'PushDeliveryAttempt.js'));
const PushDeliveryRequest = require(path.join(modelRoot, 'PushDeliveryRequest.js'));
const CallSession = require(path.join(modelRoot, 'CallSession.js'));
const CallVoipPushAttempt = require(path.join(modelRoot, 'CallVoipPushAttempt.js'));
const Notification = require(path.join(modelRoot, 'Notification.js'));
const { Message } = require(path.join(modelRoot, 'Message.js'));
const expoTokenPattern = /^ExponentPushToken\[[\w-]+\]$|^ExpoPushToken\[[\w-]+\]$/;
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const preview = (value) => String(value).length > 18
  ? `${String(value).slice(0, 10)}...${String(value).slice(-6)}`
  : '[redacted]';

const connect = () => mongoose.connect(uri, {
  autoIndex: false,
  autoCreate: false,
  retryWrites: process.env.MONGODB_TLS === 'true' ? false : true,
  serverSelectionTimeoutMS: 15000,
  ...(process.env.MONGODB_TLS === 'true' ? {
    tls: true,
    ...(process.env.MONGODB_TLS_CA_FILE && fs.existsSync(process.env.MONGODB_TLS_CA_FILE)
      ? { tlsCAFile: process.env.MONGODB_TLS_CA_FILE }
      : {})
  } : {})
});

const dedupeEmbeddedInstallations = async () => {
  const duplicates = await User.aggregate([
    { $unwind: '$pushTokens' },
    { $match: { 'pushTokens.installationId': { $type: 'string', $ne: '' } } },
    {
      $group: {
        _id: '$pushTokens.installationId',
        entries: { $push: { user: '$_id', token: '$pushTokens' } },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).allowDiskUse(true);
  for (const duplicate of duplicates) {
    const ordered = duplicate.entries.sort((left, right) =>
      new Date(right.token.lastUsedAt || right.token.createdAt || 0).getTime() -
      new Date(left.token.lastUsedAt || left.token.createdAt || 0).getTime());
    const winner = ordered[0];
    await User.updateMany(
      { 'pushTokens.installationId': duplicate._id },
      { $pull: { pushTokens: { installationId: duplicate._id } } }
    );
    await User.updateOne({ _id: winner.user }, { $push: { pushTokens: winner.token } });
    console.log(`resolved duplicate installation ${duplicate._id} (${duplicate.count} rows)`);
  }
};

const backfillDevices = async () => {
  let users = 0;
  let devices = 0;
  const cursor = User.find({ 'pushTokens.0': { $exists: true } }).select('_id pushTokens').lean().cursor();
  for await (const user of cursor) {
    users += 1;
    for (const tokenEntry of user.pushTokens || []) {
      const token = String(tokenEntry?.token || '').trim();
      if (!expoTokenPattern.test(token)) continue;
      const tokenHash = hash(token);
      const installationId = String(tokenEntry.installationId || `legacy:${tokenHash.slice(0, 48)}`).slice(0, 200);
      const nativeToken = String(tokenEntry.nativeToken?.data || '').slice(0, 2048);
      const nativeType = String(tokenEntry.nativeToken?.type || '').toLowerCase();
      const platform = ['ios', 'android', 'web'].includes(tokenEntry.platform) ? tokenEntry.platform : 'unknown';
      const nativeProvider = nativeToken && (nativeType === 'fcm' || nativeType === 'gcm' || platform === 'android')
        ? 'fcm'
        : nativeToken && (nativeType === 'apns' || platform === 'ios') ? 'apns' : '';
      const nativeProviderFields = nativeProvider ? {
        [`${nativeProvider}Token`]: nativeToken,
        [`${nativeProvider}TokenHash`]: hash(nativeToken),
        [`${nativeProvider}TokenPreview`]: preview(nativeToken),
        [`${nativeProvider}TokenUpdatedAt`]: tokenEntry.lastUsedAt || tokenEntry.createdAt || new Date()
      } : {};
      try {
        await PushDevice.updateOne(
          { tokenHash, user: user._id },
          {
            $setOnInsert: {
              user: user._id,
              installationId,
              provider: 'expo',
              token,
              tokenHash,
              tokenPreview: preview(token),
              platform,
              deviceName: String(tokenEntry.deviceName || '').slice(0, 120),
              deviceModel: String(tokenEntry.deviceModel || '').slice(0, 120),
              deviceBrand: String(tokenEntry.deviceBrand || '').slice(0, 120),
              manufacturer: String(tokenEntry.manufacturer || '').slice(0, 120),
              deviceType: String(tokenEntry.deviceType || '').slice(0, 40),
              osName: String(tokenEntry.osName || '').slice(0, 40),
              osVersion: String(tokenEntry.osVersion || '').slice(0, 40),
              projectId: String(tokenEntry.projectId || '').slice(0, 120),
              appVersion: String(tokenEntry.appVersion || '').slice(0, 40),
              buildVersion: String(tokenEntry.buildVersion || '').slice(0, 40),
              nativeTokenType: String(tokenEntry.nativeToken?.type || '').slice(0, 40),
              nativeToken,
              nativeTokenHash: nativeToken ? hash(nativeToken) : '',
              nativeTokenPreview: nativeToken ? preview(nativeToken) : '',
              status: 'active',
              lastRegisteredAt: tokenEntry.lastUsedAt || tokenEntry.createdAt || new Date(),
              lastSeenAt: tokenEntry.lastUsedAt || tokenEntry.createdAt || new Date()
            },
            ...(nativeProvider ? { $set: nativeProviderFields } : {})
          },
          { upsert: true }
        );
        devices += 1;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        console.warn(`skipped conflicting legacy push token ${tokenHash.slice(0, 12)}`);
      }
    }
  }
  console.log(`backfilled ${devices} token rows from ${users} users`);
};

const dedupeCanonicalDevices = async () => {
  for (const field of ['tokenHash', 'installationId', 'fcmTokenHash', 'apnsTokenHash', 'voipTokenHash']) {
    const duplicates = await PushDevice.aggregate([
      { $match: { [field]: { $type: 'string', $ne: '' } } },
      { $sort: { lastSeenAt: -1, updatedAt: -1, _id: 1 } },
      { $group: { _id: `$${field}`, ids: { $push: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]).allowDiskUse(true);
    for (const duplicate of duplicates) {
      const losingIds = duplicate.ids.slice(1);
      if (field === 'tokenHash' || field === 'installationId') {
        await PushDevice.deleteMany({ _id: { $in: losingIds } });
      } else {
        const prefix = field.replace(/TokenHash$/, '');
        await PushDevice.updateMany(
          { _id: { $in: losingIds } },
          {
            $unset: { [`${prefix}Token`]: 1, [field]: 1 },
            $set: { [`${prefix}TokenPreview`]: '', [`${prefix}TokenUpdatedAt`]: null }
          }
        );
      }
      console.log(`resolved ${duplicate.count - 1} duplicate PushDevice ${field} rows`);
    }
  }
};

const normalizeObject = (value) => {
  if (Array.isArray(value)) return value.map(normalizeObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeObject(value[key])]));
};
const normalizeKey = (key) => JSON.stringify(Object.entries(key || {}));
const verifyIndexes = async (Model) => {
  const actual = await Model.collection.indexes();
  const missing = Model.schema.indexes().filter(([key, options]) => !actual.some((index) =>
    normalizeKey(index.key) === normalizeKey(key) &&
    Boolean(index.unique) === Boolean(options.unique) &&
    Boolean(index.sparse) === Boolean(options.sparse) &&
    JSON.stringify(normalizeObject(index.partialFilterExpression || null)) ===
      JSON.stringify(normalizeObject(options.partialFilterExpression || null)) &&
    Number(index.expireAfterSeconds ?? -1) === Number(options.expireAfterSeconds ?? -1)
  ));
  if (missing.length) throw new Error(`${Model.modelName} is missing ${missing.length} declared index(es)`);
  console.log(`verified ${Model.modelName}: ${Model.schema.indexes().length} declared indexes`);
};

const dedupeNotificationDeliveryKeys = async () => {
  const duplicates = await Notification.aggregate([
    { $match: { 'data.customData.notificationDedupeKey': { $type: 'string', $ne: '' } } },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $group: {
        _id: {
          recipient: '$recipient',
          key: '$data.customData.notificationDedupeKey'
        },
        ids: { $push: '$_id' },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).allowDiskUse(true);
  for (const duplicate of duplicates) {
    await Notification.updateMany(
      { _id: { $in: duplicate.ids.slice(1) } },
      { $unset: { 'data.customData.notificationDedupeKey': 1 } }
    );
    console.log(`resolved ${duplicate.count - 1} duplicate Notification delivery keys`);
  }
};

const reconcileMessageNotificationCoalesceKeys = async () => {
  const duplicates = await Notification.aggregate([
    {
      $match: {
        type: 'message',
        isRead: false,
        deletedAt: null,
        archivedAt: null,
        sender: { $ne: null },
        'data.customData.conversationId': { $type: 'string', $ne: '' }
      }
    },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $group: {
        _id: {
          recipient: '$recipient',
          sender: '$sender',
          conversationId: '$data.customData.conversationId'
        },
        ids: { $push: '$_id' },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } }
  ]).allowDiskUse(true);
  const now = new Date();
  for (const duplicate of duplicates) {
    await Notification.updateMany(
      { _id: { $in: duplicate.ids.slice(1) } },
      { $set: { isRead: true, readAt: now, archivedAt: now, deletedAt: now } }
    );
    console.log(`archived ${duplicate.count - 1} duplicate unread message notification row(s)`);
  }
  const cursor = Notification.find({
    type: 'message',
    isRead: false,
    deletedAt: null,
    archivedAt: null,
    sender: { $ne: null },
    'data.customData.conversationId': { $type: 'string', $ne: '' }
  }).select('_id recipient sender data.customData.conversationId').lean().cursor();
  let updated = 0;
  for await (const notification of cursor) {
    const conversationId = String(notification.data?.customData?.conversationId || '');
    const coalesceKey = `message-thread:${createHash('sha256')
      .update(`${String(notification.recipient)}:${String(notification.sender)}:${conversationId}`)
      .digest('hex')}`;
    await Notification.updateOne(
      { _id: notification._id },
      { $set: { 'data.customData.notificationCoalesceKey': coalesceKey } }
    );
    updated += 1;
  }
  console.log(`reconciled ${updated} unread message notification coalescing keys`);
};

const reconcileCallParticipantLeases = async () => {
  const now = new Date();
  const statePushMarker = () => ({
    statePushStatus: 'pending',
    statePushRevision: randomUUID(),
    statePushExcludeInstallationId: '',
    statePushAttempts: 0,
    statePushNextAttemptAt: new Date(),
    statePushLeaseAt: null,
    statePushLeaseKey: '',
    statePushLastError: '',
    statePushCompletedAt: null
  });
  const maximumDurationMs = Math.max(300, Math.min(86400, Number(process.env.MAX_CALL_DURATION_SECONDS || 14400))) * 1000;
  await CallSession.updateMany(
    { status: 'ringing', expiresAt: { $lte: now } },
    {
      $set: {
        status: 'missed',
        participantLeaseActive: false,
        missedAt: now,
        endedAt: now,
        endReason: 'timeout',
        ...statePushMarker()
      }
    }
  );
  const acceptedSessions = await CallSession.find({ status: 'accepted' })
    .select('_id acceptedAt activeUntil updatedAt createdAt')
    .lean();
  for (const session of acceptedSessions) {
    const base = new Date(session.acceptedAt || session.updatedAt || session.createdAt || now);
    const activeUntil = session.activeUntil
      ? new Date(session.activeUntil)
      : new Date(base.getTime() + maximumDurationMs);
    if (activeUntil <= now) {
      await CallSession.updateOne(
        { _id: session._id, status: 'accepted' },
        {
          $set: {
            status: 'ended', endedAt: now, endReason: 'max_duration',
            participantLeaseActive: false, activeUntil, ...statePushMarker()
          }
        }
      );
    } else {
      await CallSession.updateOne({ _id: session._id }, { $set: { activeUntil } });
    }
  }
  await CallSession.updateMany(
    { status: { $nin: ['ringing', 'accepted'] } },
    { $set: { participantLeaseActive: false } }
  );
  const active = await CallSession.find({
    $or: [
      { status: 'ringing', expiresAt: { $gt: now } },
      { status: 'accepted', activeUntil: { $gt: now } }
    ]
  })
    .select('_id caller callee status')
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  const claimedParticipants = new Set();
  for (const session of active) {
    const participants = [String(session.caller), String(session.callee)];
    const conflicts = participants.some((participant) => claimedParticipants.has(participant));
    if (conflicts) {
      await CallSession.updateOne(
        { _id: session._id, status: { $in: ['ringing', 'accepted'] } },
        {
          $set: {
            status: 'cancelled',
            participantLeaseActive: false,
            endedAt: new Date(),
            endReason: 'migration_participant_lease_conflict',
            ...statePushMarker()
          }
        }
      );
      continue;
    }
    participants.forEach((participant) => claimedParticipants.add(participant));
    await CallSession.updateOne(
      { _id: session._id },
      { $set: { participantLeaseKeys: [session.caller, session.callee], participantLeaseActive: true } }
    );
  }
  console.log(`reconciled ${active.length} active call participant leases`);
};

const backfillVoipProviderRequestIds = async () => {
  const cursor = CallVoipPushAttempt.find({
    $or: [
      { providerRequestId: { $exists: false } },
      { providerRequestId: '' },
      { providerRequestId: null }
    ]
  }).select('_id').lean().cursor();
  let updated = 0;
  for await (const attempt of cursor) {
    await CallVoipPushAttempt.updateOne(
      { _id: attempt._id },
      { $set: { providerRequestId: randomUUID() } }
    );
    updated += 1;
  }
  console.log(`backfilled ${updated} APNs provider request IDs`);
};

const verifyVoipProviderRequestIds = async () => {
  const missing = await CallVoipPushAttempt.countDocuments({
    $or: [
      { providerRequestId: { $exists: false } },
      { providerRequestId: '' },
      { providerRequestId: null }
    ]
  });
  if (missing) throw new Error(`${missing} APNs VoIP attempt(s) are missing providerRequestId`);
};

const verifyBackfill = async () => {
  let checked = 0;
  let batch = [];
  const verifyBatch = async () => {
    if (!batch.length) return;
    const hashes = Array.from(new Set(batch));
    const found = new Set(await PushDevice.distinct('tokenHash', { tokenHash: { $in: hashes } }));
    const missing = hashes.filter((tokenHash) => !found.has(tokenHash));
    if (missing.length) throw new Error(`PushDevice backfill is missing ${missing.length} legacy token hash(es)`);
    checked += batch.length;
    batch = [];
  };
  const cursor = User.find({ 'pushTokens.0': { $exists: true } }).select('pushTokens.token').lean().cursor();
  for await (const user of cursor) {
    for (const entry of user.pushTokens || []) {
      const token = String(entry?.token || '').trim();
      if (expoTokenPattern.test(token)) batch.push(hash(token));
      if (batch.length >= 500) await verifyBatch();
    }
  }
  await verifyBatch();
  console.log(`verified legacy token backfill: ${checked} token references`);
};

const dedupeMessageCallSummaries = async () => {
  const duplicates = await Message.aggregate([
    { $match: { 'callSummary.callId': { $type: 'string', $ne: '' } } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: '$callSummary.callId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).allowDiskUse(true);
  for (const duplicate of duplicates) {
    await Message.updateMany(
      { _id: { $in: duplicate.ids.slice(1) } },
      { $unset: { 'callSummary.callId': 1 } }
    );
    console.log(`resolved ${duplicate.count - 1} duplicate call-summary messages for ${duplicate._id}`);
  }
};

const verifyMessageCallSummaries = async () => {
  const [duplicate] = await Message.aggregate([
    { $match: { 'callSummary.callId': { $type: 'string', $ne: '' } } },
    { $group: { _id: '$callSummary.callId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 }
  ]);
  if (duplicate) throw new Error(`Duplicate Message.callSummary.callId remains: ${duplicate._id}`);
};

const verifyUserInstallationIndex = async () => {
  const indexes = await User.collection.indexes();
  const found = indexes.find((index) =>
    normalizeKey(index.key) === normalizeKey({ 'pushTokens.installationId': 1 }) && index.unique === true
  );
  if (!found) throw new Error('User is missing the unique pushTokens.installationId index');
  console.log('verified User push installation ownership index');
};

const main = async () => {
  await connect();
  if (!verifyOnly) {
    await dedupeEmbeddedInstallations();
    await dedupeCanonicalDevices();
    await backfillDevices();
    await dedupeCanonicalDevices();
    await dedupeNotificationDeliveryKeys();
    await reconcileMessageNotificationCoalesceKeys();
    await reconcileCallParticipantLeases();
    await backfillVoipProviderRequestIds();
    await dedupeMessageCallSummaries();
    await PushDevice.createIndexes();
    await PushDeliveryAttempt.createIndexes();
    await PushDeliveryRequest.createIndexes();
    await CallSession.createIndexes();
    await CallVoipPushAttempt.createIndexes();
    await Notification.createIndexes();
    await Message.createIndexes();
    await User.collection.createIndex(
      { 'pushTokens.installationId': 1 },
      {
        name: 'pushTokens.installationId_1',
        unique: true,
        partialFilterExpression: { 'pushTokens.installationId': { $type: 'string', $gt: '' } }
      }
    );
  }
  await verifyBackfill();
  await verifyVoipProviderRequestIds();
  await verifyMessageCallSummaries();
  await verifyUserInstallationIndex();
  await verifyIndexes(PushDevice);
  await verifyIndexes(PushDeliveryAttempt);
  await verifyIndexes(PushDeliveryRequest);
  await verifyIndexes(CallSession);
  await verifyIndexes(CallVoipPushAttempt);
  await verifyIndexes(Notification);
  await verifyIndexes(Message);
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
