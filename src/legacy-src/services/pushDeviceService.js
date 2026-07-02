const mongoose = require('mongoose');
const { createHash } = require('crypto');
const log = require('../utils/logger');
const PushDevice = require('../models/PushDevice');
const User = require('../models/User');

const hashPushToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const previewPushToken = (token) => {
  const value = String(token || '');
  return value.length <= 18 ? '[redacted]' : `${value.slice(0, 10)}...${value.slice(-6)}`;
};
const hashOptionalToken = (token) => token ? hashPushToken(token) : '';
const normalizeVoipToken = (token) => String(token || '').replace(/[<>\s]/g, '').toLowerCase();
const normalizeNativeToken = (token) => String(token || '').trim().slice(0, 2048);
const TOMBSTONE_RETENTION_MS = Math.max(7, Math.min(365, Number(process.env.PUSH_DEVICE_TOMBSTONE_DAYS || 90))) * 24 * 60 * 60 * 1000;
const getNativeProvider = (input) => {
  const type = String(input.nativeTokenType || '').trim().toLowerCase();
  if (type === 'fcm' || type === 'gcm') return 'fcm';
  if (type === 'apns') return 'apns';
  if (input.platform === 'android') return 'fcm';
  if (input.platform === 'ios') return 'apns';
  return '';
};
const legacyInstallationId = (tokenHash) => `legacy:${tokenHash.slice(0, 48)}`;

const embeddedToken = (input, now = new Date()) => ({
  token: input.token,
  installationId: input.installationId,
  provider: 'expo',
  platform: input.platform,
  deviceName: input.deviceName,
  deviceModel: input.deviceModel,
  deviceBrand: input.deviceBrand,
  manufacturer: input.manufacturer,
  deviceType: input.deviceType,
  osName: input.osName,
  osVersion: input.osVersion,
  projectId: input.projectId,
  appVersion: input.appVersion,
  buildVersion: input.buildVersion,
  nativeToken: { type: input.nativeTokenType || '', data: '' },
  lastUsedAt: now,
  createdAt: now,
  failureCount: 0
});

const canonicalDevice = (userId, input, now = new Date()) => ({
  user: userId,
  installationId: input.installationId,
  provider: 'expo',
  token: input.token,
  tokenHash: hashPushToken(input.token),
  tokenPreview: previewPushToken(input.token),
  platform: input.platform,
  deviceName: input.deviceName,
  deviceModel: input.deviceModel,
  deviceBrand: input.deviceBrand,
  manufacturer: input.manufacturer,
  deviceType: input.deviceType,
  osName: input.osName,
  osVersion: input.osVersion,
  projectId: input.projectId,
  appVersion: input.appVersion,
  buildVersion: input.buildVersion,
  nativeTokenType: input.nativeTokenType || '',
  nativeToken: input.nativeToken || '',
  nativeTokenHash: hashOptionalToken(input.nativeToken),
  nativeTokenPreview: input.nativeToken ? previewPushToken(input.nativeToken) : '',
  status: 'active',
  failureCount: 0,
  lastRegisteredAt: now,
  lastSeenAt: now,
  invalidatedAt: null,
  invalidReason: '',
  purgeAt: null
});

const canonicalNativeToken = (input, now = new Date()) => {
  const token = normalizeNativeToken(input.nativeToken);
  const provider = token ? getNativeProvider(input) : '';
  if (!provider) return { provider: '', token: '', tokenHash: '', set: {}, unset: {} };
  const tokenHash = hashPushToken(token);
  const ownPrefix = provider === 'fcm' ? 'fcm' : 'apns';
  const otherPrefix = provider === 'fcm' ? 'apns' : 'fcm';
  return {
    provider,
    token,
    tokenHash,
    set: {
      [`${ownPrefix}Token`]: token,
      [`${ownPrefix}TokenHash`]: tokenHash,
      [`${ownPrefix}TokenPreview`]: previewPushToken(token),
      [`${ownPrefix}TokenUpdatedAt`]: now
    },
    unset: {
      [`${otherPrefix}Token`]: 1,
      [`${otherPrefix}TokenHash`]: 1
    },
    clear: {
      [`${otherPrefix}TokenPreview`]: '',
      [`${otherPrefix}TokenUpdatedAt`]: null
    }
  };
};

const writeOwnership = async (userId, input, session) => {
  const now = new Date();
  const tokenHash = hashPushToken(input.token);
  const native = canonicalNativeToken(input, now);
  const queryOptions = session ? { session } : {};
  const existing = await PushDevice.find({
    $or: [
      { installationId: input.installationId },
      { tokenHash },
      ...(native.provider === 'fcm' ? [{ fcmTokenHash: native.tokenHash }] : []),
      ...(native.provider === 'apns' ? [{ apnsTokenHash: native.tokenHash }] : [])
    ]
  }).select('+token').session(session || null);
  const supersededTokens = existing.map((device) => device.token).filter(Boolean);
  const conflictingIds = existing
    .filter((device) => device.installationId !== input.installationId)
    .map((device) => device._id);
  if (conflictingIds.length) await PushDevice.deleteMany({ _id: { $in: conflictingIds } }, queryOptions);

  await PushDevice.findOneAndUpdate(
    { installationId: input.installationId },
    {
      $set: {
        ...canonicalDevice(userId, input, now),
        ...native.set,
        ...native.clear
      },
      ...(native.provider ? { $unset: native.unset } : {})
    },
    { upsert: true, new: true, runValidators: true, ...queryOptions }
  );

  const tokenSet = Array.from(new Set([...supersededTokens, input.token]));
  await User.updateMany(
    {
      $or: [
        { 'pushTokens.token': { $in: tokenSet } },
        { 'pushTokens.installationId': input.installationId }
      ]
    },
    {
      $pull: {
        pushTokens: {
          $or: [
            { token: { $in: tokenSet } },
            { installationId: input.installationId }
          ]
        }
      }
    },
    queryOptions
  );
  await User.updateOne(
    { _id: userId },
    { $push: { pushTokens: embeddedToken(input, now) } },
    queryOptions
  );
};

const isTransactionUnsupported = (error) => /Transaction numbers are only allowed|replica set|mongos/i.test(String(error?.message || error));

const runOwnershipMutation = async (label, operation) => {
  let session;
  try {
    session = await mongoose.startSession();
    let value;
    await session.withTransaction(async () => { value = await operation(session); }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    });
    return value;
  } catch (error) {
    if (!isTransactionUnsupported(error)) throw error;
    log.warn(`${label} transaction unavailable; using ordered tombstone fallback`);
    return operation(null);
  } finally {
    if (session) await session.endSession().catch(() => undefined);
  }
};

const tombstoneUpdate = (status, reason) => ({
  $set: {
    status,
    invalidatedAt: new Date(),
    invalidReason: String(reason || status).slice(0, 300),
    lastFailedAt: new Date(),
    fcmTokenPreview: '',
    fcmTokenUpdatedAt: null,
    apnsTokenPreview: '',
    apnsTokenUpdatedAt: null,
    voipTokenPreview: '',
    voipTokenUpdatedAt: null,
    nativeTokenPreview: '',
    purgeAt: new Date(Date.now() + TOMBSTONE_RETENTION_MS)
  },
  $unset: {
    token: 1,
    nativeToken: 1,
    nativeTokenHash: 1,
    fcmToken: 1,
    fcmTokenHash: 1,
    apnsToken: 1,
    apnsTokenHash: 1,
    voipToken: 1,
    voipTokenHash: 1
  }
});

const registerPushDevice = async (userId, input) => {
  let session;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(() => writeOwnership(userId, input, session), {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    });
  } catch (error) {
    if (!isTransactionUnsupported(error)) throw error;
    log.warn('Push installation ownership transaction unavailable; using unique-index fallback', {
      userId: String(userId),
      installationId: input.installationId
    });
    await writeOwnership(userId, input, null);
  } finally {
    if (session) await session.endSession().catch(() => undefined);
  }
  return getPushDevicesForUser(userId, { selfHeal: false });
};

const getPushDevicesForUser = async (userId, { selfHeal = true } = {}) => {
  const [devices, user] = await Promise.all([
    PushDevice.find({ user: userId, status: 'active' }).select('+token').lean(),
    User.findById(userId).select('pushTokens').lean()
  ]);
  const legacy = Array.isArray(user?.pushTokens) ? user.pushTokens : [];
  const legacyHashes = legacy
    .map((entry) => entry?.token)
    .filter(Boolean)
    .map((token) => hashPushToken(token));
  const legacyInstallations = legacy.map((entry) => entry?.installationId).filter(Boolean);
  const canonicalForLegacy = legacyHashes.length || legacyInstallations.length
    ? await PushDevice.find({
        $or: [
          ...(legacyHashes.length ? [{ tokenHash: { $in: legacyHashes } }] : []),
          ...(legacyInstallations.length ? [{ installationId: { $in: legacyInstallations } }] : [])
        ]
      }).select('user tokenHash installationId status').lean()
    : [];
  const ownerByHash = new Map(canonicalForLegacy.map((device) => [device.tokenHash, device]));
  const canonicalByInstallation = new Map(canonicalForLegacy.map((device) => [device.installationId, device]));
  const result = new Map(devices.filter((device) => device.token).map((device) => [device.tokenHash, device]));
  const healOperations = [];
  for (const entry of legacy) {
    if (!entry?.token) continue;
    const tokenHash = hashPushToken(entry.token);
    if (result.has(tokenHash)) continue;
    const canonicalOwner = ownerByHash.get(tokenHash);
    if (canonicalOwner && (
      String(canonicalOwner.user) !== String(userId) || canonicalOwner.status !== 'active'
    )) continue;
    const installationId = entry.installationId || legacyInstallationId(tokenHash);
    const installationOwner = canonicalByInstallation.get(installationId);
    if (installationOwner && (
      installationOwner.status !== 'active' ||
      String(installationOwner.user) !== String(userId) || installationOwner.tokenHash !== tokenHash
    )) continue;
    const normalized = {
      token: entry.token,
      tokenHash,
      tokenPreview: previewPushToken(entry.token),
      installationId,
      provider: 'expo',
      platform: entry.platform || 'unknown',
      deviceName: entry.deviceName || '',
      deviceModel: entry.deviceModel || '',
      deviceBrand: entry.deviceBrand || '',
      manufacturer: entry.manufacturer || '',
      deviceType: entry.deviceType || '',
      osName: entry.osName || '',
      osVersion: entry.osVersion || '',
      projectId: entry.projectId || '',
      appVersion: entry.appVersion || '',
      buildVersion: entry.buildVersion || '',
      nativeTokenType: entry.nativeToken?.type || '',
      nativeTokenHash: hashOptionalToken(entry.nativeToken?.data),
      nativeTokenPreview: entry.nativeToken?.data ? previewPushToken(entry.nativeToken.data) : '',
      status: 'active',
      lastRegisteredAt: entry.lastUsedAt || entry.createdAt || new Date(),
      lastSeenAt: entry.lastUsedAt || entry.createdAt || new Date(),
      user: userId
    };
    result.set(tokenHash, normalized);
    if (selfHeal && !canonicalOwner) {
      healOperations.push({
        updateOne: {
          filter: { tokenHash },
          update: { $setOnInsert: normalized },
          upsert: true
        }
      });
    }
  }
  if (healOperations.length) {
    await PushDevice.bulkWrite(healOperations, { ordered: false }).catch((error) => {
      if (error?.code !== 11000) log.warn('Legacy push-device self-heal failed', { error: String(error) });
    });
  }
  return Array.from(result.values());
};

const removePushDevices = async (userId, { token, installationId } = {}) => {
  if (!token && !installationId) return { removed: 0 };
  const tokenHash = token ? hashPushToken(token) : '';
  const deviceFilter = {
    user: userId,
    ...(tokenHash && installationId
      ? { $or: [{ tokenHash }, { installationId }] }
      : tokenHash ? { tokenHash } : { installationId })
  };
  return runOwnershipMutation('Push logout', async (session) => {
    const queryOptions = session ? { session } : {};
    const devices = await PushDevice.find(deviceFilter).select('+token').session(session || null).lean();
    const tokens = Array.from(new Set([token, ...devices.map((device) => device.token)].filter(Boolean)));
    const installations = Array.from(new Set([installationId, ...devices.map((device) => device.installationId)].filter(Boolean)));
    const tombstoned = await PushDevice.updateMany(deviceFilter, tombstoneUpdate('disabled', 'LoggedOut'), queryOptions);
    await User.updateOne(
      { _id: userId },
      {
        $pull: {
          pushTokens: {
            $or: [
              ...(tokens.length ? [{ token: { $in: tokens } }] : []),
              ...(installations.length ? [{ installationId: { $in: installations } }] : [])
            ]
          }
        }
      },
      queryOptions
    );
    return { removed: Math.max(Number(tombstoned.modifiedCount || 0), tokens.length) };
  });
};

const removeAllPushDevicesForUser = async (userId) => {
  return runOwnershipMutation('Push account cleanup', async (session) => {
    const queryOptions = session ? { session } : {};
    const tombstoned = await PushDevice.updateMany(
      { user: userId },
      tombstoneUpdate('disabled', 'AccountRemoved'),
      queryOptions
    );
    await User.updateOne(
      { _id: userId },
      { $set: { pushTokens: [], notificationClients: [] } },
      queryOptions
    );
    return { removed: Number(tombstoned.modifiedCount || 0) };
  });
};

const registerVoipToken = async (userId, installationId, rawToken) => {
  const voipToken = normalizeVoipToken(rawToken);
  if (!/^[a-f\d]{64,512}$/.test(voipToken)) {
    const error = new Error('Invalid APNs VoIP token');
    error.statusCode = 400;
    throw error;
  }
  const voipTokenHash = hashPushToken(voipToken);
  const device = await PushDevice.findOne({ user: userId, installationId, platform: 'ios', status: 'active' }).select('_id');
  if (!device) {
    const error = new Error('Register the iOS push installation before its VoIP token');
    error.statusCode = 409;
    throw error;
  }

  // A PushKit token identifies one app installation. Remove stale ownership
  // before assigning it so account switches and reinstalls cannot duplicate it.
  await PushDevice.updateMany(
    { _id: { $ne: device._id }, voipTokenHash },
    {
      $unset: { voipToken: 1, voipTokenHash: 1 },
      $set: { voipTokenPreview: '', voipTokenUpdatedAt: null }
    }
  );
  await PushDevice.updateOne(
    { _id: device._id, user: userId },
    {
      $set: {
        voipToken,
        voipTokenHash,
        voipTokenPreview: previewPushToken(voipToken),
        voipTokenUpdatedAt: new Date(),
        lastSeenAt: new Date()
      }
    }
  );
  return PushDevice.findById(device._id).select('-token -nativeToken -voipToken').lean();
};

const removeVoipToken = async (userId, { installationId, token } = {}) => {
  const normalized = normalizeVoipToken(token);
  const voipTokenHash = normalized ? hashPushToken(normalized) : '';
  const filter = {
    user: userId,
    ...(installationId && voipTokenHash
      ? { $or: [{ installationId }, { voipTokenHash }] }
      : installationId ? { installationId } : { voipTokenHash })
  };
  const result = await PushDevice.updateMany(
    filter,
    {
      $unset: { voipToken: 1, voipTokenHash: 1 },
      $set: { voipTokenPreview: '', voipTokenUpdatedAt: null }
    }
  );
  return { removed: Number(result.modifiedCount || 0) };
};

const invalidateVoipTokensByHash = async (records, reason = 'Unregistered') => {
  const hashes = Array.from(new Set((records || []).map((record) => record?.voipTokenHash).filter(Boolean)));
  if (!hashes.length) return 0;
  const devices = await PushDevice.find({ voipTokenHash: { $in: hashes } }).select('user installationId voipTokenHash').lean();
  await PushDevice.updateMany(
    { voipTokenHash: { $in: hashes } },
    {
      $unset: { voipToken: 1, voipTokenHash: 1 },
      $set: { voipTokenPreview: '', voipTokenUpdatedAt: null, lastFailedAt: new Date() }
    }
  );
  for (const device of devices) {
    log.info('Invalid APNs VoIP token removed', {
      userId: String(device.user),
      installationId: String(device.installationId).slice(0, 12),
      tokenHash: String(device.voipTokenHash).slice(0, 12),
      reason
    });
  }
  return devices.length;
};

const invalidatePushDevicesByHash = async (records, reason = 'DeviceNotRegistered') => {
  const normalized = (records || []).filter((record) => record?.recipient && record?.tokenHash);
  if (!normalized.length) return 0;
  let removed = 0;
  for (const record of normalized) {
    const invalidated = await runOwnershipMutation('Invalid push cleanup', async (session) => {
      const filter = { user: record.recipient, tokenHash: record.tokenHash };
      const queryOptions = session ? { session } : {};
      const devices = await PushDevice.find(filter).select('+token').session(session || null).lean();
      const legacyUser = await User.findById(record.recipient).select('pushTokens').session(session || null).lean();
      const tokens = [
        ...devices.map((device) => device.token),
        ...((legacyUser?.pushTokens || [])
          .filter((entry) => entry?.token && hashPushToken(entry.token) === record.tokenHash)
          .map((entry) => entry.token))
      ].filter(Boolean);
      const result = await PushDevice.updateMany(filter, tombstoneUpdate('invalid', reason), queryOptions);
      if (tokens.length) {
        await User.updateOne(
          { _id: record.recipient },
          { $pull: { pushTokens: { token: { $in: tokens } } } },
          queryOptions
        );
      }
      return Number(result.modifiedCount || 0) || (tokens.length ? 1 : 0);
    });
    removed += invalidated;
    log.info('Invalid push installation removed', {
      userId: String(record.recipient),
      tokenHash: record.tokenHash.slice(0, 12),
      reason
    });
  }
  return removed;
};

const recordPushDeviceOutcome = async (records, delivered) => {
  const now = new Date();
  for (const record of records || []) {
    if (!record?.recipient || !record?.tokenHash) continue;
    await PushDevice.updateOne(
      { user: record.recipient, tokenHash: record.tokenHash, status: 'active' },
      delivered
        ? { $set: { lastDeliveredAt: now, lastSeenAt: now, failureCount: 0 } }
        : { $set: { lastFailedAt: now }, $inc: { failureCount: 1 } }
    );
  }
};

module.exports = {
  hashPushToken,
  previewPushToken,
  legacyInstallationId,
  registerPushDevice,
  getPushDevicesForUser,
  removePushDevices,
  removeAllPushDevicesForUser,
  registerVoipToken,
  removeVoipToken,
  invalidatePushDevicesByHash,
  invalidateVoipTokensByHash,
  recordPushDeviceOutcome
};
