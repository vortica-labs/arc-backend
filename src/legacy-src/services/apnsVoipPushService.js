const http2 = require('http2');
const { createHash, createPrivateKey, createSign, randomUUID } = require('crypto');
const PushDevice = require('../models/PushDevice');
const User = require('../models/User');
const CallVoipPushAttempt = require('../models/CallVoipPushAttempt');
const CallSession = require('../models/CallSession');
const PushDeliveryRequest = require('../models/PushDeliveryRequest');
const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
const { invalidateVoipTokensByHash } = require('./pushDeviceService');
const log = require('../utils/logger');

const MAX_ATTEMPTS = Math.max(1, Math.min(10, Number(process.env.APNS_VOIP_MAX_ATTEMPTS || 5)));
const REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.APNS_VOIP_REQUEST_TIMEOUT_MS || 10000));
const CONCURRENCY = Math.max(1, Math.min(50, Number(process.env.APNS_VOIP_CONCURRENCY || 10)));
const REQUEST_RECOVERY_MAX_ATTEMPTS = Math.max(1, Math.min(10, Number(process.env.PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS || 5)));
const REQUEST_RECOVERY_STALE_MS = 5000;
const INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS = Math.max(1, Math.min(20, Number(process.env.INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS || 5)));
const LEASE_MS = 2 * 60 * 1000;
// Only Unregistered is unambiguously device-terminal. BadDeviceToken and
// DeviceTokenNotForTopic can indicate a server environment/topic mistake; a
// bad deployment must never purge every otherwise-valid PushKit token.
const PERMANENT_TOKEN_ERRORS = new Set(['Unregistered']);
const RETRYABLE_REASONS = new Set(['IdleTimeout', 'InternalServerError', 'ServiceUnavailable', 'Shutdown', 'TooManyRequests']);

let cachedJwt = null;
let cachedJwtAt = 0;
let sweepTimer = null;

const mapWithConcurrency = async (items, concurrency, worker) => {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
  return results;
};

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const base64url = (value) => Buffer.from(value).toString('base64url');
const environment = () => String(process.env.APNS_ENVIRONMENT || '').toLowerCase() === 'sandbox' ||
  (String(process.env.APNS_ENVIRONMENT || '').toLowerCase() !== 'production' && process.env.NODE_ENV !== 'production')
  ? 'sandbox'
  : 'production';

const getPrivateKey = () => {
  const raw = String(process.env.APNS_PRIVATE_KEY || process.env.APNS_PRIVATE_KEY_BASE64 || '').trim();
  if (!raw) return '';
  if (raw.includes('BEGIN PRIVATE KEY')) return raw.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    return decoded.includes('BEGIN PRIVATE KEY') ? decoded : '';
  } catch {
    return '';
  }
};

const getConfig = () => ({
  teamId: String(process.env.APNS_TEAM_ID || '').trim(),
  keyId: String(process.env.APNS_KEY_ID || '').trim(),
  privateKey: getPrivateKey(),
  topic: String(process.env.APNS_VOIP_TOPIC || `${process.env.APNS_BUNDLE_ID || 'com.arcSquadHunt'}.voip`).trim(),
  environment: environment()
});

const isConfigured = (config = getConfig()) => Boolean(
  config.teamId && config.keyId && config.privateKey && config.topic
);

const assertConfigured = (config = getConfig()) => {
  if (!isConfigured(config)) throw new Error('APNs VoIP team ID, key ID, private key, and topic are required');
  const key = createPrivateKey(config.privateKey);
  if (key.asymmetricKeyType !== 'ec') throw new Error('APNs VoIP private key must be an EC .p8 key');
  if (!/^[A-Za-z0-9.-]+\.voip$/.test(config.topic)) throw new Error('APNs VoIP topic must be <bundle-id>.voip');
  return config;
};

const ensureVoipRequest = (recipientId, session, requestKey, payload) => {
  const now = new Date();
  return PushDeliveryRequest.findOneAndUpdate(
    { requestKey },
    {
      $setOnInsert: {
        requestKey,
        recipient: recipientId,
        source: 'call',
        notificationType: 'call',
        provider: 'apns_voip',
        payload,
        status: 'created',
        firstAttemptAt: now
      },
      $set: { lastAttemptAt: now }
    },
    { upsert: true, new: true, runValidators: true }
  );
};

const refreshVoipRequest = async (requestKey) => {
  const attempts = await CallVoipPushAttempt.find({ requestKey }).lean();
  if (!attempts.length) return;
  const accepted = attempts.filter((attempt) => attempt.status === 'accepted').length;
  const failed = attempts.filter((attempt) => attempt.status === 'failed' && attempt.retryable !== true).length;
  const retrying = attempts.some((attempt) => attempt.retryable === true && ['queued', 'sending', 'failed'].includes(attempt.status));
  const clientDelivered = attempts.filter((attempt) => attempt.clientDeliveredAt).length;
  const failure = attempts.find((attempt) => attempt.errorCode || attempt.errorMessage);
  const status = retrying ? 'retrying' : clientDelivered > 0 ? 'client_delivered' : accepted > 0 ? 'provider_accepted' : 'failed';
  const terminal = !retrying;
  await PushDeliveryRequest.updateOne(
    { requestKey },
    {
      $set: {
        status,
        targetedInstallations: attempts.length,
        submitted: attempts.filter((attempt) => Number(attempt.attempts || 0) > 0).length,
        accepted,
        failed,
        pendingReceipts: 0,
        retryCount: Math.max(0, ...attempts.map((attempt) => Number(attempt.attempts || 0) - 1)),
        reasonCode: String(failure?.errorCode || '').slice(0, 200),
        reasonMessage: String(failure?.errorMessage || '').slice(0, 1000),
        ...(terminal ? { completedAt: new Date() } : {})
      },
      ...(!terminal ? { $unset: { completedAt: 1 } } : {})
    }
  );
};

const skipVoipRequest = (requestKey, reasonCode, reasonMessage) => PushDeliveryRequest.updateOne(
  { requestKey },
  {
    $set: {
      status: 'skipped',
      reasonCode,
      reasonMessage,
      completedAt: new Date()
    }
  }
);

const getProviderJwt = (config) => {
  if (cachedJwt && Date.now() - cachedJwtAt < 45 * 60 * 1000) return cachedJwt;
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }));
  const unsigned = `${header}.${claims}`;
  const signer = createSign('SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign({ key: config.privateKey, dsaEncoding: 'ieee-p1363' });
  cachedJwt = `${unsigned}.${base64url(signature)}`;
  cachedJwtAt = Date.now();
  return cachedJwt;
};

const postToApns = (token, payload, nativeCallId, providerRequestId, config) => new Promise((resolve, reject) => {
  const origin = config.environment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  const client = http2.connect(origin);
  let request;
  let settled = false;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { request?.close(); } catch {}
    try { client.destroy(); } catch {}
    callback(value);
  };
  const timer = setTimeout(() => {
    const error = new Error('APNs VoIP request timed out');
    error.code = 'APNS_TIMEOUT';
    finish(reject, error);
  }, REQUEST_TIMEOUT_MS);
  client.once('error', (error) => finish(reject, error));
  request = client.request({
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    authorization: `bearer ${getProviderJwt(config)}`,
    'apns-topic': config.topic,
    'apns-push-type': 'voip',
    'apns-priority': '10',
    'apns-expiration': '0',
    'apns-collapse-id': nativeCallId,
    'apns-id': providerRequestId
  });
  let statusCode = 0;
  let apnsId = providerRequestId;
  let body = '';
  request.setEncoding('utf8');
  request.on('response', (headers) => {
    statusCode = Number(headers[':status'] || 0);
    apnsId = String(headers['apns-id'] || providerRequestId);
  });
  request.on('data', (chunk) => { body += chunk; });
  request.on('error', (error) => finish(reject, error));
  request.on('end', () => {
    let response = {};
    try { response = body ? JSON.parse(body) : {}; } catch { response = { body: body.slice(0, 1000) }; }
    finish(resolve, { statusCode, apnsId, response });
  });
  request.end(JSON.stringify(payload));
});

const retryDelay = (attempt) => Math.min(5 * 60 * 1000, 5000 * (2 ** Math.max(0, attempt - 1))) +
  Math.floor(Math.random() * 1000);

const claimAttempt = (id) => CallVoipPushAttempt.findOneAndUpdate(
  {
    _id: id,
    attempts: { $lt: MAX_ATTEMPTS },
    retryable: true,
    status: { $in: ['queued', 'failed', 'sending'] },
    $and: [
      { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }] },
      { $or: [{ leaseAt: null }, { leaseAt: { $lte: new Date(Date.now() - LEASE_MS) } }] }
    ]
  },
  {
    // Keep the attempt retryable while leased. If this process exits after the
    // claim, another worker can reclaim it once LEASE_MS elapses, provided the
    // durable call is still ringing.
    $set: { status: 'sending', leaseAt: new Date(), leaseKey: randomUUID(), retryable: true },
    $inc: { attempts: 1 },
    $unset: { nextAttemptAt: 1, errorCode: 1, errorMessage: 1 }
  },
  { new: true }
);

const enqueueTerminalIncomingFallback = async (attempt) => {
  if (attempt?.payload?.eventType === 'call_state_update') return;
  const device = await PushDevice.findOne({
    user: attempt.recipient,
    installationId: attempt.installationId,
    status: 'active'
  }).select('tokenHash').lean();
  if (!device?.tokenHash) return;
  const expiresAt = String(attempt.payload?.expiresAt || '');
  if (expiresAt && new Date(expiresAt) <= new Date()) return;
  await sendExpoFallbackForVoipFailure(attempt.recipient, {
    recipient: attempt.recipient,
    type: 'call',
    title: `${String(attempt.payload?.callerName || 'Someone').slice(0, 120)} is calling`,
    message: `Incoming ${attempt.payload?.callType === 'video' ? 'video' : 'voice'} call`,
    data: {
      customData: {
        ...attempt.payload,
        eventType: 'incoming_call',
        pushRequestId: `incoming-call:${attempt.callId}`,
        priority: 'high',
        pushOptions: { ttl: 30, priority: 'high', collapseKey: `incoming-call-${attempt.callId}` }
      }
    }
  }, {
    requestKey: attempt.requestKey,
    fallbackExpoTokenHashes: [device.tokenHash]
  });
};

const processVoipAttempt = async (attemptId) => {
  const attempt = await claimAttempt(attemptId);
  if (!attempt) return null;
  const session = await CallSession.findById(attempt.callSession).select('status expiresAt').lean();
  const isStateUpdate = attempt.payload?.eventType === 'call_state_update';
  if (isStateUpdate) {
    // PushKit is reserved for actual incoming calls. iOS 13+ requires every
    // VoIP push to be reported to CallKit; using it only to dismiss an existing
    // call can cause the OS to terminate the app or suppress future VoIP pushes.
    await CallVoipPushAttempt.updateOne(
      { _id: attempt._id, leaseKey: attempt.leaseKey },
      {
        $set: {
          status: 'failed', retryable: false, failedAt: new Date(),
          errorCode: 'PUSHKIT_STATE_UPDATE_DISABLED',
          errorMessage: 'Call-state updates use the standard APNs background channel'
        },
        $unset: { leaseAt: 1, leaseKey: 1, nextAttemptAt: 1 }
      }
    );
    return { accepted: false, retryable: false, reason: 'PUSHKIT_STATE_UPDATE_DISABLED' };
  }
  const expectedState = String(attempt.payload?.status || attempt.payload?.callStatus || '');
  const noLongerRelevant = isStateUpdate
    ? !session || session.status !== expectedState
    : !session || session.status !== 'ringing' || new Date(session.expiresAt) <= new Date();
  if (noLongerRelevant) {
    await CallVoipPushAttempt.updateOne(
      { _id: attempt._id, leaseKey: attempt.leaseKey },
      {
        $set: {
          status: 'failed', retryable: false, failedAt: new Date(),
          errorCode: isStateUpdate ? 'CALL_STATE_SUPERSEDED' : 'CALL_EXPIRED',
          errorMessage: isStateUpdate
            ? 'A newer durable call state superseded this APNs update'
            : 'Call stopped ringing before APNs accepted the VoIP push'
        },
        $unset: { leaseAt: 1, leaseKey: 1, nextAttemptAt: 1 }
      }
    );
    return { accepted: false, retryable: false, reason: isStateUpdate ? 'CALL_STATE_SUPERSEDED' : 'CALL_EXPIRED' };
  }
  const config = getConfig();
  if (!isConfigured(config)) {
    await CallVoipPushAttempt.updateOne(
      { _id: attempt._id, leaseKey: attempt.leaseKey },
      {
        $set: {
          status: 'failed', retryable: false, failedAt: new Date(),
          errorCode: 'APNS_VOIP_NOT_CONFIGURED',
          errorMessage: 'APNs team ID, key ID, private key, and VoIP topic are required',
          providerResponse: { configured: false }
        },
        $unset: { leaseAt: 1, leaseKey: 1, nextAttemptAt: 1 }
      }
    );
    await enqueueTerminalIncomingFallback(attempt).catch((error) => {
      log.error('Terminal APNs configuration fallback failed', { callId: attempt.callId, error: String(error) });
    });
    return { accepted: false, retryable: false, reason: 'APNS_VOIP_NOT_CONFIGURED' };
  }

  const device = await PushDevice.findOne({
    user: attempt.recipient,
    installationId: attempt.installationId,
    voipTokenHash: attempt.voipTokenHash,
    status: 'active'
  }).select('+voipToken').lean();
  if (!device?.voipToken) {
    await CallVoipPushAttempt.updateOne(
      { _id: attempt._id, leaseKey: attempt.leaseKey },
      {
        $set: { status: 'failed', retryable: false, failedAt: new Date(), errorCode: 'VOIP_TOKEN_MISSING', errorMessage: 'VoIP token was removed before delivery' },
        $unset: { leaseAt: 1, leaseKey: 1, nextAttemptAt: 1 }
      }
    );
    await enqueueTerminalIncomingFallback(attempt).catch((error) => {
      log.error('Missing PushKit token Expo fallback failed', { callId: attempt.callId, error: String(error) });
    });
    return { accepted: false, retryable: false, reason: 'VOIP_TOKEN_MISSING' };
  }

  try {
    const providerPayload = {
      ...attempt.payload,
      pushDeliveryAttemptId: String(attempt._id)
    };
    const result = await postToApns(
      device.voipToken,
      providerPayload,
      attempt.nativeCallId,
      attempt.providerRequestId || attempt.nativeCallId,
      config
    );
    const reason = String(result.response?.reason || '');
    if (result.statusCode === 200) {
      await CallVoipPushAttempt.updateOne(
        { _id: attempt._id, leaseKey: attempt.leaseKey },
        {
          $set: { status: 'accepted', retryable: false, acceptedAt: new Date(), apnsId: result.apnsId, providerResponse: { statusCode: result.statusCode, apnsId: result.apnsId } },
          $unset: { leaseAt: 1, leaseKey: 1, nextAttemptAt: 1, errorCode: 1, errorMessage: 1 }
        }
      );
      log.info('APNs VoIP push accepted', { callId: attempt.callId, userId: String(attempt.recipient), installationId: attempt.installationId.slice(0, 12), apnsId: result.apnsId });
      return { accepted: true, apnsId: result.apnsId };
    }

    const retryable = (
      result.statusCode === 0 || result.statusCode === 408 || result.statusCode === 429 ||
      result.statusCode >= 500 || RETRYABLE_REASONS.has(reason)
    ) && attempt.attempts < MAX_ATTEMPTS;
    const nextAttemptAt = retryable ? new Date(Date.now() + retryDelay(attempt.attempts)) : null;
    await CallVoipPushAttempt.updateOne(
      { _id: attempt._id, leaseKey: attempt.leaseKey },
      {
        $set: {
          status: 'failed', retryable, failedAt: new Date(), apnsId: result.apnsId,
          errorCode: reason || `APNS_${result.statusCode}`,
          errorMessage: reason || 'APNs rejected the VoIP push',
          providerResponse: { statusCode: result.statusCode, apnsId: result.apnsId, reason },
          ...(nextAttemptAt ? { nextAttemptAt } : {})
        },
        $unset: { leaseAt: 1, leaseKey: 1, ...(nextAttemptAt ? {} : { nextAttemptAt: 1 }) }
      }
    );
    if (PERMANENT_TOKEN_ERRORS.has(reason)) {
      await invalidateVoipTokensByHash([{ voipTokenHash: attempt.voipTokenHash }], reason);
    }
    if (!retryable) {
      await enqueueTerminalIncomingFallback(attempt).catch((error) => {
        log.error('Terminal APNs rejection fallback failed', { callId: attempt.callId, error: String(error) });
      });
    }
    return { accepted: false, retryable, reason };
  } catch (error) {
    const retryable = attempt.attempts < MAX_ATTEMPTS;
    const nextAttemptAt = retryable ? new Date(Date.now() + retryDelay(attempt.attempts)) : null;
    await CallVoipPushAttempt.updateOne(
      { _id: attempt._id, leaseKey: attempt.leaseKey },
      {
        $set: {
          status: 'failed', retryable, failedAt: new Date(),
          errorCode: String(error?.code || 'APNS_NETWORK_ERROR').slice(0, 200),
          errorMessage: String(error?.message || error).slice(0, 1000),
          providerResponse: { networkError: true },
          ...(nextAttemptAt ? { nextAttemptAt } : {})
        },
        $unset: { leaseAt: 1, leaseKey: 1, ...(nextAttemptAt ? {} : { nextAttemptAt: 1 }) }
      }
    );
    if (!retryable) {
      await enqueueTerminalIncomingFallback(attempt).catch((fallbackError) => {
        log.error('Terminal APNs network fallback failed', { callId: attempt.callId, error: String(fallbackError) });
      });
    }
    return { accepted: false, retryable, reason: String(error?.code || 'APNS_NETWORK_ERROR') };
  }
};

const sendVoipCallPush = async (recipientId, session, callPayload = {}) => {
  const requestKey = hash(`${session.callId}:${session.nativeCallId}:apns_voip`);
  const payload = {
    aps: { 'content-available': 1 },
    uuid: session.nativeCallId,
    callId: session.callId,
    callerId: String(session.caller),
    callerName: String(callPayload.callerName || session.callerSnapshot?.displayName || session.callerSnapshot?.username || 'Someone').slice(0, 120),
    handle: String(session.caller),
    hasVideo: session.callType === 'video',
    callType: session.callType,
    expiresAt: new Date(session.expiresAt).toISOString(),
    ...(session.randomRoomId ? { randomRoomId: session.randomRoomId } : {})
  };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 4096) throw new Error('APNs VoIP payload exceeds 4096 bytes');
  await ensureVoipRequest(recipientId, session, requestKey, payload);
  // PushKit is a transport, not a bypass around the recipient's preferences.
  // Calls share the existing `messages` preference bucket in the canonical
  // notification policy, so apply that decision before creating attempts.
  const recipient = await User.findById(recipientId).select('isActive notificationSettings').lean();
  if (!recipient || recipient.isActive === false) {
    await skipVoipRequest(requestKey, 'RECIPIENT_INACTIVE', 'Recipient is missing or inactive');
    return { submitted: 0, accepted: 0, failed: 0, reason: 'recipient_inactive' };
  }
  if (
    recipient.notificationSettings?.pushEnabled === false ||
    recipient.notificationSettings?.messages === false
  ) {
    await skipVoipRequest(requestKey, 'PUSH_DISABLED', 'Recipient disabled call push notifications');
    return { submitted: 0, accepted: 0, failed: 0, reason: 'push_disabled' };
  }
  const devices = await PushDevice.find({
    user: recipientId,
    platform: 'ios',
    status: 'active',
    voipTokenHash: { $type: 'string', $gt: '' }
  }).select('+voipToken').lean();
  if (!devices.length) {
    await skipVoipRequest(requestKey, 'NO_VOIP_TOKEN', 'No active iOS PushKit token is registered');
    return { requestKey, submitted: 0, accepted: 0, failed: 0, reason: 'no_voip_tokens' };
  }
  await PushDeliveryRequest.updateOne(
    { requestKey },
    {
      $set: { status: 'submitting', targetedInstallations: devices.length, reasonCode: '', reasonMessage: '' },
      $unset: { completedAt: 1 }
    }
  );
  const config = getConfig();
  const operations = devices.map((device) => ({
    updateOne: {
      filter: { requestKey, voipTokenHash: device.voipTokenHash },
      update: {
        $setOnInsert: {
          requestKey,
          callSession: session._id,
          callId: session.callId,
          nativeCallId: session.nativeCallId,
          providerRequestId: randomUUID(),
          recipient: recipientId,
          installationId: device.installationId,
          voipTokenHash: device.voipTokenHash,
          tokenPreview: device.voipTokenPreview,
          environment: config.environment,
          payload,
          status: 'queued',
          retryable: true,
          nextAttemptAt: new Date()
        }
      },
      upsert: true
    }
  }));
  await CallVoipPushAttempt.bulkWrite(operations, { ordered: false }).catch((error) => {
    if (error?.code !== 11000) throw error;
  });
  const attempts = await CallVoipPushAttempt.find({ requestKey }).select('_id voipTokenHash').lean();
  const results = await mapWithConcurrency(
    attempts,
    CONCURRENCY,
    (attempt) => processVoipAttempt(attempt._id)
  );
  await refreshVoipRequest(requestKey);
  const deviceByVoipHash = new Map(devices.map((device) => [device.voipTokenHash, device]));
  const fallbackExpoTokenHashes = attempts
    .filter((attempt, index) => results[index] && !results[index].accepted)
    .map((attempt) => deviceByVoipHash.get(attempt.voipTokenHash)?.tokenHash)
    .filter(Boolean);
  return {
    requestKey,
    submitted: attempts.length,
    accepted: results.filter((result) => result?.accepted).length,
    failed: results.filter((result) => result && !result.accepted).length,
    fallbackExpoTokenHashes
  };
};

const sendVoipCallStatePush = async () => {
  // Kept as a compatibility export for older workers. State reconciliation is
  // sent through the standard high-priority, content-available APNs channel;
  // PushKit is used only for a real incoming call that is reported to CallKit.
  return {
    requestKey: '', submitted: 0, accepted: 0, failed: 0,
    reason: 'pushkit_state_updates_disabled'
  };
};

const markVoipFallbackSent = async (requestKey, voipTokenHashes = []) => {
  const hashes = Array.from(new Set(voipTokenHashes.filter(Boolean)));
  if (!requestKey || !hashes.length) return;
  await CallVoipPushAttempt.updateMany(
    { requestKey, voipTokenHash: { $in: hashes }, status: 'failed' },
    {
      // A standard Expo/APNs alert cannot replace PushKit + CallKit for a
      // killed/locked device. Record the additive fallback, but preserve the
      // APNs VoIP retry schedule until APNs accepts or the durable call ends.
      $set: { fallbackSentAt: new Date(), fallbackProvider: 'expo' }
    }
  );
  await refreshVoipRequest(requestKey);
};

const getVoipFallbackExpoTokenHashes = async (recipientId) => {
  const devices = await PushDevice.find({
    user: recipientId,
    platform: 'ios',
    status: 'active',
    voipTokenHash: { $type: 'string', $gt: '' }
  }).select('tokenHash').lean();
  return devices.map((device) => device.tokenHash).filter(Boolean);
};

const sendExpoFallbackForVoipFailure = async (recipientId, notification, voipOutcome = null) => {
  const reported = Array.isArray(voipOutcome?.fallbackExpoTokenHashes)
    ? voipOutcome.fallbackExpoTokenHashes.filter((value) => /^[a-f\d]{64}$/i.test(String(value)))
    : [];
  const targetTokenHashes = reported.length
    ? reported
    : voipOutcome == null ? await getVoipFallbackExpoTokenHashes(recipientId) : [];
  if (!targetTokenHashes.length || !notification) return { submitted: 0, reason: 'no_fallback_targets' };
  const source = typeof notification?.toObject === 'function' ? notification.toObject() : notification;
  const { sendPushNotification } = require('../utils/pushNotificationService');
  const result = await sendPushNotification(recipientId, {
    ...source,
    pushAllowVoipFallback: true,
    pushTargetTokenHashes: targetTokenHashes
  });
  let requestKey = String(voipOutcome?.requestKey || '');
  if (!requestKey) {
    const callId = source?.data?.customData?.callId;
    const attempt = callId
      ? await CallVoipPushAttempt.findOne({ recipient: recipientId, callId }).select('requestKey').sort({ createdAt: -1 }).lean()
      : null;
    requestKey = String(attempt?.requestKey || '');
  }
  // Expo request submission is not success. Record the fallback only after an
  // accepted ticket for that installation; markVoipFallbackSent intentionally
  // keeps PushKit retries alive because an alert cannot replace CallKit.
  const acceptedExpoHashes = result?.requestKey
    ? await PushDeliveryAttempt.distinct('tokenHash', {
        requestKey: result.requestKey,
        tokenHash: { $in: targetTokenHashes },
        ticketStatus: 'accepted'
      })
    : [];
  if (acceptedExpoHashes.length && requestKey) {
    const fallbackDevices = await PushDevice.find({
      user: recipientId,
      tokenHash: { $in: acceptedExpoHashes },
      voipTokenHash: { $type: 'string', $gt: '' }
    }).select('voipTokenHash').lean();
    await markVoipFallbackSent(
      requestKey,
      fallbackDevices.map((device) => device.voipTokenHash)
    );
  }
  return result;
};

const initialVoipFallbackNotification = (session) => ({
  recipient: session.callee,
  type: 'call',
  title: `${String(session.callerSnapshot?.displayName || session.callerSnapshot?.username || 'Someone').slice(0, 120)} is calling`,
  message: `Incoming ${session.callType === 'video' ? 'video' : 'voice'} call`,
  data: {
    customData: {
      eventType: 'incoming_call',
      callId: session.callId,
      nativeCallId: session.nativeCallId,
      roomId: session.callId,
      callType: session.callType,
      callerId: String(session.caller),
      callerName: String(session.callerSnapshot?.displayName || session.callerSnapshot?.username || 'Someone').slice(0, 120),
      deadlineAt: new Date(session.expiresAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      pushRequestId: `incoming-call:${session.callId}`,
      priority: 'high',
      pushOptions: { ttl: 30, priority: 'high', collapseKey: `incoming-call-${session.callId}` }
    }
  }
});

const dispatchInitialVoipPush = async (session) => {
  if (!session?._id) return { submitted: 0, reason: 'missing_call_session' };
  const staleLease = new Date(Date.now() - LEASE_MS);
  const leaseKey = `initial-voip-${randomUUID()}`;
  const claimed = await CallSession.findOneAndUpdate(
    {
      _id: session._id,
      initialVoipPushAttempts: { $lt: INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS },
      $or: [
        {
          initialVoipPushStatus: 'pending',
          $or: [{ initialVoipPushNextAttemptAt: null }, { initialVoipPushNextAttemptAt: { $lte: new Date() } }]
        },
        { initialVoipPushStatus: 'processing', initialVoipPushLeaseAt: { $lte: staleLease } }
      ]
    },
    {
      $set: {
        initialVoipPushStatus: 'processing',
        initialVoipPushLeaseAt: new Date(),
        initialVoipPushLeaseKey: leaseKey,
        initialVoipPushNextAttemptAt: null
      },
      $inc: { initialVoipPushAttempts: 1 }
    },
    { new: true }
  );
  if (!claimed) return { submitted: 0, reason: 'initial_voip_not_claimable' };
  if (claimed.status !== 'ringing' || new Date(claimed.expiresAt) <= new Date()) {
    await CallSession.updateOne(
      { _id: claimed._id, initialVoipPushLeaseKey: leaseKey },
      {
        $set: {
          initialVoipPushStatus: 'completed',
          initialVoipPushCompletedAt: new Date(),
          initialVoipPushLastError: 'Call stopped ringing before initial VoIP dispatch',
          initialVoipPushLeaseAt: null,
          initialVoipPushLeaseKey: ''
        }
      }
    );
    return { submitted: 0, reason: 'call_not_ringing' };
  }
  try {
    const outcome = await sendVoipCallPush(claimed.callee, claimed, {
      callerName: claimed.callerSnapshot?.displayName || claimed.callerSnapshot?.username
    });
    await CallSession.updateOne(
      { _id: claimed._id, initialVoipPushLeaseKey: leaseKey },
      {
        $set: {
          initialVoipPushStatus: 'completed',
          initialVoipPushCompletedAt: new Date(),
          initialVoipPushLastError: '',
          initialVoipPushLeaseAt: null,
          initialVoipPushLeaseKey: ''
        }
      }
    );
    return outcome;
  } catch (error) {
    const exhausted = Number(claimed.initialVoipPushAttempts || 0) >= INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS;
    let fallbackSentAt = null;
    if (exhausted && claimed.status === 'ringing' && new Date(claimed.expiresAt) > new Date()) {
      const fallback = await sendExpoFallbackForVoipFailure(
        claimed.callee,
        initialVoipFallbackNotification(claimed),
        null
      ).catch(() => null);
      if (Number(fallback?.accepted || 0) > 0) fallbackSentAt = new Date();
    }
    const delayMs = Math.min(60_000, 2000 * (2 ** Math.max(0, Number(claimed.initialVoipPushAttempts || 1) - 1)));
    await CallSession.updateOne(
      { _id: claimed._id, initialVoipPushLeaseKey: leaseKey },
      {
        $set: {
          initialVoipPushStatus: exhausted ? 'failed' : 'pending',
          initialVoipPushLastError: String(error?.message || error).slice(0, 1000),
          initialVoipPushNextAttemptAt: exhausted ? null : new Date(Date.now() + delayMs),
          initialVoipPushLeaseAt: null,
          initialVoipPushLeaseKey: '',
          ...(fallbackSentAt ? { initialVoipFallbackSentAt: fallbackSentAt } : {})
        }
      }
    );
    throw error;
  }
};

const recoverInitialVoipPushes = async (limit = 200) => {
  const staleLease = new Date(Date.now() - LEASE_MS);
  const now = new Date();
  const exhaustedCandidates = await CallSession.find({
    initialVoipPushAttempts: { $gte: INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS },
    $or: [
      {
        initialVoipPushStatus: 'pending',
        $or: [{ initialVoipPushNextAttemptAt: null }, { initialVoipPushNextAttemptAt: { $lte: now } }]
      },
      { initialVoipPushStatus: 'processing', initialVoipPushLeaseAt: { $lte: staleLease } }
    ]
  }).limit(Math.max(1, Math.min(1000, limit)));
  for (const session of exhaustedCandidates) {
    const terminal = await CallSession.findOneAndUpdate(
      {
        _id: session._id,
        initialVoipPushAttempts: { $gte: INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS },
        $or: [
          {
            initialVoipPushStatus: 'pending',
            $or: [{ initialVoipPushNextAttemptAt: null }, { initialVoipPushNextAttemptAt: { $lte: now } }]
          },
          { initialVoipPushStatus: 'processing', initialVoipPushLeaseAt: { $lte: staleLease } }
        ]
      },
      {
        $set: {
          initialVoipPushStatus: 'failed',
          initialVoipPushLastError: 'Initial APNs VoIP outbox exhausted its retry budget',
          initialVoipPushNextAttemptAt: null,
          initialVoipPushLeaseAt: null,
          initialVoipPushLeaseKey: ''
        }
      },
      { new: true }
    );
    if (!terminal || terminal.status !== 'ringing' || new Date(terminal.expiresAt) <= now) continue;
    log.error('Initial APNs VoIP outbox retry budget exhausted', { callId: terminal.callId });
    const fallback = await sendExpoFallbackForVoipFailure(
      terminal.callee,
      initialVoipFallbackNotification(terminal),
      null
    ).catch(() => null);
    if (Number(fallback?.accepted || 0) > 0) {
      await CallSession.updateOne(
        { _id: terminal._id },
        { $set: { initialVoipFallbackSentAt: new Date() } }
      );
    }
  }
  const candidates = await CallSession.find({
    initialVoipPushAttempts: { $lt: INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS },
    $or: [
      {
        initialVoipPushStatus: 'pending',
        $or: [{ initialVoipPushNextAttemptAt: null }, { initialVoipPushNextAttemptAt: { $lte: now } }]
      },
      { initialVoipPushStatus: 'processing', initialVoipPushLeaseAt: { $lte: staleLease } }
    ]
  }).select('_id').sort({ initialVoipPushNextAttemptAt: 1, createdAt: 1 }).limit(Math.max(1, Math.min(1000, limit))).lean();
  const results = [];
  for (const candidate of candidates) {
    try {
      results.push(await dispatchInitialVoipPush(candidate));
    } catch (error) {
      results.push({ submitted: 0, failed: 1, reason: String(error?.code || 'INITIAL_VOIP_DISPATCH_FAILED') });
    }
  }
  return results;
};

const terminalizeExhaustedVoipAttempts = async (limit = 200) => {
  const staleLease = new Date(Date.now() - LEASE_MS);
  const candidates = await CallVoipPushAttempt.find({
    status: { $in: ['queued', 'failed', 'sending'] },
    retryable: true,
    attempts: { $gte: MAX_ATTEMPTS },
    $or: [
      { leaseAt: null },
      { leaseAt: { $lte: staleLease } }
    ]
  }).select('_id').limit(Math.max(1, Math.min(1000, limit))).lean();
  const terminalized = [];
  for (const candidate of candidates) {
    const attempt = await CallVoipPushAttempt.findOneAndUpdate(
      {
        _id: candidate._id,
        retryable: true,
        attempts: { $gte: MAX_ATTEMPTS },
        $or: [{ leaseAt: null }, { leaseAt: { $lte: staleLease } }]
      },
      {
        $set: {
          status: 'failed',
          retryable: false,
          failedAt: new Date(),
          errorCode: 'APNS_RETRY_EXHAUSTED',
          errorMessage: 'APNs VoIP delivery exhausted its retry budget'
        },
        $unset: { leaseAt: 1, leaseKey: 1, nextAttemptAt: 1 }
      },
      { new: true }
    );
    if (attempt) terminalized.push(attempt);
  }
  await mapWithConcurrency(terminalized, CONCURRENCY, async (attempt) => {
    await enqueueTerminalIncomingFallback(attempt).catch((error) => {
      log.error('Exhausted APNs attempt Expo fallback failed', { callId: attempt.callId, error: String(error) });
    });
  });
  await Promise.all(Array.from(new Set(terminalized.map((attempt) => attempt.requestKey))).map(refreshVoipRequest));
  return terminalized;
};

const recoverInterruptedVoipRequests = async (limit = 200) => {
  const staleBefore = new Date(Date.now() - REQUEST_RECOVERY_STALE_MS);
  const exhaustedCandidates = await PushDeliveryRequest.find({
    provider: 'apns_voip',
    status: { $in: ['created', 'submitting', 'retrying'] },
    lastAttemptAt: { $lte: staleBefore },
    recoveryAttempts: { $gte: REQUEST_RECOVERY_MAX_ATTEMPTS }
  }).select('_id requestKey recipient payload').limit(Math.max(1, Math.min(1000, limit))).lean();
  for (const candidate of exhaustedCandidates) {
    if (await CallVoipPushAttempt.exists({ requestKey: candidate.requestKey })) {
      await refreshVoipRequest(candidate.requestKey);
      continue;
    }
    const terminal = await PushDeliveryRequest.findOneAndUpdate(
      {
        _id: candidate._id,
        recoveryAttempts: { $gte: REQUEST_RECOVERY_MAX_ATTEMPTS },
        status: { $in: ['created', 'submitting', 'retrying'] },
        lastAttemptAt: { $lte: staleBefore }
      },
      {
        $set: {
          status: 'failed',
          reasonCode: 'APNS_REQUEST_RECOVERY_EXHAUSTED',
          reasonMessage: 'APNs request recovery exhausted before a token attempt was persisted',
          completedAt: new Date()
        }
      },
      { new: true }
    ).lean();
    if (!terminal || terminal.payload?.eventType === 'call_state_update') continue;
    log.error('APNs request recovery budget exhausted before attempt persistence', {
      requestKey: String(terminal.requestKey).slice(0, 16)
    });
    const session = terminal.payload?.callId
      ? await CallSession.findOne({ callId: terminal.payload.callId })
      : null;
    if (!session || session.status !== 'ringing' || new Date(session.expiresAt) <= new Date()) continue;
    await sendExpoFallbackForVoipFailure(
      terminal.recipient,
      initialVoipFallbackNotification(session),
      null
    ).catch((error) => {
      log.error('Exhausted APNs request Expo fallback failed', { callId: session.callId, error: String(error) });
    });
  }
  const candidates = await PushDeliveryRequest.find({
    provider: 'apns_voip',
    status: { $in: ['created', 'submitting', 'retrying'] },
    lastAttemptAt: { $lte: staleBefore },
    recoveryAttempts: { $lt: REQUEST_RECOVERY_MAX_ATTEMPTS }
  }).select('_id requestKey recipient payload').sort({ lastAttemptAt: 1 }).limit(Math.max(1, Math.min(1000, limit))).lean();
  const results = [];
  for (const candidate of candidates) {
    if (await CallVoipPushAttempt.exists({ requestKey: candidate.requestKey })) {
      await refreshVoipRequest(candidate.requestKey);
      continue;
    }
    const request = await PushDeliveryRequest.findOneAndUpdate(
      {
        _id: candidate._id,
        lastAttemptAt: { $lte: staleBefore },
        recoveryAttempts: { $lt: REQUEST_RECOVERY_MAX_ATTEMPTS }
      },
      {
        $set: { status: 'retrying', lastAttemptAt: new Date() },
        $inc: { recoveryAttempts: 1 },
        $unset: { completedAt: 1 }
      },
      { new: true }
    ).lean();
    if (!request) continue;
    const payload = request.payload || {};
    const session = payload.callId
      ? await CallSession.findOne({ callId: payload.callId })
      : null;
    const stateUpdate = payload.eventType === 'call_state_update';
    if (stateUpdate) {
      await skipVoipRequest(
        request.requestKey,
        'PUSHKIT_STATE_UPDATE_DISABLED',
        'Call-state reconciliation uses the standard APNs background channel'
      );
      continue;
    }
    const relevant = session && session.status === 'ringing' && new Date(session.expiresAt) > new Date();
    if (!relevant) {
      await skipVoipRequest(
        request.requestKey,
        'CALL_EXPIRED',
        'Call is no longer ringing'
      );
      continue;
    }
    try {
      results.push(await sendVoipCallPush(request.recipient, session, { callerName: payload.callerName }));
    } catch (error) {
      const exhausted = Number(request.recoveryAttempts || 0) >= REQUEST_RECOVERY_MAX_ATTEMPTS;
      await PushDeliveryRequest.updateOne(
        { _id: request._id },
        {
          $set: {
            status: exhausted ? 'failed' : 'retrying',
            reasonCode: String(error?.code || 'APNS_REQUEST_RECOVERY_FAILED').slice(0, 200),
            reasonMessage: String(error?.message || error).slice(0, 1000),
            lastAttemptAt: new Date(),
            ...(exhausted ? { completedAt: new Date() } : {})
          }
        }
      );
    }
  }
  return results;
};

const retryDueVoipPushAttempts = async (limit = 200) => {
  await recoverInitialVoipPushes(limit);
  await recoverInterruptedVoipRequests(limit);
  const terminalized = await terminalizeExhaustedVoipAttempts(limit);
  const due = await CallVoipPushAttempt.find({
    status: { $in: ['queued', 'failed', 'sending'] },
    retryable: true,
    attempts: { $lt: MAX_ATTEMPTS },
    $and: [
      { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }] },
      { $or: [{ leaseAt: null }, { leaseAt: { $lte: new Date(Date.now() - LEASE_MS) } }] }
    ]
  }).select('_id requestKey').limit(Math.max(1, Math.min(1000, limit))).lean();
  const results = await mapWithConcurrency(
    due,
    CONCURRENCY,
    (attempt) => processVoipAttempt(attempt._id)
  );
  await Promise.all(Array.from(new Set(due.map((attempt) => attempt.requestKey))).map(refreshVoipRequest));
  return [
    ...terminalized.map(() => ({ accepted: false, retryable: false, reason: 'APNS_RETRY_EXHAUSTED' })),
    ...results
  ];
};

const startApnsVoipPushSweeper = () => {
  if (sweepTimer) return;
  void retryDueVoipPushAttempts().catch((error) => log.error('APNs VoIP recovery sweep failed', { error: String(error) }));
  sweepTimer = setInterval(() => {
    void retryDueVoipPushAttempts().catch((error) => log.error('APNs VoIP recovery sweep failed', { error: String(error) }));
  }, 10000);
  sweepTimer.unref?.();
};

const stopApnsVoipPushSweeper = () => {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
};

module.exports = {
  getConfig,
  isConfigured,
  assertConfigured,
  sendVoipCallPush,
  sendVoipCallStatePush,
  markVoipFallbackSent,
  getVoipFallbackExpoTokenHashes,
  sendExpoFallbackForVoipFailure,
  dispatchInitialVoipPush,
  recoverInitialVoipPushes,
  terminalizeExhaustedVoipAttempts,
  recoverInterruptedVoipRequests,
  retryDueVoipPushAttempts,
  processVoipAttempt,
  startApnsVoipPushSweeper,
  stopApnsVoipPushSweeper
};
