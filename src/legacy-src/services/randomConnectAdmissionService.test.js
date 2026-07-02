const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RandomConnectAdmission = require('../models/RandomConnectAdmission');
const RandomConnectGenderQuota = require('../models/RandomConnectGenderQuota');
const RandomConnection = require('../models/RandomConnection');
const ConnectionQueue = require('../models/ConnectionQueue');
const randomConnectController = require('../controllers/randomConnectController');
const service = require('./randomConnectAdmissionService');
const originalConsoleError = console.error;

const originals = {
  admissionFindOneAndUpdate: RandomConnectAdmission.findOneAndUpdate,
  admissionUpdateOne: RandomConnectAdmission.updateOne,
  quotaFindOne: RandomConnectGenderQuota.findOne,
  quotaFindOneAndUpdate: RandomConnectGenderQuota.findOneAndUpdate,
  quotaUpdateOne: RandomConnectGenderQuota.updateOne,
  connectionFind: RandomConnection.find,
  queueDeleteMany: ConnectionQueue.deleteMany
};

const queryReturning = (value) => ({
  select() { return this; },
  lean: async () => value
});

async function run() {
  try {
    // Simulate the unique-user Mongo admission row. Concurrent calls must have
    // exactly one winner even when they race before either work item completes.
    let activeLeaseToken = '';
    RandomConnectAdmission.findOneAndUpdate = async (_filter, update) => {
      await Promise.resolve();
      if (activeLeaseToken) {
        const error = new Error('duplicate admission');
        error.code = 11000;
        throw error;
      }
      activeLeaseToken = update.$set.leaseToken;
      return { leaseToken: activeLeaseToken };
    };
    RandomConnectAdmission.updateOne = async (filter, update) => {
      if (filter.leaseToken !== activeLeaseToken) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set.leaseToken === '') activeLeaseToken = '';
      return { matchedCount: 1, modifiedCount: 1 };
    };
    // These two scenarios intentionally exercise logged operational failures.
    // Silence their expected logger output while preserving assertions.
    console.error = () => {};

    let finishFirst;
    const firstWork = new Promise((resolve) => { finishFirst = resolve; });
    const first = service.withRandomConnectAdmission({
      userId: '507f1f77bcf86cd799439011',
      operation: 'join',
      work: async () => firstWork
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      service.withRandomConnectAdmission({
        userId: '507f1f77bcf86cd799439011',
        operation: 'next',
        work: async () => 'must-not-run'
      }),
      (error) => error?.code === 'RANDOM_CONNECT_REQUEST_IN_PROGRESS' && error?.status === 409
    );
    finishFirst('first-complete');
    assert.equal(await first, 'first-complete');
    assert.equal(activeLeaseToken, '', 'admission must be released after work');

    // Pair helper renews existing + newly owned leases, does not release the
    // caller-owned lease, and never suppresses a committed result when release
    // of the partner lease fails.
    const leaseState = new Map([
      ['507f1f77bcf86cd799439011', 'existing-caller-token']
    ]);
    let renewalCount = 0;
    let partnerReleaseAttempts = 0;
    RandomConnectAdmission.findOneAndUpdate = async (filter, update) => {
      if (leaseState.has(String(filter.user))) {
        const error = new Error('duplicate admission');
        error.code = 11000;
        throw error;
      }
      leaseState.set(String(filter.user), update.$set.leaseToken);
      return { leaseToken: update.$set.leaseToken };
    };
    RandomConnectAdmission.updateOne = async (filter, update) => {
      const userKey = String(filter.user);
      if (leaseState.get(userKey) !== filter.leaseToken) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set.leaseToken === '') {
        partnerReleaseAttempts += 1;
        if (userKey === '507f1f77bcf86cd799439012') throw new Error('simulated release outage');
        leaseState.delete(userKey);
      } else {
        renewalCount += 1;
      }
      return { matchedCount: 1, modifiedCount: 1 };
    };
    const committedPair = await service.withRandomConnectAdmissions({
      userIds: ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'],
      operation: 'join',
      existingLeases: [{
        userId: '507f1f77bcf86cd799439011',
        operation: 'join',
        leaseToken: 'existing-caller-token',
        leaseExpiresAt: new Date(Date.now() + 60000)
      }],
      heartbeatIntervalMs: 2,
      work: async ({ assertLeases }) => {
        await new Promise((resolve) => setTimeout(resolve, 12));
        assertLeases();
        return 'connection-committed';
      }
    });
    assert.equal(committedPair, 'connection-committed');
    assert(renewalCount >= 2, 'heartbeat must renew both existing and partner leases');
    assert.equal(partnerReleaseAttempts, 1);
    assert.equal(leaseState.get('507f1f77bcf86cd799439011'), 'existing-caller-token', 'helper must not release caller-owned lease');

    // Queue cleanup occurs after RandomConnection.create. Its failure is logged
    // but cannot requeue the pair or turn the committed connection into error.
    ConnectionQueue.deleteMany = async () => { throw new Error('simulated queue cleanup outage'); };
    const committedConnection = { roomId: 'committed-room' };
    const cleanupResult = await randomConnectController._private.cleanupCommittedPairQueue(
      committedConnection,
      ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012']
    );
    assert.strictEqual(cleanupResult, committedConnection);
    console.error = originalConsoleError;

    // In-memory implementation of the atomic unique daily counter. Six
    // concurrent distinct reservations may commit at most five slots.
    let quota = null;
    const quotaQuerySessions = [];
    const quotaMutationSessions = [];
    RandomConnectGenderQuota.findOne = (_filter, _projection, options) => {
      quotaQuerySessions.push(options?.session);
      return queryReturning(quota ? { ...quota, reservationKeys: [...quota.reservationKeys] } : null);
    };
    RandomConnectGenderQuota.findOneAndUpdate = async (filter, update, options = {}) => {
      quotaMutationSessions.push(options.session);
      await Promise.resolve();
      const key = update.$addToSet.reservationKeys;
      const canUpdate = quota && quota.slotCount < filter.slotCount.$lt && !quota.reservationKeys.includes(key);
      if (canUpdate) {
        quota.slotCount += update.$inc.slotCount;
        quota.reservationKeys.push(key);
        return { ...quota, reservationKeys: [...quota.reservationKeys] };
      }
      if (!quota && options.upsert) {
        quota = {
          user: filter.user,
          dayKey: filter.dayKey,
          slotCount: 1,
          reservationKeys: [key]
        };
        return { ...quota, reservationKeys: [...quota.reservationKeys] };
      }
      if (options.upsert) {
        const error = new Error('duplicate quota');
        error.code = 11000;
        throw error;
      }
      return null;
    };
    RandomConnectGenderQuota.updateOne = async (filter) => {
      const index = quota?.reservationKeys.indexOf(filter.reservationKeys) ?? -1;
      if (index < 0) return { modifiedCount: 0 };
      quota.reservationKeys.splice(index, 1);
      quota.slotCount -= 1;
      return { modifiedCount: 1 };
    };

    const userA = '507f1f77bcf86cd799439011';
    const userB = '507f1f77bcf86cd799439012';
    const leases = [
      { userId: userA, leaseToken: 'lease-a', operation: 'join' },
      { userId: userB, leaseToken: 'lease-b', operation: 'join' }
    ];

    // A heartbeat that has not noticed a stolen lease is insufficient. The
    // database fence runs inside the transaction and must prevent the insert.
    const lostFenceSession = {
      async withTransaction(work) { return work(); },
      async endSession() { this.ended = true; }
    };
    RandomConnectAdmission.findOneAndUpdate = async (filter, _update, options) => {
      assert.strictEqual(options.session, lostFenceSession);
      return String(filter.user) === userA ? { leaseToken: 'lease-a' } : null;
    };
    let stalePersistCalls = 0;
    await assert.rejects(
      service.commitRandomConnectMatch({
        leases,
        userIds: [userA, userB],
        reserveQuota: async (session) => assert.strictEqual(session, lostFenceSession),
        persistConnection: async () => {
          stalePersistCalls += 1;
          return { roomId: 'must-not-commit' };
        },
        startSession: async () => lostFenceSession
      }),
      (error) => error?.code === 'RANDOM_CONNECT_ADMISSION_LOST' && error?.lostUserIds?.includes(userB)
    );
    assert.equal(stalePersistCalls, 0, 'lost DB lease must fence the durable connection write');
    assert.equal(lostFenceSession.ended, true);

    // Exercise a transient transaction callback retry. The transaction's
    // rollback is modelled by restoring the quota snapshot before retrying.
    quota = null;
    const retrySession = {
      async withTransaction(work, options) {
        assert.deepStrictEqual(options.writeConcern, { w: 'majority' });
        try {
          await work();
        } catch (error) {
          if (!error.transient) throw error;
          quota = null;
          return work();
        }
      },
      async endSession() { this.ended = true; }
    };
    RandomConnectAdmission.findOneAndUpdate = async (filter, _update, options) => {
      assert.strictEqual(options.session, retrySession);
      const lease = leases.find((candidate) => String(candidate.userId) === String(filter.user));
      return lease ? { leaseToken: lease.leaseToken } : null;
    };
    const deterministicRoomId = 'room-stable-across-transaction-retry';
    let persistAttempts = 0;
    const retriedConnection = await service.commitRandomConnectMatch({
      leases,
      userIds: [userA, userB],
      reserveQuota: (session) => service.reserveGenderFilterSlot({
        userId: userA,
        reservationKey: deterministicRoomId,
        now: new Date('2026-07-02T12:00:00.000Z'),
        session
      }),
      persistConnection: async (session) => {
        assert.strictEqual(session, retrySession);
        persistAttempts += 1;
        if (persistAttempts === 1) {
          const error = new Error('simulated transient transaction error');
          error.transient = true;
          throw error;
        }
        return { roomId: deterministicRoomId };
      },
      startSession: async () => retrySession
    });
    assert.equal(retriedConnection.roomId, deterministicRoomId);
    assert.equal(persistAttempts, 2);
    assert.equal(quota.slotCount, 1, 'aborted transaction attempt must not leave phantom quota');
    assert.deepStrictEqual(quota.reservationKeys, [deterministicRoomId]);
    assert(quotaQuerySessions.includes(retrySession));
    assert(quotaMutationSessions.includes(retrySession));
    assert.equal(retrySession.ended, true);

    // If the driver ultimately reports an ambiguous commit but the stable
    // room is visible, reconcile to success; quota and connection committed as
    // one unit and must never be compensated independently.
    quota = null;
    const committedAfterAmbiguity = { roomId: 'room-ambiguous-but-committed' };
    const ambiguousSession = {
      async withTransaction(work) {
        await work();
        const error = new Error('unknown commit result');
        error.hasErrorLabel = (label) => label === 'UnknownTransactionCommitResult';
        throw error;
      },
      async endSession() { this.ended = true; }
    };
    RandomConnectAdmission.findOneAndUpdate = async (filter) => {
      const lease = leases.find((candidate) => String(candidate.userId) === String(filter.user));
      return lease ? { leaseToken: lease.leaseToken } : null;
    };
    const reconciled = await service.commitRandomConnectMatch({
      leases,
      userIds: [userA, userB],
      reserveQuota: (session) => service.reserveGenderFilterSlot({
        userId: userA,
        reservationKey: committedAfterAmbiguity.roomId,
        now: new Date('2026-07-02T12:00:00.000Z'),
        session
      }),
      persistConnection: async (session) => {
        assert.strictEqual(session, ambiguousSession);
        return committedAfterAmbiguity;
      },
      findCommittedConnection: async () => committedAfterAmbiguity,
      startSession: async () => ambiguousSession
    });
    assert.strictEqual(reconciled, committedAfterAmbiguity);
    assert.equal(quota.slotCount, 1);
    assert.equal(ambiguousSession.ended, true);

    const unresolvedSession = {
      async withTransaction(work) {
        await work();
        const error = new Error('unknown commit result without readable reconciliation');
        error.hasErrorLabel = (label) => label === 'UnknownTransactionCommitResult';
        throw error;
      },
      async endSession() {}
    };
    await assert.rejects(
      service.commitRandomConnectMatch({
        leases,
        userIds: [userA, userB],
        reserveQuota: async () => {},
        persistConnection: async () => ({ roomId: 'room-outcome-unresolved' }),
        findCommittedConnection: async () => null,
        startSession: async () => unresolvedSession
      }),
      (error) => (
        error?.code === 'RANDOM_CONNECT_COMMIT_OUTCOME_UNKNOWN' &&
        error?.commitOutcomeUnknown === true &&
        error?.retryable === true
      )
    );

    // A crash before the connection write completes aborts the unit of work.
    // The fake session restores the quota snapshot to model Mongo rollback.
    quota = null;
    const crashSession = {
      async withTransaction(work) {
        try {
          return await work();
        } catch (error) {
          quota = null;
          throw error;
        }
      },
      async endSession() {}
    };
    await assert.rejects(
      service.commitRandomConnectMatch({
        leases,
        userIds: [userA, userB],
        reserveQuota: (session) => service.reserveGenderFilterSlot({
          userId: userA,
          reservationKey: 'room-crash-before-insert',
          now: new Date('2026-07-02T12:00:00.000Z'),
          session
        }),
        persistConnection: async () => { throw new Error('simulated process failure before insert'); },
        findCommittedConnection: async () => null,
        startSession: async () => crashSession
      }),
      /simulated process failure/
    );
    assert.equal(quota, null, 'aborted connection write must not consume quota');

    quota = null;
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) => service.reserveGenderFilterSlot({
        userId: '507f1f77bcf86cd799439011',
        reservationKey: `room-${index}`,
        now: new Date('2026-07-02T12:00:00.000Z')
      }))
    );
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 5);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(quota.slotCount, 5);
    assert.equal(new Set(quota.reservationKeys).size, 5);
    await assert.rejects(
      service.reserveGenderFilterSlot({
        userId: '507f1f77bcf86cd799439011',
        reservationKey: 'room-over-limit',
        now: new Date('2026-07-02T12:00:00.000Z')
      }),
      (error) => error?.code === 'RANDOM_CONNECT_GENDER_FILTER_LIMIT'
    );
    const replay = await service.reserveGenderFilterSlot({
      userId: '507f1f77bcf86cd799439011',
      reservationKey: quota.reservationKeys[0],
      now: new Date('2026-07-02T12:00:00.000Z')
    });
    assert.equal(replay.idempotent, true);
    assert.equal(quota.slotCount, 5, 'idempotent reservation must not consume another slot');

    // Same-day rows from a pre-attribution deployment are conservatively
    // charged to prevent rollout overage. The next UTC day expires the seed.
    quota = null;
    let connectionFindCall = 0;
    RandomConnection.find = () => {
      connectionFindCall += 1;
      return queryReturning(connectionFindCall === 1
        ? []
        : [{ roomId: 'legacy-a' }, { roomId: 'legacy-b' }]);
    };
    const legacySync = await service.syncAttributedUsage({
      userId: '507f1f77bcf86cd799439011',
      now: new Date('2026-07-02T12:00:00.000Z')
    });
    assert.equal(legacySync.legacyUsageConservativelyCharged, 2);
    assert.equal(quota.slotCount, 2);
    assert.deepStrictEqual(quota.reservationKeys.sort(), ['legacy:legacy-a', 'legacy:legacy-b']);

    // Player-facing active session discovery must never return the global
    // roster. The query and a defense-in-depth response filter both bind it to
    // the authenticated participant.
    let activeSessionsFilter;
    RandomConnection.find = (filter) => {
      activeSessionsFilter = filter;
      return queryReturning([
        {
          roomId: 'owned-room',
          status: 'active',
          participants: [
            { userId: userA, username: 'requester' },
            { userId: userB, username: 'partner' }
          ]
        },
        {
          roomId: 'global-room-must-not-leak',
          status: 'active',
          participants: [
            { userId: '507f1f77bcf86cd799439013', username: 'private-a' },
            { userId: '507f1f77bcf86cd799439014', username: 'private-b' }
          ]
        }
      ]);
    };
    let activeSessionsPayload;
    const activeSessionsResponse = {
      set() { return this; },
      status(status) { this.statusCode = status; return this; },
      json(payload) { activeSessionsPayload = payload; return payload; }
    };
    await randomConnectController.getActiveSessions(
      { user: { _id: userA } },
      activeSessionsResponse
    );
    assert.equal(activeSessionsResponse.statusCode, 200);
    assert.equal(String(activeSessionsFilter['participants.userId']), userA);
    assert.equal(activeSessionsPayload.count, 1);
    assert.equal(activeSessionsPayload.sessions[0].roomId, 'owned-room');
    assert(!JSON.stringify(activeSessionsPayload).includes('global-room-must-not-leak'));

    const admissionIndexes = RandomConnectAdmission.schema.indexes();
    assert(admissionIndexes.some(([fields, options]) => fields.user === 1 && options.unique === true));
    const quotaIndexes = RandomConnectGenderQuota.schema.indexes();
    assert(quotaIndexes.some(([fields, options]) => fields.user === 1 && fields.dayKey === 1 && options.unique === true));
    assert(quotaIndexes.some(([fields, options]) => fields.expiresAt === 1 && options.expireAfterSeconds === 0));

    const controllerPath = path.resolve(__dirname, '..', 'controllers', 'randomConnectController.js');
    const controller = fs.readFileSync(controllerPath, 'utf8');
    assert(controller.includes("operation: 'join'"));
    assert(controller.includes("operation: 'next'"));
    assert(controller.includes("operation: 'leave'"));
    assert(controller.includes("operation: 'disconnect'"));
    assert(controller.includes("operation: 'cleanup'"));
    assert(controller.includes('withRandomConnectAdmissions'));
    assert(controller.includes('existingLeases: admissionLease ? [admissionLease] : []'));
    assert(controller.includes('cleanupCommittedPairQueue(connection'));
    assert(controller.includes('commitRandomConnectMatch'));
    assert(controller.includes('admissionLeases: leases'));
    assert(controller.includes('$setOnInsert: connectionDocument'));
    assert(controller.includes('if (!error?.commitOutcomeUnknown)'));
    assert(controller.includes('reserveGenderFilterSlot'));
    assert(controller.includes('resolveRandomConnectEntitlement({ userId: user1Id'));

    const routes = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'modules', 'random-connections', 'random-connections.routes.ts'),
      'utf8'
    );
    const v2Routes = routes.slice(routes.indexOf('// Backward-compatible v2 aliases'));
    assert(v2Routes.includes('randomConnectController.joinQueue'));
    assert(v2Routes.includes('randomConnectController.leaveQueue'));
    assert(v2Routes.includes('randomConnectController.disconnectConnection'));
    assert(!v2Routes.includes('randomConnectionControllerNew'));
    const releasePreflight = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'scripts', 'preflight-push-release.js'),
      'utf8'
    );
    assert(releasePreflight.includes("run('migrate-random-connect-indexes.js')"));
    assert(releasePreflight.includes("run('migrate-random-connect-indexes.js', ['--verify'])"));
    const indexMigration = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'scripts', 'migrate-random-connect-indexes.js'),
      'utf8'
    );
    assert(indexMigration.includes('expireAfterSeconds'));
    assert(indexMigration.includes('partialFilterExpression'));
    assert(indexMigration.includes('verifyTransactionSupport'));
    assert(indexMigration.includes('verified MongoDB transaction support for Random Connect'));
  } finally {
    RandomConnectAdmission.findOneAndUpdate = originals.admissionFindOneAndUpdate;
    RandomConnectAdmission.updateOne = originals.admissionUpdateOne;
    RandomConnectGenderQuota.findOne = originals.quotaFindOne;
    RandomConnectGenderQuota.findOneAndUpdate = originals.quotaFindOneAndUpdate;
    RandomConnectGenderQuota.updateOne = originals.quotaUpdateOne;
    RandomConnection.find = originals.connectionFind;
    ConnectionQueue.deleteMany = originals.queueDeleteMany;
    console.error = originalConsoleError;
  }
}

run()
  .then(() => console.log('Random Connect admission concurrency tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
