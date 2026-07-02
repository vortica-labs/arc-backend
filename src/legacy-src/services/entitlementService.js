const PremiumMembership = require('../models/PremiumMembership');
const User = require('../models/User');
const log = require('../utils/logger');

const RANDOM_CONNECT_ENTITLEMENT_VERSION = 1;
const FREE_DAILY_GENDER_MATCH_LIMIT = 5;
const PREMIUM_PLAN_KEYS = new Set(['player_pro', 'player_pro_plus', 'team_pro', 'team_org']);
const ACTIVE_MEMBERSHIP_STATUSES = new Set(['active']);

const asDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const isPremiumMembershipEntitled = (membership, now = new Date()) => {
  if (!membership || !PREMIUM_PLAN_KEYS.has(membership.planKey)) return false;
  if (!ACTIVE_MEMBERSHIP_STATUSES.has(membership.membershipStatus)) return false;
  const expiresAt = asDate(membership.expiresAt);
  return !expiresAt || expiresAt.getTime() > now.getTime();
};

const isLegacyUserPremium = (user, now = new Date()) => {
  if (!user) return false;
  const plan = user.membership?.tier || user.membership?.plan || 'free';
  if (user.isPremium !== true && !PREMIUM_PLAN_KEYS.has(plan)) return false;
  const validUntil = asDate(user.membership?.validUntil);
  return !validUntil || validUntil.getTime() > now.getTime();
};

const queryCurrentMembership = (userId) => PremiumMembership.findOne({
  user: userId,
  isCurrent: true
}).select(
  'planKey billingPeriod membershipStatus subscriptionStatus autoRenew cancelAtCycleEnd expiresAt currentPeriodEnd source'
).lean();

const queryFreshUserProjection = (userId) => User.findById(userId)
  .select('userType isPremium membership')
  .lean();

/**
 * Resolve Premium access from server data only. A current PremiumMembership is
 * authoritative whenever it exists; the User projection is a migration-only
 * fallback for accounts that have not yet been backfilled.
 */
const resolvePremiumEntitlement = async ({ userId, now = new Date(), requestSource = 'unspecified' }) => {
  const [membership, user] = await Promise.all([
    queryCurrentMembership(userId),
    queryFreshUserProjection(userId)
  ]);

  if (!user) {
    const error = new Error('User not found while resolving entitlement');
    error.code = 'ENTITLEMENT_USER_NOT_FOUND';
    error.status = 404;
    throw error;
  }

  const hasCanonicalMembership = Boolean(membership);
  const canonicalIsPremium = hasCanonicalMembership && isPremiumMembershipEntitled(membership, now);
  const legacyIsPremium = isLegacyUserPremium(user, now);
  // Compatibility recovery for subscriptions created before recurring checkout
  // began canonicalizing an existing legacy entitlement. Only a non-terminal
  // pending trial may defer to the still-valid server-side User projection;
  // cancelled/expired/removed canonical records always remain authoritative.
  const pendingCanonicalMayUseLegacy = Boolean(
    membership?.membershipStatus === 'trial' &&
    ['created', 'authenticated', 'pending', 'unknown'].includes(membership?.subscriptionStatus) &&
    legacyIsPremium
  );
  const useLegacyProjection = !hasCanonicalMembership || pendingCanonicalMayUseLegacy;
  const isPremium = useLegacyProjection ? legacyIsPremium : canonicalIsPremium;
  const legacyPlan = user.membership?.tier || user.membership?.plan || 'free';
  const entitledPlan = useLegacyProjection ? legacyPlan : membership.planKey;
  const plan = isPremium && PREMIUM_PLAN_KEYS.has(entitledPlan) ? entitledPlan : 'free';
  const validUntil = useLegacyProjection
    ? (user.membership?.validUntil || null)
    : (membership.expiresAt || membership.currentPeriodEnd || null);

  const entitlement = {
    subjectUserId: String(userId),
    isPremium,
    plan,
    subscriptionType: !useLegacyProjection
      ? (membership.billingPeriod || 'unknown')
      : (isPremium ? 'legacy' : 'free'),
    membershipStatus: !useLegacyProjection
      ? (membership.membershipStatus || 'unknown')
      : (isPremium ? 'active' : 'free'),
    subscriptionStatus: hasCanonicalMembership
      ? (membership.subscriptionStatus || 'unknown')
      : 'not_applicable',
    autoRenew: hasCanonicalMembership && membership.autoRenew === true,
    cancelAtCycleEnd: hasCanonicalMembership && membership.cancelAtCycleEnd === true,
    validUntil,
    accountType: String(user.userType || 'unknown').toLowerCase(),
    source: useLegacyProjection
      ? (pendingCanonicalMayUseLegacy ? 'user_projection_pending_canonical' : 'user_projection')
      : 'premium_membership'
  };

  if (process.env.RANDOM_CONNECT_ENTITLEMENT_DEBUG === 'true') {
    const randomConnectEnabled = entitlement.accountType === 'player';
    log.info('Random Connect entitlement resolved', {
      userId: String(userId),
      requestSource: String(requestSource || 'unspecified').slice(0, 40),
      entitlementSource: entitlement.source,
      isPremium: entitlement.isPremium,
      plan: entitlement.plan,
      membershipStatus: entitlement.membershipStatus,
      subscriptionStatus: entitlement.subscriptionStatus,
      genderFilterLimit: !randomConnectEnabled ? 0 : (entitlement.isPremium ? null : FREE_DAILY_GENDER_MATCH_LIMIT),
      featureFlags: {
        randomConnect: randomConnectEnabled,
        genderFilter: randomConnectEnabled,
        unlimitedGenderFilter: randomConnectEnabled && entitlement.isPremium
      }
    });
  }

  return entitlement;
};

const buildRandomConnectEntitlement = (premiumEntitlement) => {
  const isPremium = premiumEntitlement?.isPremium === true;
  const enabled = premiumEntitlement?.accountType === 'player';
  const unlimitedGenderFilter = enabled && isPremium;
  const dailyLimit = !enabled ? 0 : (unlimitedGenderFilter ? null : FREE_DAILY_GENDER_MATCH_LIMIT);

  return {
    version: RANDOM_CONNECT_ENTITLEMENT_VERSION,
    subjectUserId: premiumEntitlement?.subjectUserId || '',
    isPremium,
    plan: isPremium ? premiumEntitlement.plan : 'free',
    subscriptionType: premiumEntitlement?.subscriptionType || 'free',
    membershipStatus: premiumEntitlement?.membershipStatus || 'free',
    subscriptionStatus: premiumEntitlement?.subscriptionStatus || 'not_applicable',
    autoRenew: premiumEntitlement?.autoRenew === true,
    cancelAtCycleEnd: premiumEntitlement?.cancelAtCycleEnd === true,
    validUntil: premiumEntitlement?.validUntil || null,
    genderFilterLimit: dailyLimit,
    // Backward-compatible alias: this is the number of gender-filtered
    // matches allowed per day, not the number of UI filter controls.
    maxFiltersAllowed: dailyLimit,
    featureFlags: {
      randomConnect: enabled,
      genderFilter: enabled,
      unlimitedGenderFilter
    },
    entitlements: {
      randomConnect: {
        enabled,
        // "Anyone" matching has no daily quota for enabled accounts. Premium
        // controls filtered-match quota and session-duration capabilities.
        unlimitedMatches: enabled,
        unlimitedUnfilteredMatches: enabled,
        unlimitedSessionDuration: enabled && isPremium,
        genderFilter: {
          enabled,
          unlimited: unlimitedGenderFilter,
          dailyLimit
        }
      }
    },
    source: premiumEntitlement?.source || 'user_projection'
  };
};

const resolveRandomConnectEntitlement = async (options) => (
  buildRandomConnectEntitlement(await resolvePremiumEntitlement(options))
);

const randomConnectEntitlementEnvelope = (entitlement) => ({
  randomConnectEntitlement: entitlement,
  subjectUserId: entitlement.subjectUserId,
  isPremium: entitlement.isPremium,
  subscriptionType: entitlement.subscriptionType,
  genderFilterLimit: entitlement.genderFilterLimit,
  maxFiltersAllowed: entitlement.maxFiltersAllowed,
  featureFlags: entitlement.featureFlags,
  entitlements: entitlement.entitlements
});

module.exports = {
  FREE_DAILY_GENDER_MATCH_LIMIT,
  PREMIUM_PLAN_KEYS,
  isPremiumMembershipEntitled,
  isLegacyUserPremium,
  resolvePremiumEntitlement,
  buildRandomConnectEntitlement,
  resolveRandomConnectEntitlement,
  randomConnectEntitlementEnvelope
};
