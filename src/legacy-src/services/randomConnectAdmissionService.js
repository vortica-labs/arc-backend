const crypto = require('crypto');
const RandomConnectAdmission = require('../models/RandomConnectAdmission');
const RandomConnectGenderQuota = require('../models/RandomConnectGenderQuota');
const RandomConnection = require('../models/RandomConnection');
const log = require('../utils/logger');
const { FREE_DAILY_GENDER_MATCH_LIMIT } = require('./entitlementService');

const configuredLeaseMs = Number(process.env.RANDOM_CONNECT_ADMISSION_LEASE_MS || 60000);
const ADMISSION_LEASE_MS = Math.max(15000, Math.min(5 * 60 * 1000, configuredLeaseMs));

const quotaWindow = (now = new Date()) => {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 2);
  return {
    dayKey: start.toISOString().slice(0, 10),
    start,
    expiresAt: end
  };
};

const admissionBusyError = (retryAfterMs = ADMISSION_LEASE_MS) => {
  const error = new Error('Another Random Connect request is already in progress');
  error.status = 409;
  error.code = 'RANDOM_CONNECT_REQUEST_IN_PROGRESS';
  error.retryAfterMs = retryAfterMs;
  return error;
};

const admissionLostError = (userIds = []) => {
  const lostUserIds = Array.from(new Set((userIds || []).map(String).filter(Boolean)));
  const error = new Error('Random Connect admission lease was lost');
  error.status = 409;
  error.code = 'RANDOM_CONNECT_ADMISSION_LOST';
  error.lostUserIds = lostUserIds;
  return error;
};

const acquireAdmission = async ({ userId, operation, now = new Date() }) => {
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + ADMISSION_LEASE_MS);
  try {
    const admission = await RandomConnectAdmission.findOneAndUpdate(
      {
        user: userId,
        $or: [
          { leaseToken: '' },
          { leaseToken: { $exists: false } },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $lte: now } }
        ]
      },
      {
        $set: { leaseToken, operation, acquiredAt: now, leaseExpiresAt },
        $setOnInsert: { user: userId }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    if (!admission || admission.leaseToken !== leaseToken) return null;
    return { userId, operation, leaseToken, leaseExpiresAt };
  } catch (error) {
    // An active row does not match the acquisition predicate. With upsert the
    // unique user index turns that race into E11000, which means "busy".
    if (error?.code === 11000) return null;
    throw error;
  }
};

const renewAdmission = async (lease) => {
  const leaseExpiresAt = new Date(Date.now() + ADMISSION_LEASE_MS);
  const result = await RandomConnectAdmission.updateOne(
    { user: lease.userId, leaseToken: lease.leaseToken },
    { $set: { leaseExpiresAt } }
  );
  if (result.modifiedCount !== 1 && result.matchedCount !== 1) return false;
  lease.leaseExpiresAt = leaseExpiresAt;
  return true;
};

/**
 * Persistently fence every participant immediately before a match is written.
 *
 * The in-process heartbeat is useful for early cancellation, but it cannot be
 * authoritative after a process pause or network partition. This operation is
 * deliberately token + unexpired-lease conditioned and may run in the same
 * Mongo transaction as the RandomConnection insert. A stolen/expired lease
 * therefore prevents that transaction from committing a stale match.
 */
const renewAndAssertAdmissions = async ({
  leases = [],
  userIds = [],
  session,
  now = new Date()
}) => {
  const leasesByUser = new Map(
    leases.filter(Boolean).map((lease) => [String(lease.userId), lease])
  );
  const requiredUserIds = Array.from(new Set((userIds || []).map(String).filter(Boolean)));
  const missingUserIds = requiredUserIds.filter((userId) => !leasesByUser.has(userId));
  if (missingUserIds.length > 0) throw admissionLostError(missingUserIds);

  const leasesToFence = requiredUserIds.length > 0
    ? requiredUserIds.map((userId) => leasesByUser.get(userId))
    : Array.from(leasesByUser.values());
  const leaseExpiresAt = new Date(now.getTime() + ADMISSION_LEASE_MS);
  const lostUserIds = [];

  // Stable ordering prevents two pair transactions from taking admission-row
  // write locks in opposite order.
  for (const lease of leasesToFence.sort((left, right) => (
    String(left.userId).localeCompare(String(right.userId))
  ))) {
    const admission = await RandomConnectAdmission.findOneAndUpdate(
      {
        user: lease.userId,
        leaseToken: lease.leaseToken,
        leaseExpiresAt: { $gt: now }
      },
      { $set: { leaseExpiresAt } },
      {
        new: true,
        ...(session ? { session } : {})
      }
    );
    if (!admission || String(admission.leaseToken || '') !== String(lease.leaseToken || '')) {
      lostUserIds.push(String(lease.userId));
      continue;
    }
    lease.leaseExpiresAt = leaseExpiresAt;
  }

  if (lostUserIds.length > 0) throw admissionLostError(lostUserIds);
  return leasesToFence;
};

/**
 * Atomically reserve any gender-filter quota and persist the connection.
 * MongoDB's withTransaction retries transient callbacks and resolves unknown
 * commit results. The caller must keep its roomId stable across callback
 * retries and perform an idempotent upsert in persistConnection.
 */
const commitRandomConnectMatch = async ({
  leases,
  userIds,
  reserveQuota,
  persistConnection,
  findCommittedConnection,
  startSession = () => RandomConnection.db.startSession()
}) => {
  if (typeof reserveQuota !== 'function' || typeof persistConnection !== 'function') {
    throw new TypeError('Random Connect transaction callbacks are required');
  }

  const session = await startSession();
  let connection = null;
  try {
    await session.withTransaction(async () => {
      await reserveQuota(session);
      // Keep this as the final database operation before the durable upsert.
      await renewAndAssertAdmissions({ leases, userIds, session });
      connection = await persistConnection(session);
      if (!connection) throw new Error('Random Connect connection commit returned no document');
      return connection;
    }, {
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    });
    return connection;
  } catch (error) {
    const commitOutcomeUnknown = Boolean(
      error?.hasErrorLabel?.('UnknownTransactionCommitResult')
    );
    // A deterministic room id makes even a driver-level unknown commit result
    // reconcilable. If the connection is visible, the quota transaction also
    // committed and the caller must continue down the success path.
    if (typeof findCommittedConnection === 'function') {
      try {
        const committed = await findCommittedConnection();
        if (committed) return committed;
      } catch (reconciliationError) {
        log.error('Random Connect ambiguous commit reconciliation failed', {
          error: String(error),
          reconciliationError: String(reconciliationError)
        });
      }
    }
    if (commitOutcomeUnknown) {
      // Never compensate/requeue after an unresolved commit. The deterministic
      // room may still become visible; clients restore it via current-session,
      // while the stale claimed queue row expires if the transaction aborted.
      const unknownError = new Error('Random Connect match commit outcome is still being reconciled');
      unknownError.status = 503;
      unknownError.code = 'RANDOM_CONNECT_COMMIT_OUTCOME_UNKNOWN';
      unknownError.retryable = true;
      unknownError.retryAfterMs = 2000;
      unknownError.commitOutcomeUnknown = true;
      unknownError.cause = error;
      throw unknownError;
    }
    if (
      error?.code === 20 ||
      /Transaction numbers are only allowed|does not support transactions/i.test(String(error?.message || ''))
    ) {
      const transactionError = new Error('Random Connect requires MongoDB transaction support');
      transactionError.status = 503;
      transactionError.code = 'RANDOM_CONNECT_TRANSACTION_REQUIRED';
      transactionError.cause = error;
      throw transactionError;
    }
    throw error;
  } finally {
    try {
      await session.endSession();
    } catch (endSessionError) {
      // Session disposal is local cleanup after the commit outcome has already
      // been resolved. Never turn a durable match into an apparent failure and
      // requeue the pair because driver cleanup itself failed.
      log.warn('Random Connect Mongo session cleanup failed', {
        error: String(endSessionError)
      });
    }
  }
};

const releaseAdmission = async (lease) => {
  if (!lease) return;
  await RandomConnectAdmission.updateOne(
    { user: lease.userId, leaseToken: lease.leaseToken },
    {
      $set: {
        leaseToken: '',
        leaseExpiresAt: new Date(),
        lastCompletedAt: new Date(),
        lastOperation: lease.operation
      }
    }
  );
};

const releaseAdmissionsBestEffort = async (leases, operation) => {
  await Promise.all((leases || []).map(async (lease) => {
    try {
      await releaseAdmission(lease);
    } catch (error) {
      // A committed connection/request result must not be converted to failure
      // because lock cleanup had a transient error. Token+expiry permit safe
      // recovery, and the failure remains observable.
      log.error('Random Connect admission lease release failed', {
        userId: String(lease?.userId || ''),
        operation: operation || lease?.operation,
        error: String(error)
      });
    }
  }));
};

const withRandomConnectAdmissions = async ({
  userIds,
  operation,
  existingLeases = [],
  heartbeatIntervalMs,
  work
}) => {
  const existingByUser = new Map(existingLeases.map((lease) => [String(lease.userId), lease]));
  const uniqueUserIds = Array.from(new Map(
    (userIds || []).map((userId) => [String(userId), userId])
  ).values()).sort((left, right) => String(left).localeCompare(String(right)));
  const leases = [];
  const ownedLeases = [];

  for (const userId of uniqueUserIds) {
    const existing = existingByUser.get(String(userId));
    if (existing) {
      leases.push(existing);
      continue;
    }
    const acquired = await acquireAdmission({ userId, operation });
    if (!acquired) {
      await releaseAdmissionsBestEffort(ownedLeases, operation);
      const error = admissionBusyError();
      error.busyUserId = String(userId);
      throw error;
    }
    leases.push(acquired);
    ownedLeases.push(acquired);
  }

  const lostLeaseUserIds = new Set();
  let heartbeatRun = null;
  const renewAll = async () => {
    await Promise.all(leases.map(async (lease) => {
      if (lostLeaseUserIds.has(String(lease.userId))) return;
      try {
        if (!(await renewAdmission(lease))) lostLeaseUserIds.add(String(lease.userId));
      } catch (error) {
        lostLeaseUserIds.add(String(lease.userId));
        log.error('Random Connect admission lease renewal failed', {
          userId: String(lease.userId),
          operation,
          error: String(error)
        });
      }
    }));
  };
  const intervalMs = heartbeatIntervalMs === undefined
    ? Math.max(5000, Math.floor(ADMISSION_LEASE_MS / 3))
    : Math.max(1, Number(heartbeatIntervalMs) || 1);
  const heartbeat = setInterval(() => {
    if (heartbeatRun) return;
    heartbeatRun = renewAll().finally(() => { heartbeatRun = null; });
  }, intervalMs);
  heartbeat.unref?.();

  const assertLeases = () => {
    if (lostLeaseUserIds.size > 0) {
      const error = new Error('Random Connect admission lease was lost');
      error.status = 409;
      error.code = 'RANDOM_CONNECT_ADMISSION_LOST';
      error.lostUserIds = Array.from(lostLeaseUserIds);
      throw error;
    }
  };

  try {
    return await work({
      leases,
      lease: leases[0] || null,
      assertLeases,
      assertLease: assertLeases
    });
  } finally {
    clearInterval(heartbeat);
    if (heartbeatRun) await heartbeatRun.catch(() => null);
    await releaseAdmissionsBestEffort(ownedLeases, operation);
  }
};

const withRandomConnectAdmission = async ({ userId, operation, heartbeatIntervalMs, work }) => (
  withRandomConnectAdmissions({
    userIds: [userId],
    operation,
    heartbeatIntervalMs,
    work
  })
);

const findQuota = (userId, dayKey, session) => RandomConnectGenderQuota.findOne(
  { user: userId, dayKey },
  null,
  session ? { session } : undefined
);

const genderFilterLimitError = (userId, limit) => {
  const error = new Error(`Daily gender-filter limit reached (${limit})`);
  error.status = 403;
  error.code = 'RANDOM_CONNECT_GENDER_FILTER_LIMIT';
  error.userId = String(userId);
  error.limit = limit;
  return error;
};

// Create the zero-value counter before opening a match transaction. This is a
// harmless/idempotent write and avoids duplicate-key errors aborting a Mongo
// transaction when two first-use requests race to create the daily row.
const ensureGenderFilterQuota = async ({ userId, now = new Date() }) => {
  const { dayKey, expiresAt } = quotaWindow(now);
  try {
    return await RandomConnectGenderQuota.findOneAndUpdate(
      { user: userId, dayKey },
      {
        $setOnInsert: {
          user: userId,
          dayKey,
          slotCount: 0,
          reservationKeys: [],
          expiresAt
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const raced = await findQuota(userId, dayKey).lean();
    if (raced) return raced;
    throw error;
  }
};

const reserveGenderFilterSlot = async ({
  userId,
  reservationKey,
  now = new Date(),
  limit = FREE_DAILY_GENDER_MATCH_LIMIT,
  session
}) => {
  const key = String(reservationKey || '').slice(0, 100);
  if (!key) throw new Error('Random Connect quota reservation key is required');
  const { dayKey, expiresAt } = quotaWindow(now);

  const existing = await findQuota(userId, dayKey, session).lean();
  if (existing?.reservationKeys?.includes(key)) {
    return { reserved: false, idempotent: true, used: Number(existing.slotCount || 0), dayKey };
  }
  if (existing && Number(existing.slotCount || 0) >= limit) {
    throw genderFilterLimitError(userId, limit);
  }

  const filter = {
    user: userId,
    dayKey,
    slotCount: { $lt: limit },
    reservationKeys: { $ne: key }
  };
  const update = {
    $inc: { slotCount: 1 },
    $addToSet: { reservationKeys: key },
    $set: { expiresAt },
    $setOnInsert: { user: userId, dayKey }
  };

  let quota;
  try {
    quota = await RandomConnectGenderQuota.findOneAndUpdate(
      filter,
      update,
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        ...(session ? { session } : {})
      }
    );
  } catch (error) {
    // Any write error aborts the active Mongo transaction. Let withTransaction
    // retry/abort the whole quota+connection unit rather than issuing another
    // operation against an already-aborted transaction.
    if (session) throw error;
    if (error?.code !== 11000) throw error;
    // Either another request created the daily document or it filled the final
    // slot. Retry without upsert so the unique-key race is deterministic.
    quota = await RandomConnectGenderQuota.findOneAndUpdate(filter, update, {
      new: true,
      ...(session ? { session } : {})
    });
    if (!quota) {
      const raced = await findQuota(userId, dayKey, session).lean();
      if (raced?.reservationKeys?.includes(key)) {
        return { reserved: false, idempotent: true, used: Number(raced.slotCount || 0), dayKey };
      }
    }
  }

  if (!quota) {
    throw genderFilterLimitError(userId, limit);
  }

  return { reserved: true, idempotent: false, used: Number(quota.slotCount || 0), dayKey };
};

const releaseGenderFilterSlot = async ({ userId, reservationKey, now = new Date(), session }) => {
  const { dayKey } = quotaWindow(now);
  const result = await RandomConnectGenderQuota.updateOne(
    { user: userId, dayKey, reservationKeys: String(reservationKey) },
    { $pull: { reservationKeys: String(reservationKey) }, $inc: { slotCount: -1 } },
    session ? { session } : undefined
  );
  return result.modifiedCount === 1;
};

const syncAttributedUsage = async ({ userId, now = new Date() }) => {
  const { start, dayKey } = quotaWindow(now);
  const connections = await RandomConnection.find({
    genderFilterUserIds: userId,
    participants: { $elemMatch: { userId, isPremium: false } },
    status: { $in: ['active', 'disconnected', 'ended'] },
    startTime: { $gte: start }
  }).select('roomId').lean();

  for (const connection of connections) {
    try {
      await reserveGenderFilterSlot({ userId, reservationKey: connection.roomId, now });
    } catch (error) {
      if (error?.code !== 'RANDOM_CONNECT_GENDER_FILTER_LIMIT') throw error;
      break;
    }
  }

  // Historical rows only stored a global boolean, so exact attribution is
  // impossible. During the bounded rollout day, conservatively seed each
  // participant's counter. This can temporarily under-allow a user matched by
  // somebody else's filter, but it prevents same-day quota overage. UTC daily
  // expiry removes the conservative seed automatically.
  const legacyRows = await RandomConnection.find({
    'participants.userId': userId,
    usedGenderFilter: true,
    $or: [
      { genderFilterUserIds: { $exists: false } },
      { genderFilterUserIds: { $size: 0 } }
    ],
    status: { $in: ['active', 'disconnected', 'ended'] },
    startTime: { $gte: start }
  }).select('roomId').lean();
  for (const connection of legacyRows) {
    try {
      await reserveGenderFilterSlot({
        userId,
        reservationKey: `legacy:${connection.roomId}`,
        now
      });
    } catch (error) {
      if (error?.code !== 'RANDOM_CONNECT_GENDER_FILTER_LIMIT') throw error;
      break;
    }
  }
  const legacyUsageConservativelyCharged = legacyRows.length;
  if (legacyUsageConservativelyCharged > 0 && process.env.RANDOM_CONNECT_ENTITLEMENT_DEBUG === 'true') {
    log.warn('Conservatively charged ambiguous legacy Random Connect gender-filter usage', {
      userId: String(userId),
      dayKey,
      legacyUsageConservativelyCharged
    });
  }

  return { legacyUsageConservativelyCharged, dayKey };
};

const getGenderFilterUsage = async ({ userId, now = new Date(), synchronize = true }) => {
  const sync = synchronize ? await syncAttributedUsage({ userId, now }) : { legacyUsageConservativelyCharged: 0 };
  const { dayKey } = quotaWindow(now);
  const quota = await findQuota(userId, dayKey).lean();
  return {
    used: Math.max(0, Number(quota?.slotCount || 0)),
    legacyUsageConservativelyCharged: sync.legacyUsageConservativelyCharged || 0,
    dayKey
  };
};

module.exports = {
  ADMISSION_LEASE_MS,
  quotaWindow,
  acquireAdmission,
  renewAdmission,
  renewAndAssertAdmissions,
  releaseAdmission,
  releaseAdmissionsBestEffort,
  withRandomConnectAdmissions,
  withRandomConnectAdmission,
  commitRandomConnectMatch,
  ensureGenderFilterQuota,
  reserveGenderFilterSlot,
  releaseGenderFilterSlot,
  syncAttributedUsage,
  getGenderFilterUsage
};
