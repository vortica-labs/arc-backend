const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PremiumMembership = require('../models/PremiumMembership');
const User = require('../models/User');
const redisCache = require('../utils/redisCache');
const entitlementService = require('./entitlementService');
const premiumMembershipService = require('./premiumMembershipService');

const originalMembershipFindOne = PremiumMembership.findOne;
const originalUserFindById = User.findById;
const originalUserUpdateOne = User.updateOne;
const originalSocketIo = global._arcSocketIO;

const queryReturning = (value) => ({
  select() { return this; },
  lean: async () => value
});

const setEntitlementFixtures = ({ membership, user }) => {
  PremiumMembership.findOne = () => queryReturning(membership);
  User.findById = () => queryReturning(user);
};

async function run() {
  const now = new Date('2026-07-02T12:00:00.000Z');
  const userId = '507f1f77bcf86cd799439011';

  try {
    // A canonical active membership must win even when the auth/User projection
    // is stale and still says free.
    setEntitlementFixtures({
      membership: {
        planKey: 'player_pro',
        billingPeriod: 'monthly',
        membershipStatus: 'active',
        subscriptionStatus: 'active',
        expiresAt: new Date('2026-08-02T00:00:00.000Z'),
        autoRenew: true,
        cancelAtCycleEnd: false
      },
      user: {
        userType: 'player',
        isPremium: false,
        membership: { tier: 'free', validUntil: null }
      }
    });
    const premium = await entitlementService.resolveRandomConnectEntitlement({
      userId,
      now,
      requestSource: 'mobile'
    });
    assert.equal(premium.subjectUserId, userId);
    assert.equal(premium.isPremium, true);
    assert.equal(premium.plan, 'player_pro');
    assert.equal(premium.subscriptionType, 'monthly');
    assert.equal(premium.genderFilterLimit, null);
    assert.equal(premium.maxFiltersAllowed, null);
    assert.equal(premium.featureFlags.unlimitedGenderFilter, true);
    assert.equal(premium.entitlements.randomConnect.genderFilter.unlimited, true);
    assert.equal(premium.entitlements.randomConnect.unlimitedMatches, true);
    assert.equal(premium.source, 'premium_membership');

    const web = await entitlementService.resolveRandomConnectEntitlement({
      userId,
      now,
      requestSource: 'web'
    });
    assert.deepStrictEqual(web, premium, 'request platform must not change entitlement evaluation');

    // Once a canonical membership exists it also wins over a stale User
    // projection that still says Premium after expiry/cancellation.
    setEntitlementFixtures({
      membership: {
        planKey: 'player_pro',
        billingPeriod: 'monthly',
        membershipStatus: 'expired',
        subscriptionStatus: 'expired',
        expiresAt: new Date('2026-07-01T00:00:00.000Z')
      },
      user: {
        userType: 'player',
        isPremium: true,
        membership: { tier: 'player_pro', validUntil: new Date('2026-08-01T00:00:00.000Z') }
      }
    });
    const expired = await entitlementService.resolveRandomConnectEntitlement({ userId, now });
    assert.equal(expired.isPremium, false);
    assert.equal(expired.plan, 'free');
    assert.equal(expired.genderFilterLimit, 5);
    assert.equal(expired.entitlements.randomConnect.genderFilter.dailyLimit, 5);
    assert.equal(expired.entitlements.randomConnect.unlimitedMatches, true, 'Anyone matches remain unmetered for free players');

    const teamContract = entitlementService.buildRandomConnectEntitlement({
      subjectUserId: userId,
      accountType: 'team',
      isPremium: true,
      plan: 'team_pro',
      subscriptionType: 'monthly',
      membershipStatus: 'active',
      subscriptionStatus: 'active',
      source: 'premium_membership'
    });
    assert.equal(teamContract.featureFlags.randomConnect, false);
    assert.equal(teamContract.featureFlags.genderFilter, false);
    assert.equal(teamContract.featureFlags.unlimitedGenderFilter, false);
    assert.equal(teamContract.genderFilterLimit, 0);
    assert.equal(teamContract.entitlements.randomConnect.enabled, false);
    assert.equal(teamContract.entitlements.randomConnect.unlimitedMatches, false);
    assert.equal(teamContract.entitlements.randomConnect.genderFilter.enabled, false);
    assert.equal(teamContract.entitlements.randomConnect.genderFilter.unlimited, false);
    for (const accountType of ['creator', 'admin', 'unknown']) {
      const disabledContract = entitlementService.buildRandomConnectEntitlement({
        subjectUserId: userId,
        accountType,
        isPremium: false,
        plan: 'free',
        source: 'user_projection'
      });
      assert.equal(disabledContract.featureFlags.randomConnect, false, `${accountType} must not receive player capability`);
      assert.equal(disabledContract.entitlements.randomConnect.enabled, false);
      assert.equal(disabledContract.genderFilterLimit, 0);
    }
    setEntitlementFixtures({
      membership: null,
      user: {
        userType: 'creator',
        isPremium: true,
        membership: { tier: 'player_pro', validUntil: null }
      }
    });
    const creatorResolved = await entitlementService.resolveRandomConnectEntitlement({ userId, now });
    assert.equal(creatorResolved.isPremium, true);
    assert.equal(creatorResolved.entitlements.randomConnect.enabled, false);
    assert.equal(creatorResolved.featureFlags.randomConnect, false);

    // Recover installations that already created an unpaid pending canonical
    // trial over a valid legacy entitlement before the creation guard shipped.
    const legacyValidUntil = new Date('2026-07-20T00:00:00.000Z');
    setEntitlementFixtures({
      membership: {
        planKey: 'player_pro_plus',
        billingPeriod: 'yearly',
        membershipStatus: 'trial',
        subscriptionStatus: 'created',
        expiresAt: new Date('2027-07-02T00:00:00.000Z')
      },
      user: {
        userType: 'player',
        isPremium: true,
        membership: { tier: 'player_pro', validUntil: legacyValidUntil }
      }
    });
    const pendingRecovery = await entitlementService.resolveRandomConnectEntitlement({ userId, now });
    assert.equal(pendingRecovery.isPremium, true);
    assert.equal(pendingRecovery.plan, 'player_pro');
    assert.equal(pendingRecovery.subscriptionType, 'legacy');
    assert.equal(pendingRecovery.source, 'user_projection_pending_canonical');
    assert.equal(new Date(pendingRecovery.validUntil).toISOString(), legacyValidUntil.toISOString());

    // Legacy fallback is server-side and reads a fresh User record; no client or
    // JWT premium claim participates in the decision.
    setEntitlementFixtures({
      membership: null,
      user: {
        userType: 'player',
        isPremium: true,
        membership: { tier: 'player_pro_plus', validUntil: null }
      }
    });
    const migratedLater = await entitlementService.resolveRandomConnectEntitlement({ userId, now });
    assert.equal(migratedLater.isPremium, true);
    assert.equal(migratedLater.source, 'user_projection');

    const envelope = entitlementService.randomConnectEntitlementEnvelope(premium);
    assert.strictEqual(envelope.randomConnectEntitlement, premium);
    assert.equal(envelope.subjectUserId, userId);
    assert.equal(envelope.isPremium, true);
    assert.equal(envelope.genderFilterLimit, null);

    // Every projection path must evict the five-minute auth cache, including
    // payment replay and reconciliation, because they all call this function.
    let deletedCacheKeys = [];
    redisCache.setRedisClient({
      del: async (keys) => { deletedCacheKeys = Array.isArray(keys) ? keys : [keys]; }
    });
    let projectedUpdate = null;
    let socketEmission = null;
    global._arcSocketIO = {
      to(room) {
        return {
          emit(event, payload) { socketEmission = { room, event, payload }; }
        };
      }
    };
    User.updateOne = async (filter, update) => {
      projectedUpdate = { filter, update };
      return { matchedCount: 1 };
    };
    await premiumMembershipService.projectEntitlement({
      _id: 'membership-123',
      user: userId,
      version: 7,
      planKey: 'player_pro',
      membershipStatus: 'active',
      expiresAt: new Date('2026-08-02T00:00:00.000Z')
    });
    assert.equal(projectedUpdate.update.$set.isPremium, true);
    assert(deletedCacheKeys.includes(`auth:user:${userId}`));
    assert.equal(socketEmission.room, `user-${userId}`);
    assert.equal(socketEmission.event, 'premium-entitlement-changed');
    assert.equal(socketEmission.payload.userId, userId);
    assert.equal(socketEmission.payload.subjectUserId, userId);
    assert.equal(socketEmission.payload.version, 7);
    assert.equal(socketEmission.payload.isPremium, true);
    assert.match(socketEmission.payload.eventId, /^premium-entitlement:membership-123:7:premium$/);
    assert.equal(socketEmission.payload.changedAt, socketEmission.payload.occurredAt);
    assert.doesNotThrow(() => new Date(socketEmission.payload.changedAt).toISOString());

    const sourceRoot = path.resolve(__dirname, '..', '..');
    const routes = fs.readFileSync(path.join(sourceRoot, 'modules', 'random-connections', 'random-connections.routes.ts'), 'utf8');
    const controller = fs.readFileSync(path.join(sourceRoot, 'legacy-src', 'controllers', 'randomConnectController.js'), 'utf8');
    const membershipController = fs.readFileSync(path.join(sourceRoot, 'legacy-src', 'controllers', 'membershipController.js'), 'utf8');
    const premiumServiceSource = fs.readFileSync(path.join(sourceRoot, 'legacy-src', 'services', 'premiumMembershipService.js'), 'utf8');
    assert(routes.includes('router.get("/entitlements"'));
    assert(controller.includes("res.set('Cache-Control', 'private, no-store')"));
    assert(controller.includes('resolveRandomConnectEntitlement'));
    assert(!controller.includes('const isPremium = isPremiumUser(req.user)'));
    assert(membershipController.includes('resolvePremiumEntitlement'));
    const recurringBlock = premiumServiceSource.slice(
      premiumServiceSource.indexOf('const createRecurringSubscription ='),
      premiumServiceSource.indexOf('const verifyRecurringSubscription =')
    );
    assert(recurringBlock.includes("select('userType isPremium membership createdAt')"));
    assert(recurringBlock.includes('current = await ensureCanonicalForUser(userId)'));
    assert(recurringBlock.indexOf('ensureCanonicalForUser') < recurringBlock.indexOf('if (current && isEntitled(current))'));
  } finally {
    PremiumMembership.findOne = originalMembershipFindOne;
    User.findById = originalUserFindById;
    User.updateOne = originalUserUpdateOne;
    redisCache.setRedisClient(null);
    global._arcSocketIO = originalSocketIo;
  }
}

run()
  .then(() => console.log('Entitlement service tests passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
