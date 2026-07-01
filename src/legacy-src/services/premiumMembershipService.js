const crypto = require('crypto');
const mongoose = require('mongoose');
const PremiumMembership = require('../models/PremiumMembership');
const PremiumMembershipEvent = require('../models/PremiumMembershipEvent');
const PremiumMutationClaim = require('../models/PremiumMutationClaim');
const PaymentTransaction = require('../models/PaymentTransaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const Report = require('../models/Report');
const provider = require('./razorpayPremiumProvider');

const ACTIVE_MEMBERSHIP_STATUSES = new Set(['active']);
const TERMINAL_PROVIDER_STATUSES = new Set(['cancelled', 'completed', 'expired']);
const BILLING_PERIODS = new Set(['monthly', 'quarterly', 'yearly', 'lifetime']);
const PLATFORMS = new Set(['web', 'android', 'ios', 'admin', 'unknown']);
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

const fail = (message, statusCode = 400, code = 'PREMIUM_MEMBERSHIP_ERROR') => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const safeString = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const isObjectId = (value) => typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
const toDate = (value, fieldName) => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw fail(`${fieldName} must be a valid date`);
  return date;
};
const fromUnix = (value) => Number.isFinite(Number(value)) && Number(value) > 0
  ? new Date(Number(value) * 1000)
  : null;

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = canonicalize(value[key]);
    return output;
  }, {});
};
const digest = (value) => crypto.createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(canonicalize(value))
).digest('hex');

const normalizePlatform = (value) => {
  const platform = safeString(value, 20).toLowerCase();
  return PLATFORMS.has(platform) ? platform : 'unknown';
};

const actorFromRequestUser = (user, fallback = 'system', context = {}) => {
  const adminName = safeString(user?.username || user?.email || fallback, 200) || fallback;
  const validAdminId = user?._id && isObjectId(String(user._id)) ? user._id : null;
  const role = safeString(user?.adminRole || user?.userType || fallback, 100) || fallback;
  return {
    actorKey: validAdminId ? `user:${String(validAdminId)}` : `hardcoded:${adminName.toLowerCase()}`,
    adminId: validAdminId,
    adminName,
    role,
    ip: safeString(context.ip, 200),
    userAgent: safeString(context.userAgent, 1000),
    correlationId: safeString(context.correlationId, 200),
    permissions: Array.isArray(user?.adminPermissions)
      ? user.adminPermissions.map((entry) => safeString(entry, 150)).filter(Boolean).slice(0, 100)
      : []
  };
};

const systemActor = (key = 'system') => ({ actorKey: key, adminId: null, adminName: key, role: 'system' });
const customerActor = (userId) => ({ actorKey: `user:${String(userId)}`, adminId: null, adminName: 'customer', role: 'customer' });

const getCatalog = () => {
  // Lazy require avoids a controller/service initialization cycle while the
  // legacy plans remain the pricing source of truth.
  const { PLAYER_PLANS, TEAM_PLANS } = require('../controllers/membershipController');
  return { PLAYER_PLANS, TEAM_PLANS };
};

const findPlan = (planKey, accountType) => {
  const normalized = safeString(planKey, 80).toLowerCase();
  const { PLAYER_PLANS, TEAM_PLANS } = getCatalog();
  const plans = accountType === 'team' ? TEAM_PLANS : PLAYER_PLANS;
  const plan = plans.find((entry) => entry.id === normalized && entry.id !== 'free');
  if (!plan) throw fail('Premium plan is invalid for this account type', 400, 'INVALID_PREMIUM_PLAN');
  return plan;
};

const normalizeBillingPeriod = (value, { recurring = false } = {}) => {
  const period = safeString(value, 30).toLowerCase();
  if (!BILLING_PERIODS.has(period) || (recurring && period === 'lifetime')) {
    throw fail(
      recurring ? 'Recurring billing period must be monthly, quarterly, or yearly' : 'Billing period is invalid',
      400,
      'INVALID_BILLING_PERIOD'
    );
  }
  return period;
};

const planPrice = (plan, billingPeriod) => {
  if (billingPeriod === 'monthly') return Number(plan.priceMonthly || 0);
  if (billingPeriod === 'quarterly') return Number(plan.priceQuarterly || (plan.priceMonthly || 0) * 3);
  if (billingPeriod === 'yearly') return Number(plan.priceYearly || (plan.priceMonthly || 0) * 12);
  return 0;
};

const addMonthsClamped = (date, months) => {
  const source = new Date(date);
  const day = source.getUTCDate();
  const target = new Date(Date.UTC(
    source.getUTCFullYear(), source.getUTCMonth() + months, 1,
    source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()
  ));
  const endOfMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, endOfMonth));
  return target;
};

const deriveExpiry = (startAt, billingPeriod) => {
  if (billingPeriod === 'lifetime') return null;
  const months = billingPeriod === 'monthly' ? 1 : billingPeriod === 'quarterly' ? 3 : 12;
  return addMonthsClamped(startAt, months);
};

const validateMembershipDates = ({ startAt, expiresAt, billingPeriod, immediateGrant = false }) => {
  const start = startAt ? new Date(startAt) : new Date();
  if (Number.isNaN(start.getTime())) throw fail('startAt must be a valid date');
  if (immediateGrant && start.getTime() > Date.now()) throw fail('startAt cannot be in the future for an immediate grant');
  const expiry = expiresAt ? new Date(expiresAt) : null;
  if (billingPeriod === 'lifetime' && expiry) throw fail('Lifetime memberships cannot have an expiry');
  if (billingPeriod !== 'lifetime' && (!expiry || expiry <= start)) {
    throw fail('Finite memberships require an expiry after startAt');
  }
  return { start, expiry };
};

const serializeMembership = (membership) => {
  if (!membership) return null;
  const value = membership.toObject ? membership.toObject() : membership;
  return {
    id: String(value._id),
    _id: value._id,
    user: value.user && typeof value.user === 'object' && value.user.username ? {
      id: String(value.user._id),
      username: value.user.username,
      email: value.user.email,
      displayName: value.user.profile?.displayName || value.user.username,
      avatar: value.user.profile?.avatar || '',
      accountType: value.user.userType === 'team' ? 'Team' : 'User',
      isPremium: Boolean(value.user.isPremium),
      isVerifiedHost: Boolean(value.user.isVerifiedHost),
      isCreator: Boolean(value.user.isCreator),
      creatorMonetizationStatus: value.user.creatorMonetizationStatus || 'not_eligible',
      createdAt: value.user.createdAt,
      lastSeen: value.user.lastSeen
    } : value.user,
    isCurrent: value.isCurrent,
    accountType: value.accountType,
    planKey: value.planKey,
    planTier: value.planTier,
    billingPeriod: value.billingPeriod,
    source: value.source,
    platform: value.platform,
    membershipStatus: value.membershipStatus,
    subscriptionStatus: value.subscriptionStatus,
    autoRenew: value.autoRenew,
    cancelAtCycleEnd: value.cancelAtCycleEnd,
    startedAt: value.startedAt,
    currentPeriodStart: value.currentPeriodStart,
    currentPeriodEnd: value.currentPeriodEnd,
    expiresAt: value.expiresAt,
    cancelledAt: value.cancelledAt,
    endedAt: value.endedAt,
    lastPaymentAt: value.lastPaymentAt,
    amount: value.amount,
    currency: value.currency,
    razorpay: {
      customerId: value.razorpay?.customerId || '',
      subscriptionId: value.razorpay?.subscriptionId || '',
      planId: value.razorpay?.planId || '',
      paymentId: value.razorpay?.paymentId || '',
      orderId: value.razorpay?.orderId || '',
      invoiceId: value.razorpay?.invoiceId || ''
    },
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    premiumPlan: {
      key: value.planKey,
      tier: value.planTier,
      term: value.billingPeriod,
      label: `${String(value.planKey || '').replace(/_/g, ' ')} · ${value.billingPeriod}`
    },
    displayAccountType: value.accountType === 'team' ? 'Team' : 'User',
    providerControlsAvailable: Boolean(value.razorpay?.subscriptionId),
    scheduledChange: value.scheduledChange?.planKey ? value.scheduledChange : null
  };
};

const snapshotState = (membership) => ({
  planKey: membership?.planKey || '',
  billingPeriod: membership?.billingPeriod || '',
  membershipStatus: membership?.membershipStatus || '',
  subscriptionStatus: membership?.subscriptionStatus || '',
  autoRenew: Boolean(membership?.autoRenew),
  cancelAtCycleEnd: Boolean(membership?.cancelAtCycleEnd),
  expiresAt: membership?.expiresAt || null
});

const appendEvent = async ({ membership, action, source, actor, previousState, reason, amount, currency, correlationId, dedupeKey, metadata, timestamp, razorpay }) => {
  const current = membership.toObject ? membership.toObject() : membership;
  try {
    return await PremiumMembershipEvent.create({
      membership: current._id,
      user: current.user,
      action,
      source,
      actor: actor || systemActor(),
      previousPlan: previousState?.planKey || '',
      newPlan: current.planKey || '',
      previousExpiry: previousState?.expiresAt || null,
      newExpiry: current.expiresAt || null,
      previousState: previousState || {},
      newState: snapshotState(current),
      amount: amount === undefined ? null : amount,
      currency: currency || current.currency || 'INR',
      razorpay: razorpay || current.razorpay || {},
      reason: safeString(reason, 1000),
      ip: safeString(actor?.ip, 200),
      userAgent: safeString(actor?.userAgent, 1000),
      correlationId: safeString(correlationId || actor?.correlationId, 200),
      dedupeKey: dedupeKey ? digest(dedupeKey) : undefined,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      timestamp: timestamp || new Date()
    });
  } catch (error) {
    if (error?.code === 11000 && dedupeKey) return null;
    throw error;
  }
};

const claimMutation = async ({ actorKey, operation, idempotencyKey, payload }) => {
  const key = safeString(idempotencyKey, 200);
  if (!key || key.length < 8) throw fail('Idempotency-Key must be between 8 and 200 characters', 400, 'IDEMPOTENCY_KEY_REQUIRED');
  const keyHash = digest(`${actorKey}:${operation}:${key}`);
  const requestHash = digest(payload || {});
  try {
    const claim = await PremiumMutationClaim.create({ actorKey, operation, keyHash, requestHash });
    return { claim, replay: false };
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await PremiumMutationClaim.findOne({ actorKey, operation, keyHash }).lean();
    if (!existing) throw error;
    if (existing.requestHash !== requestHash) {
      throw fail('Idempotency-Key was already used with a different request', 409, 'IDEMPOTENCY_CONFLICT');
    }
    if (existing.status === 'completed') return { claim: existing, replay: true, result: existing.result };
    if (existing.status === 'failed') {
      throw fail('This idempotent request previously failed; use a new key after reviewing the result', 409, existing.errorCode || 'IDEMPOTENT_REQUEST_FAILED');
    }
    if (existing.leaseExpiresAt && new Date(existing.leaseExpiresAt) <= new Date()) {
      await PremiumMutationClaim.updateOne(
        { _id: existing._id, status: 'claimed', leaseExpiresAt: { $lte: new Date() } },
        { $set: { status: 'failed', errorCode: 'IDEMPOTENCY_RECOVERY_REQUIRED', completedAt: new Date() } }
      );
      throw fail('A prior attempt lost its lease; reconcile the membership before using a new key', 409, 'IDEMPOTENCY_RECOVERY_REQUIRED');
    }
    throw fail('This idempotent request is already in progress', 409, 'IDEMPOTENT_REQUEST_IN_PROGRESS');
  }
};

const completeMutation = async (claim, membership, result) => {
  if (!claim?._id) return;
  const updated = await PremiumMutationClaim.updateOne(
    { _id: claim._id, status: 'claimed' },
    { $set: { status: 'completed', membership: membership?._id || membership || null, result, completedAt: new Date() } }
  );
  if (updated.matchedCount !== 1) {
    throw fail('Idempotency outcome could not be persisted', 503, 'IDEMPOTENCY_OUTCOME_PERSIST_FAILED');
  }
};

const failMutation = async (claim, error) => {
  if (!claim?._id) return;
  await PremiumMutationClaim.updateOne(
    { _id: claim._id, status: 'claimed' },
    { $set: { status: 'failed', errorCode: safeString(error?.code || 'PREMIUM_MUTATION_FAILED', 100), completedAt: new Date() } }
  );
};

const isEntitled = (membership, now = new Date()) => Boolean(
  membership && ACTIVE_MEMBERSHIP_STATUSES.has(membership.membershipStatus) &&
  (!membership.expiresAt || new Date(membership.expiresAt) > now)
);

const projectEntitlement = async (membership) => {
  const entitled = isEntitled(membership);
  await User.updateOne(
    { _id: membership.user },
    {
      $set: entitled ? {
        isPremium: true,
        'membership.tier': membership.planKey,
        'membership.validUntil': membership.expiresAt || null
      } : {
        isPremium: false,
        'membership.tier': 'free',
        'membership.validUntil': null,
        'membership.credits': 0
      }
    }
  );
  return entitled;
};

const grantPeriodCredits = async (membership, grantKey) => {
  if (!grantKey) return false;
  const key = digest(grantKey);
  const current = await PremiumMembership.findById(membership._id).select('metadata.lastCreditGrantKey').lean();
  if (current?.metadata?.lastCreditGrantKey === key) return false;
  const plan = findPlan(membership.planKey, membership.accountType);
  const credits = Number(plan.creditsPerMonth || (plan.creditsPerWeek || 0) * 4 || 0);
  await User.updateOne({ _id: membership.user }, { $set: { 'membership.credits': credits } });
  await PremiumMembership.updateOne(
    { _id: membership._id, 'metadata.lastCreditGrantKey': { $ne: key } },
    { $set: { 'metadata.lastCreditGrantKey': key } }
  );
  return true;
};

const safeMembershipUpdate = async (membership, update) => {
  const nextPeriod = update.billingPeriod || membership.billingPeriod;
  const nextStart = update.startedAt !== undefined ? update.startedAt : membership.startedAt;
  const nextExpiry = update.expiresAt !== undefined ? update.expiresAt : membership.expiresAt;
  validateMembershipDates({
    startAt: nextStart || new Date(),
    expiresAt: nextExpiry,
    billingPeriod: nextPeriod,
    immediateGrant: false
  });
  Object.entries(update).forEach(([path, value]) => membership.set(path, value));
  membership.version = Number(membership.version || 0) + 1;
  await membership.save();
  return membership;
};

const notifyLifecycle = async (membership, { title, message, action, source = 'system' }) => {
  const user = await User.findById(membership.user).select('email notificationSettings').lean();
  if (!user) return { inApp: 'skipped', push: 'skipped', email: 'skipped' };
  const settings = user.notificationSettings || {};
  const systemAllowed = settings.systemAlerts !== false;
  const outcomes = { inApp: 'skipped', push: 'skipped', email: 'skipped' };
  let persistedNotification = null;

  if (settings.inAppEnabled !== false && systemAllowed) {
    try {
      persistedNotification = await Notification.createNotification({
        recipient: membership.user,
        type: 'system',
        title,
        message,
        sendPush: false,
        data: { deepLink: '/premium', customData: { premiumMembershipId: String(membership._id), lifecycleAction: action } }
      });
      const { emitNotification } = require('../utils/notificationEmitter');
      emitNotification(membership.user, persistedNotification);
      outcomes.inApp = 'sent';
    } catch {
      outcomes.inApp = 'failed';
    }
  }

  if (settings.pushEnabled !== false && systemAllowed) {
    try {
      const { sendPushNotification } = require('../utils/pushNotificationService');
      await sendPushNotification(membership.user, {
        _id: persistedNotification?._id || new mongoose.Types.ObjectId(),
        recipient: membership.user,
        type: 'system',
        title,
        message,
        data: { deepLink: '/premium', customData: { premiumMembershipId: String(membership._id), lifecycleAction: action } }
      });
      outcomes.push = 'sent';
    } catch {
      outcomes.push = 'failed';
    }
  }

  if (user.email && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const { enqueueEmail } = require('../utils/jobQueue');
      await enqueueEmail(user.email, title, message, process.env.CLIENT_URL ? `${process.env.CLIENT_URL}/premium` : '');
      outcomes.email = 'sent';
    } catch {
      outcomes.email = 'failed';
    }
  }

  await appendEvent({
    membership,
    action: 'notification_outcome',
    source,
    actor: systemActor('system:premium-notifier'),
    metadata: { lifecycleAction: action, channels: outcomes }
  }).catch(() => null);
  return outcomes;
};

const currentForUser = (userId) => PremiumMembership.findOne({ user: userId, isCurrent: true });

const ensureCanonicalForUser = async (userId) => {
  const existing = await currentForUser(userId);
  if (existing) return existing;
  const user = await User.findById(userId).select('userType isPremium membership createdAt');
  if (!user) throw fail('User not found', 404, 'USER_NOT_FOUND');
  const tier = safeString(user.membership?.tier, 80);
  if (!user.isPremium || !tier || tier === 'free') throw fail('No active premium membership was found', 400, 'NO_ACTIVE_MEMBERSHIP');
  const accountType = user.userType === 'team' ? 'team' : (user.userType === 'creator' ? 'creator' : 'player');
  findPlan(tier, accountType);
  const expiresAt = user.membership?.validUntil ? new Date(user.membership.validUntil) : null;
  const startedAt = expiresAt
    ? new Date(Math.min(Date.now(), expiresAt.getTime() - 30 * 24 * 60 * 60 * 1000))
    : (user.createdAt || new Date());
  const billingPeriod = expiresAt ? 'monthly' : 'lifetime';
  const membership = await PremiumMembership.create({
    user: user._id,
    isCurrent: true,
    accountType,
    planKey: tier,
    planTier: tier,
    billingPeriod,
    source: 'migration',
    platform: 'unknown',
    membershipStatus: expiresAt && expiresAt <= new Date() ? 'expired' : 'active',
    subscriptionStatus: 'not_applicable',
    autoRenew: false,
    startedAt,
    currentPeriodStart: startedAt,
    currentPeriodEnd: expiresAt,
    expiresAt,
    metadata: { compatibilityBackfill: true, billingPeriodInferred: Boolean(expiresAt) }
  });
  await appendEvent({ membership, action: 'synchronization', source: 'migration', actor: systemActor('migration:on-demand'), metadata: { compatibilityBackfill: true } });
  return membership;
};

const cancelCurrentForUser = async ({ userId, mode = 'immediate', reason = 'Cancelled by customer' }) => {
  const membership = await ensureCanonicalForUser(userId);
  const effectiveMode = membership.billingPeriod === 'lifetime' && !membership.expiresAt ? 'immediate' : mode;
  return cancelMembership({
    membershipId: membership._id,
    mode: effectiveMode,
    reason,
    actor: customerActor(userId),
    source: 'customer'
  });
};

const upsertCurrentMembership = async ({ user, values }) => {
  let membership = await currentForUser(user._id);
  if (!membership) {
    membership = new PremiumMembership({ user: user._id, isCurrent: true, ...values });
    await membership.save();
    await PaymentTransaction.updateMany(
      { user: user._id, type: 'subscription', status: 'failed', $or: [{ membership: null }, { membership: { $exists: false } }] },
      { $set: { membership: membership._id, referenceId: membership._id, referenceType: 'membership' } }
    );
    return membership;
  }
  await safeMembershipUpdate(membership, values);
  await PaymentTransaction.updateMany(
    { user: user._id, type: 'subscription', status: 'failed', $or: [{ membership: null }, { membership: { $exists: false } }] },
    { $set: { membership: membership._id, referenceId: membership._id, referenceType: 'membership' } }
  );
  return membership;
};

const recordPayment = async ({ membership, payment, orderId, description, platform, billingPeriod, planKey }) => {
  const paymentId = safeString(payment.id, 200);
  if (!paymentId) throw fail('Razorpay payment ID is missing', 400, 'INVALID_PROVIDER_RESPONSE');
  const amount = Number(payment.amount || 0) / 100;
  const values = {
    user: membership.user,
    type: 'subscription',
    amount,
    currency: safeString(payment.currency || 'INR', 3).toUpperCase(),
    status: payment.status === 'refunded' ? 'refunded' : 'completed',
    description,
    orderId: orderId || payment.order_id || '',
    paymentId,
    referenceId: membership._id,
    referenceType: 'membership',
    provider: 'razorpay',
    membership: membership._id,
    providerCustomerId: payment.customer_id || membership.razorpay?.customerId || '',
    providerSubscriptionId: membership.razorpay?.subscriptionId || '',
    providerPaymentId: paymentId,
    providerOrderId: orderId || payment.order_id || '',
    providerInvoiceId: payment.invoice_id || '',
    platform: normalizePlatform(platform),
    paymentMethod: safeString(payment.method, 100),
    capturedAmount: amount,
    paidAt: fromUnix(payment.created_at) || new Date(),
    metadata: { billingPeriod, planKey, razorpayStatus: payment.status }
  };
  try {
    return await PaymentTransaction.findOneAndUpdate(
      { paymentId },
      { $setOnInsert: values },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await PaymentTransaction.findOne({ $or: [{ paymentId }, { providerPaymentId: paymentId }] });
    if (!existing || String(existing.user) !== String(membership.user)) {
      throw fail('Payment is already bound to another account', 409, 'PAYMENT_ALREADY_CONSUMED');
    }
    return existing;
  }
};

const assertProviderAmount = ({ payment, order, plan, billingPeriod }) => {
  const expected = Math.round(planPrice(plan, billingPeriod) * 100);
  const paymentAmount = Number(payment?.amount);
  const orderAmount = order ? Number(order.amount) : expected;
  const paymentCurrency = safeString(payment?.currency, 3).toUpperCase();
  const orderCurrency = order ? safeString(order.currency, 3).toUpperCase() : 'INR';
  if (expected < 100 || paymentAmount !== expected || orderAmount !== expected || paymentCurrency !== 'INR' || orderCurrency !== 'INR') {
    throw fail('Payment amount or currency does not match server pricing', 400, 'PAYMENT_AMOUNT_MISMATCH');
  }
};

const repairPaymentReplay = async ({ transaction, userId, source, action }) => {
  if (String(transaction.user) !== String(userId)) {
    throw fail('Payment is already bound to another account', 409, 'PAYMENT_ALREADY_CONSUMED');
  }
  const membership = transaction.membership
    ? await PremiumMembership.findById(transaction.membership)
    : await currentForUser(userId);
  if (!membership) {
    throw fail('Payment exists but its membership requires reconciliation', 409, 'PAYMENT_RECONCILIATION_REQUIRED');
  }
  await projectEntitlement(membership);
  await appendEvent({
    membership,
    action,
    source,
    actor: customerActor(userId),
    amount: transaction.amount,
    dedupeKey: `payment:${transaction.paymentId || transaction.providerPaymentId}:${action}`,
    metadata: { replayRepair: true }
  });
  return membership;
};

const verifyOneTimePurchase = async ({ userId, orderId, paymentId, signature, platform }) => {
  if (!provider.verifyOrderSignature({ orderId, paymentId, signature })) {
    throw fail('Invalid payment signature', 400, 'INVALID_PAYMENT_SIGNATURE');
  }
  const existingTransaction = await PaymentTransaction.findOne({ $or: [{ paymentId }, { providerPaymentId: paymentId }] });
  if (existingTransaction && String(existingTransaction.user) !== String(userId)) {
    throw fail('Payment is already bound to another account', 409, 'PAYMENT_ALREADY_CONSUMED');
  }

  const [payment, order, user] = await Promise.all([
    provider.fetchPayment(paymentId),
    provider.fetchOrder(orderId),
    User.findById(userId).select('userType')
  ]);
  if (!user) throw fail('User not found', 404, 'USER_NOT_FOUND');
  if (payment?.order_id !== orderId || order?.id !== orderId) throw fail('Payment is not bound to the supplied order', 400, 'PAYMENT_ORDER_MISMATCH');
  if (payment?.status !== 'captured' || order?.status !== 'paid') throw fail('Payment is not captured and paid', 400, 'PAYMENT_NOT_CAPTURED');
  const notes = order.notes || {};
  if (String(notes.userId || '') !== String(userId)) throw fail('Payment order belongs to another account', 403, 'PAYMENT_OWNER_MISMATCH');
  const planKey = safeString(notes.planKey || notes.planId, 80);
  const billingPeriod = normalizeBillingPeriod(notes.billingPeriod);
  const accountType = user.userType === 'team' ? 'team' : (user.userType === 'creator' ? 'creator' : 'player');
  const plan = findPlan(planKey, accountType);
  assertProviderAmount({ payment, order, plan, billingPeriod });
  const previous = await currentForUser(userId);
  const previousState = snapshotState(previous);
  const now = new Date();
  const periodBase = previous?.expiresAt && previous.expiresAt > now ? new Date(previous.expiresAt) : now;
  const derivedEnd = deriveExpiry(periodBase, billingPeriod);
  const expiresAt = previous?.expiresAt && previous.expiresAt > derivedEnd ? new Date(previous.expiresAt) : derivedEnd;
  const startedAt = previous?.startedAt || now;
  if (existingTransaction && previous) {
    const repaired = await repairPaymentReplay({ transaction: existingTransaction, userId, source: 'razorpay_order', action: 'purchase' });
    return { membership: repaired, transaction: existingTransaction, idempotentReplay: true };
  }
  if (previous?.source === 'razorpay_subscription' && previous?.razorpay?.subscriptionId && isEntitled(previous)) {
    throw fail('An active recurring subscription already exists', 409, 'ACTIVE_SUBSCRIPTION_EXISTS');
  }
  const membership = await upsertCurrentMembership({
    user,
    values: {
      accountType,
      planKey: plan.id,
      planTier: plan.id,
      billingPeriod,
      source: 'razorpay_order',
      platform: normalizePlatform(platform),
      membershipStatus: 'active',
      subscriptionStatus: 'not_applicable',
      autoRenew: false,
      cancelAtCycleEnd: false,
      startedAt,
      currentPeriodStart: periodBase,
      currentPeriodEnd: expiresAt,
      expiresAt,
      endedAt: null,
      lastPaymentAt: fromUnix(payment.created_at) || new Date(),
      amount: planPrice(plan, billingPeriod),
      currency: 'INR',
      razorpay: { paymentId, orderId },
      providerSnapshot: provider.sanitizeProviderSnapshot({ payment, order })
    }
  });
  let transaction;
  if (existingTransaction) {
    await PaymentTransaction.updateOne(
      { _id: existingTransaction._id, user: userId },
      { $set: { membership: membership._id, referenceId: membership._id, referenceType: 'membership' } }
    );
    transaction = await PaymentTransaction.findById(existingTransaction._id);
  } else {
    transaction = await recordPayment({ membership, payment, orderId, description: `${plan.name} (${billingPeriod})`, platform, billingPeriod, planKey });
  }
  await grantPeriodCredits(membership, `payment:${paymentId}:credits`);
  await projectEntitlement(membership);
  await appendEvent({
    membership,
    action: 'purchase',
    source: 'razorpay_order',
    actor: customerActor(userId),
    previousState,
    amount: planPrice(plan, billingPeriod),
    dedupeKey: `payment:${paymentId}:purchase`
  });
  await notifyLifecycle(membership, {
    title: 'Premium activated',
    message: `${plan.name} access is now active.`,
    action: 'activation'
  });
  return { membership, transaction, idempotentReplay: Boolean(existingTransaction) };
};

const activateOneTimeWebhookPayment = async ({ payment, eventId }) => {
  if (payment?.subscription_id) return { ignored: true, reason: 'subscription_payment' };
  if (!payment?.id || !payment?.order_id || payment.status !== 'captured') {
    return { ignored: false, retryable: true, reason: 'one_time_payment_not_ready' };
  }
  const [order, existingTransaction] = await Promise.all([
    provider.fetchOrder(payment.order_id),
    PaymentTransaction.findOne({ $or: [{ paymentId: payment.id }, { providerPaymentId: payment.id }] })
  ]);
  if (!order || order.status !== 'paid') return { ignored: false, retryable: true, reason: 'order_not_paid' };
  const notes = order.notes || {};
  if (notes.purpose !== 'premium_membership' && !String(order.receipt || '').startsWith('sub_')) {
    return { ignored: true, reason: 'non_premium_payment' };
  }
  const userId = safeString(notes.userId, 24);
  if (!isObjectId(userId)) throw fail('Payment order user binding is invalid', 400, 'PAYMENT_OWNER_MISMATCH');
  if (existingTransaction && String(existingTransaction.user) !== userId) throw fail('Payment is already bound to another account', 409, 'PAYMENT_ALREADY_CONSUMED');
  const user = await User.findById(userId).select('userType');
  if (!user) return { ignored: false, retryable: true, reason: 'user_not_found' };
  const accountType = user.userType === 'team' ? 'team' : (user.userType === 'creator' ? 'creator' : 'player');
  const planKey = safeString(notes.planKey || notes.planId, 80);
  const billingPeriod = normalizeBillingPeriod(notes.billingPeriod);
  const plan = findPlan(planKey, accountType);
  assertProviderAmount({ payment, order, plan, billingPeriod });
  const current = await currentForUser(userId);
  if (existingTransaction && current) {
    const repaired = await repairPaymentReplay({ transaction: existingTransaction, userId, source: 'razorpay_order', action: 'purchase' });
    return { membership: repaired, transaction: existingTransaction, ignored: false, idempotentReplay: true };
  }
  if (current?.source === 'razorpay_subscription' && current?.razorpay?.subscriptionId && isEntitled(current)) {
    throw fail('An active recurring subscription already exists', 409, 'ACTIVE_SUBSCRIPTION_EXISTS');
  }
  const now = new Date();
  const periodBase = current?.expiresAt && current.expiresAt > now ? new Date(current.expiresAt) : now;
  const calculatedEnd = deriveExpiry(periodBase, billingPeriod);
  const expiresAt = current?.expiresAt && current.expiresAt > calculatedEnd ? new Date(current.expiresAt) : calculatedEnd;
  const previousState = snapshotState(current);
  const membership = await upsertCurrentMembership({
    user,
    values: {
      accountType,
      planKey: plan.id,
      planTier: plan.id,
      billingPeriod,
      source: 'razorpay_order',
      platform: normalizePlatform(notes.platform),
      membershipStatus: 'active',
      subscriptionStatus: 'not_applicable',
      autoRenew: false,
      cancelAtCycleEnd: false,
      startedAt: current?.startedAt || now,
      currentPeriodStart: periodBase,
      currentPeriodEnd: expiresAt,
      expiresAt,
      endedAt: null,
      lastPaymentAt: fromUnix(payment.created_at) || now,
      amount: planPrice(plan, billingPeriod),
      currency: 'INR',
      razorpay: { paymentId: payment.id, orderId: payment.order_id },
      providerSnapshot: provider.sanitizeProviderSnapshot({ payment, order })
    }
  });
  let transaction = existingTransaction;
  if (transaction) {
    await PaymentTransaction.updateOne({ _id: transaction._id }, { $set: { membership: membership._id, referenceId: membership._id, referenceType: 'membership' } });
    transaction = await PaymentTransaction.findById(transaction._id);
  } else {
    transaction = await recordPayment({ membership, payment, orderId: payment.order_id, description: `${plan.name} (${billingPeriod})`, platform: notes.platform, billingPeriod, planKey });
  }
  await grantPeriodCredits(membership, `payment:${payment.id}:credits`);
  await projectEntitlement(membership);
  await appendEvent({ membership, action: 'purchase', source: 'webhook', actor: systemActor('provider:razorpay'), previousState, amount: planPrice(plan, billingPeriod), dedupeKey: `webhook:${eventId}:payment-captured` });
  await notifyLifecycle(membership, { title: 'Premium activated', message: `${plan.name} access is now active.`, action: 'activation' });
  return { membership, transaction, ignored: false, idempotentReplay: Boolean(existingTransaction) };
};

const recordFailedWebhookPayment = async ({ payment, eventId }) => {
  if (!payment?.id) return { ignored: true, reason: 'payment_missing' };
  let membership = null;
  let userId = null;
  let order = null;
  if (payment.subscription_id) {
    membership = await PremiumMembership.findOne({ 'razorpay.subscriptionId': payment.subscription_id, isCurrent: true });
    userId = membership?.user || null;
  } else if (payment.order_id) {
    order = await provider.fetchOrder(payment.order_id);
    userId = safeString(order?.notes?.userId, 24);
  }
  if (!userId || !isObjectId(String(userId))) return { ignored: false, retryable: true, reason: 'payment_owner_not_ready' };
  const user = await User.findById(userId).select('userType');
  if (!user) return { ignored: false, retryable: true, reason: 'payment_owner_not_ready' };
  if (!payment.subscription_id) {
    const notes = order?.notes || {};
    if (notes.purpose !== 'premium_membership' || !String(order?.receipt || '').startsWith('sub_')) {
      return { ignored: true, reason: 'non_premium_payment' };
    }
    const accountType = user.userType === 'team' ? 'team' : (user.userType === 'creator' ? 'creator' : 'player');
    const plan = findPlan(notes.planKey || notes.planId, accountType);
    const billingPeriod = normalizeBillingPeriod(notes.billingPeriod);
    assertProviderAmount({ payment, order, plan, billingPeriod });
  }
  const existing = await PaymentTransaction.findOne({ $or: [{ paymentId: payment.id }, { providerPaymentId: payment.id }] });
  if (existing && String(existing.user) !== String(userId)) throw fail('Payment is already bound to another account', 409, 'PAYMENT_ALREADY_CONSUMED');
  const transaction = await PaymentTransaction.findOneAndUpdate(
    { paymentId: payment.id },
    {
      $setOnInsert: {
        user: userId,
        type: 'subscription',
        amount: Number(payment.amount || 0) / 100,
        currency: safeString(payment.currency || 'INR', 3).toUpperCase(),
        status: 'failed',
        description: 'Premium payment failed',
        orderId: payment.order_id || '',
        paymentId: payment.id,
        referenceId: membership?._id || userId,
        referenceType: membership ? 'membership' : 'other',
        provider: 'razorpay',
        membership: membership?._id || null,
        providerSubscriptionId: payment.subscription_id || undefined,
        providerPaymentId: payment.id,
        providerOrderId: payment.order_id || undefined,
        paymentMethod: safeString(payment.method, 100),
        capturedAmount: 0,
        paidAt: null,
        metadata: { webhookEventId: eventId, errorCode: safeString(payment.error_code, 100), errorDescription: safeString(payment.error_description, 500) }
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  if (membership) {
    await appendEvent({ membership, action: 'mutation_failed', source: 'webhook', actor: systemActor('provider:razorpay'), dedupeKey: `webhook:${eventId}:payment-failed`, metadata: { paymentId: payment.id, providerStatus: payment.status } });
  }
  return { membership, transaction, ignored: false };
};

const createRecurringSubscription = async ({ userId, planKey, billingPeriod, platform, correlationId }) => {
  const period = normalizeBillingPeriod(billingPeriod, { recurring: true });
  const user = await User.findById(userId).select('userType');
  if (!user) throw fail('User not found', 404, 'USER_NOT_FOUND');
  const accountType = user.userType === 'team' ? 'team' : (user.userType === 'creator' ? 'creator' : 'player');
  const plan = findPlan(planKey, accountType);
  const current = await currentForUser(userId);
  if (current?.source === 'razorpay_subscription' && current.membershipStatus === 'trial' && !TERMINAL_PROVIDER_STATUSES.has(current.subscriptionStatus)) {
    throw fail('A recurring subscription creation is already pending; reconcile it before retrying', 409, 'SUBSCRIPTION_CREATE_PENDING');
  }
  if (current?.razorpay?.subscriptionId && !TERMINAL_PROVIDER_STATUSES.has(current.subscriptionStatus)) {
    throw fail('A Razorpay subscription already exists for this account', 409, 'ACTIVE_SUBSCRIPTION_EXISTS');
  }
  if (current && isEntitled(current)) throw fail('Cancel or expire the current membership before starting recurring billing', 409, 'ACTIVE_MEMBERSHIP_EXISTS');

  const startedAt = new Date();
  let membership = await upsertCurrentMembership({
    user,
    values: {
      accountType,
      planKey: plan.id,
      planTier: plan.id,
      billingPeriod: period,
      source: 'razorpay_subscription',
      platform: normalizePlatform(platform),
      membershipStatus: 'trial',
      subscriptionStatus: 'created',
      autoRenew: true,
      cancelAtCycleEnd: false,
      startedAt,
      currentPeriodStart: startedAt,
      currentPeriodEnd: deriveExpiry(startedAt, period),
      expiresAt: deriveExpiry(startedAt, period),
      amount: planPrice(plan, period),
      currency: 'INR',
      razorpay: {},
      metadata: { providerCreateCorrelationId: safeString(correlationId, 200) }
    }
  });
  try {
    const subscription = await provider.createSubscription({ planKey: plan.id, billingPeriod: period, userId, platform, correlationId });
    membership = await safeMembershipUpdate(membership, {
      subscriptionStatus: safeString(subscription.status, 40) || 'created',
      razorpay: {
        customerId: subscription.customer_id || undefined,
        subscriptionId: subscription.id,
        planId: subscription.plan_id,
        paymentId: undefined,
        orderId: undefined
      },
      providerSnapshot: provider.sanitizeProviderSnapshot(subscription)
    });
    await appendEvent({
      membership,
      action: 'subscription_created',
      source: 'razorpay_subscription',
      actor: customerActor(userId),
      dedupeKey: `subscription:${subscription.id}:created`
    });
    return {
      membership,
      checkout: {
        keyId: process.env.RAZORPAY_KEY_ID,
        subscriptionId: subscription.id,
        planKey: plan.id,
        planName: plan.name,
        billingPeriod: period,
        amount: Math.round(planPrice(plan, period) * 100),
        currency: 'INR'
      }
    };
  } catch (error) {
    const definitiveFailure = Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500;
    membership.metadata = {
      ...(membership.metadata || {}),
      providerCreateError: safeString(error?.code || error?.message, 200),
      providerCreatePending: !definitiveFailure
    };
    if (definitiveFailure) {
      membership.membershipStatus = 'cancelled';
      membership.subscriptionStatus = 'cancelled';
      membership.autoRenew = false;
      membership.endedAt = new Date();
    } else {
      membership.reconciliation.error = 'Provider subscription creation outcome is ambiguous; manual reconciliation required';
    }
    await membership.save().catch(() => null);
    throw error;
  }
};

const verifyRecurringSubscription = async ({ userId, subscriptionId, paymentId, signature, platform }) => {
  if (!provider.verifySubscriptionSignature({ subscriptionId, paymentId, signature })) {
    throw fail('Invalid subscription checkout signature', 400, 'INVALID_PAYMENT_SIGNATURE');
  }
  const membership = await PremiumMembership.findOne({
    user: userId,
    isCurrent: true,
    'razorpay.subscriptionId': subscriptionId,
    source: 'razorpay_subscription'
  });
  if (!membership) throw fail('Subscription membership not found', 404, 'MEMBERSHIP_NOT_FOUND');
  const existingTransaction = await PaymentTransaction.findOne({ $or: [{ paymentId }, { providerPaymentId: paymentId }] });
  if (existingTransaction) {
    const repairedMembership = await repairPaymentReplay({ transaction: existingTransaction, userId, source: 'razorpay_subscription', action: 'activation' });
    return { membership: repairedMembership, transaction: existingTransaction, idempotentReplay: true };
  }
  const [subscription, payment] = await Promise.all([
    provider.fetchSubscription(subscriptionId),
    provider.fetchPayment(paymentId)
  ]);
  if (subscription?.id !== subscriptionId || payment?.status !== 'captured') throw fail('Subscription payment is not captured', 400, 'PAYMENT_NOT_CAPTURED');
  if (!['authenticated', 'active'].includes(subscription.status)) throw fail('Subscription is not in an activatable provider state', 409, 'SUBSCRIPTION_NOT_ACTIVATABLE');
  if (payment.subscription_id !== subscriptionId) throw fail('Payment is not bound to this subscription', 400, 'PAYMENT_SUBSCRIPTION_MISMATCH');
  const notes = subscription.notes || {};
  if (String(notes.userId || '') !== String(userId) || notes.planKey !== membership.planKey || notes.billingPeriod !== membership.billingPeriod) {
    throw fail('Subscription metadata does not match the authenticated membership', 403, 'SUBSCRIPTION_BINDING_MISMATCH');
  }
  const expectedPlanId = provider.getConfiguredPlanId(membership.planKey, membership.billingPeriod);
  if (subscription.plan_id !== expectedPlanId || (membership.razorpay?.planId && membership.razorpay.planId !== expectedPlanId)) {
    throw fail('Subscription uses an unexpected provider plan', 400, 'SUBSCRIPTION_PLAN_MISMATCH');
  }
  const plan = findPlan(membership.planKey, membership.accountType);
  assertProviderAmount({ payment, plan, billingPeriod: membership.billingPeriod });
  const previousState = snapshotState(membership);
  const periodStart = fromUnix(subscription.current_start) || new Date();
  const periodEnd = fromUnix(subscription.current_end) || deriveExpiry(periodStart, membership.billingPeriod);
  await safeMembershipUpdate(membership, {
    membershipStatus: 'active',
    subscriptionStatus: ['authenticated', 'active'].includes(subscription.status) ? subscription.status : 'active',
    autoRenew: !subscription.cancel_at_cycle_end,
    cancelAtCycleEnd: Boolean(subscription.cancel_at_cycle_end),
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    expiresAt: periodEnd,
    lastPaymentAt: fromUnix(payment.created_at) || new Date(),
    platform: normalizePlatform(platform),
    razorpay: {
      ...(membership.razorpay?.toObject?.() || membership.razorpay || {}),
      customerId: subscription.customer_id || membership.razorpay.customerId,
      subscriptionId,
      planId: subscription.plan_id,
      paymentId,
      orderId: payment.order_id || membership.razorpay.orderId
    },
    providerSnapshot: provider.sanitizeProviderSnapshot(subscription)
  });
  const transaction = await recordPayment({ membership, payment, orderId: payment.order_id, description: `${plan.name} recurring (${membership.billingPeriod})`, platform, billingPeriod: membership.billingPeriod, planKey: membership.planKey });
  await grantPeriodCredits(membership, `payment:${paymentId}:credits`);
  await projectEntitlement(membership);
  await appendEvent({ membership, action: 'activation', source: 'razorpay_subscription', actor: customerActor(userId), previousState, amount: planPrice(plan, membership.billingPeriod), dedupeKey: `payment:${paymentId}:activation` });
  await notifyLifecycle(membership, { title: 'Premium subscription active', message: `${plan.name} recurring access is now active.`, action: 'activation' });
  return { membership, transaction, idempotentReplay: false };
};

const grantMembership = async ({ userId, planKey, billingPeriod, startAt, expiresAt, reason, platform, actor }) => {
  if (safeString(reason, 1000).length < 3) throw fail('A reason of at least 3 characters is required');
  if (!isObjectId(String(userId))) throw fail('User ID is invalid');
  const user = await User.findById(userId).select('userType');
  if (!user) throw fail('User not found', 404, 'USER_NOT_FOUND');
  const accountType = user.userType === 'team' ? 'team' : (user.userType === 'creator' ? 'creator' : 'player');
  const plan = findPlan(planKey, accountType);
  const period = normalizeBillingPeriod(billingPeriod);
  const start = toDate(startAt, 'startAt') || new Date();
  const suppliedExpiry = toDate(expiresAt, 'expiresAt');
  const expiry = suppliedExpiry || deriveExpiry(start, period);
  validateMembershipDates({ startAt: start, expiresAt: expiry, billingPeriod: period, immediateGrant: true });
  const existing = await currentForUser(userId);
  if (existing && isEntitled(existing)) {
    throw fail('This user already has active premium access; use Extend or Change Plan', 409, 'ACTIVE_MEMBERSHIP_EXISTS');
  }
  if (existing?.source === 'razorpay_subscription' && existing?.razorpay?.subscriptionId && !TERMINAL_PROVIDER_STATUSES.has(existing.subscriptionStatus)) {
    throw fail('Use subscription lifecycle actions for an active recurring membership', 409, 'ACTIVE_SUBSCRIPTION_EXISTS');
  }
  const previousState = snapshotState(existing);
  const membership = await upsertCurrentMembership({
    user,
    values: {
      accountType,
      planKey: plan.id,
      planTier: plan.id,
      billingPeriod: period,
      source: 'manual',
      platform: normalizePlatform(platform || 'admin'),
      membershipStatus: 'active',
      subscriptionStatus: 'not_applicable',
      autoRenew: false,
      cancelAtCycleEnd: false,
      startedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: expiry,
      expiresAt: expiry,
      cancelledAt: null,
      endedAt: null,
      amount: 0,
      currency: 'INR',
      razorpay: {},
      manual: { actorKey: actor.actorKey, actorId: actor.adminId, adminName: actor.adminName, role: actor.role, reason: safeString(reason, 1000) }
    }
  });
  await projectEntitlement(membership);
  await appendEvent({ membership, action: 'activation', source: 'admin', actor, previousState, reason });
  await notifyLifecycle(membership, { title: 'Premium granted', message: `${plan.name} access has been granted.`, action: 'activation' });
  return membership;
};

const getMembershipOrThrow = async (membershipId) => {
  if (!isObjectId(String(membershipId))) throw fail('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');
  const membership = await PremiumMembership.findById(membershipId);
  if (!membership || !membership.isCurrent) throw fail('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');
  return membership;
};

const extendMembership = async ({ membershipId, billingPeriod, expiresAt, days, reason, actor }) => {
  const membership = await getMembershipOrThrow(membershipId);
  if (membership.billingPeriod === 'lifetime' && !membership.expiresAt) {
    throw fail('Lifetime membership is already permanent and cannot be extended', 409, 'LIFETIME_ALREADY_PERMANENT');
  }
  if (membership.razorpay?.subscriptionId) throw fail('Recurring subscriptions are extended by provider renewals', 409, 'PROVIDER_MANAGED_MEMBERSHIP');
  const period = normalizeBillingPeriod(billingPeriod || membership.billingPeriod);
  const base = membership.expiresAt && membership.expiresAt > new Date() ? membership.expiresAt : new Date();
  let expiry = toDate(expiresAt, 'expiresAt');
  if (days !== undefined && days !== null && days !== '') {
    const extensionDays = Number(days);
    if (!Number.isInteger(extensionDays) || extensionDays < 1 || extensionDays > 3650) throw fail('days must be an integer between 1 and 3650');
    expiry = new Date(base.getTime() + extensionDays * 24 * 60 * 60 * 1000);
  }
  expiry = expiry || deriveExpiry(base, period);
  validateMembershipDates({ startAt: membership.startedAt || new Date(), expiresAt: expiry, billingPeriod: period });
  const previousState = snapshotState(membership);
  await safeMembershipUpdate(membership, { billingPeriod: period, expiresAt: expiry, currentPeriodEnd: expiry, membershipStatus: 'active', endedAt: null });
  await projectEntitlement(membership);
  await appendEvent({ membership, action: 'renewal', source: 'admin', actor, previousState, reason });
  await notifyLifecycle(membership, { title: 'Premium extended', message: `Your premium access now runs until ${expiry.toISOString()}.`, action: 'renewal' });
  return membership;
};

const changePlan = async ({ membershipId, planKey, billingPeriod, expiresAt, scheduleChangeAt = 'now', reason, actor }) => {
  const membership = await getMembershipOrThrow(membershipId);
  const plan = findPlan(planKey, membership.accountType);
  const period = normalizeBillingPeriod(billingPeriod || membership.billingPeriod);
  if (membership.razorpay?.subscriptionId) {
    if (!['authenticated', 'active'].includes(membership.subscriptionStatus)) {
      throw fail('Only authenticated or active subscriptions can change plan', 409, 'SUBSCRIPTION_PLAN_CHANGE_NOT_ALLOWED');
    }
    if (period === 'lifetime') throw fail('Recurring subscriptions cannot change to lifetime');
    if (!['now', 'cycle_end'].includes(scheduleChangeAt)) throw fail('scheduleChangeAt must be now or cycle_end');
    const nextProviderPlanId = provider.getConfiguredPlanId(plan.id, period);
    const previousState = snapshotState(membership);
    const pendingPlanChange = {
      planKey: plan.id,
      planId: nextProviderPlanId,
      billingPeriod: period,
      effectiveAt: scheduleChangeAt === 'cycle_end' ? membership.currentPeriodEnd : new Date(),
      correlationId: actor?.correlationId || ''
    };
    await safeMembershipUpdate(membership, {
      scheduledChange: pendingPlanChange,
      'metadata.pendingPlanChange': pendingPlanChange
    });
    let providerResult;
    try {
      providerResult = await provider.updateSubscription(membership.razorpay.subscriptionId, {
        planId: nextProviderPlanId,
        scheduleChangeAt
      });
    } catch (error) {
      if (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500) {
        await safeMembershipUpdate(membership, {
          scheduledChange: { planKey: undefined, planId: undefined, billingPeriod: undefined, effectiveAt: null },
          'metadata.pendingPlanChange': null
        }).catch(() => null);
      }
      throw error;
    }
    if (scheduleChangeAt === 'cycle_end') {
      await safeMembershipUpdate(membership, {
        scheduledChange: {
          planKey: plan.id,
          planId: nextProviderPlanId,
          billingPeriod: period,
          effectiveAt: fromUnix(providerResult.change_scheduled_at) || membership.currentPeriodEnd
        },
        'metadata.pendingPlanChange': {
          planKey: plan.id,
          planId: nextProviderPlanId,
          billingPeriod: period,
          effectiveAt: fromUnix(providerResult.change_scheduled_at) || membership.currentPeriodEnd,
          correlationId: actor?.correlationId || ''
        },
        providerSnapshot: provider.sanitizeProviderSnapshot(providerResult)
      });
    } else {
      const periodStart = fromUnix(providerResult.current_start) || new Date();
      const periodEnd = fromUnix(providerResult.current_end) || deriveExpiry(periodStart, period);
      await safeMembershipUpdate(membership, {
        planKey: plan.id,
        planTier: plan.id,
        billingPeriod: period,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        expiresAt: periodEnd,
        amount: planPrice(plan, period),
        razorpay: { ...(membership.razorpay?.toObject?.() || membership.razorpay || {}), planId: nextProviderPlanId },
        scheduledChange: { planKey: undefined, planId: undefined, billingPeriod: undefined, effectiveAt: null },
        'metadata.pendingPlanChange': null,
        providerSnapshot: provider.sanitizeProviderSnapshot(providerResult)
      });
      await projectEntitlement(membership);
    }
    await appendEvent({ membership, action: 'plan_change', source: 'admin', actor, previousState, reason, metadata: { scheduleChangeAt, providerPlanId: nextProviderPlanId } });
    await notifyLifecycle(membership, {
      title: scheduleChangeAt === 'cycle_end' ? 'Premium plan change scheduled' : 'Premium plan changed',
      message: scheduleChangeAt === 'cycle_end' ? `${plan.name} will begin at the next billing cycle.` : `Your premium plan is now ${plan.name}.`,
      action: 'plan_change'
    });
    return membership;
  }
  const explicitExpiry = toDate(expiresAt, 'expiresAt');
  const derived = period === 'lifetime' ? null : deriveExpiry(new Date(), period);
  const expiry = period === 'lifetime'
    ? null
    : (explicitExpiry || (membership.expiresAt && membership.expiresAt > derived ? membership.expiresAt : derived));
  validateMembershipDates({ startAt: membership.startedAt || new Date(), expiresAt: expiry, billingPeriod: period });
  const previousState = snapshotState(membership);
  await safeMembershipUpdate(membership, { planKey: plan.id, planTier: plan.id, billingPeriod: period, expiresAt: expiry, currentPeriodEnd: expiry });
  await projectEntitlement(membership);
  await appendEvent({ membership, action: 'plan_change', source: 'admin', actor, previousState, reason });
  await notifyLifecycle(membership, { title: 'Premium plan changed', message: `Your premium plan is now ${plan.name}.`, action: 'plan_change' });
  return membership;
};

const cancelMembership = async ({ membershipId, mode = 'cycle_end', reason, actor, source = 'admin' }) => {
  const membership = await getMembershipOrThrow(membershipId);
  if (!['immediate', 'cycle_end'].includes(mode)) throw fail('Cancellation mode must be immediate or cycle_end');
  if (['cancelled', 'expired', 'removed', 'refunded'].includes(membership.membershipStatus)) return membership;
  if (mode === 'cycle_end' && !membership.expiresAt) {
    throw fail('A no-expiry lifetime membership can only be cancelled immediately', 400, 'LIFETIME_REQUIRES_IMMEDIATE_CANCELLATION');
  }
  if (mode === 'cycle_end' && membership.cancelAtCycleEnd && !membership.autoRenew) return membership;
  const previousState = snapshotState(membership);
  let providerResult = null;
  if (membership.razorpay?.subscriptionId) {
    providerResult = await provider.cancelSubscription(membership.razorpay.subscriptionId, mode === 'cycle_end');
  }
  if (mode === 'cycle_end') {
    await safeMembershipUpdate(membership, {
      autoRenew: false,
      cancelAtCycleEnd: true,
      cancelledAt: new Date(),
      providerSnapshot: providerResult ? provider.sanitizeProviderSnapshot(providerResult) : membership.providerSnapshot
    });
  } else {
    const now = new Date();
    await safeMembershipUpdate(membership, {
      membershipStatus: 'cancelled',
      subscriptionStatus: membership.razorpay?.subscriptionId ? 'cancelled' : 'not_applicable',
      autoRenew: false,
      cancelAtCycleEnd: false,
      cancelledAt: now,
      endedAt: now,
      expiresAt: membership.billingPeriod === 'lifetime' ? null : now,
      currentPeriodEnd: membership.billingPeriod === 'lifetime' ? null : now,
      providerSnapshot: providerResult ? provider.sanitizeProviderSnapshot(providerResult) : membership.providerSnapshot
    });
  }
  await projectEntitlement(membership);
  await appendEvent({ membership, action: 'cancellation', source, actor, previousState, reason, metadata: { mode } });
  await notifyLifecycle(membership, {
    title: mode === 'cycle_end' ? 'Premium cancellation scheduled' : 'Premium cancelled',
    message: mode === 'cycle_end' ? 'Your premium access remains active until the current period ends.' : 'Your premium access has ended.',
    action: 'cancellation'
  });
  return membership;
};

const removeMembership = async ({ membershipId, reason, actor }) => {
  if (safeString(reason, 1000).length < 3) throw fail('A reason of at least 3 characters is required');
  const membership = await getMembershipOrThrow(membershipId);
  if (['removed', 'refunded', 'expired', 'cancelled'].includes(membership.membershipStatus)) return membership;
  if (membership.razorpay?.subscriptionId && !TERMINAL_PROVIDER_STATUSES.has(membership.subscriptionStatus)) {
    await provider.cancelSubscription(membership.razorpay.subscriptionId, false);
  }
  const previousState = snapshotState(membership);
  const now = new Date();
  await safeMembershipUpdate(membership, {
    membershipStatus: 'removed', subscriptionStatus: membership.razorpay?.subscriptionId ? 'cancelled' : membership.subscriptionStatus,
    autoRenew: false, cancelAtCycleEnd: false, endedAt: now,
    expiresAt: membership.billingPeriod === 'lifetime' ? null : now,
    currentPeriodEnd: membership.billingPeriod === 'lifetime' ? null : now
  });
  await projectEntitlement(membership);
  await appendEvent({ membership, action: 'access_removal', source: 'admin', actor, previousState, reason });
  await notifyLifecycle(membership, { title: 'Premium access removed', message: 'Premium access has been removed by the platform.', action: 'access_removal' });
  return membership;
};

const resumeMembership = async ({ membershipId, reason, actor }) => {
  const membership = await getMembershipOrThrow(membershipId);
  if (!membership.razorpay?.subscriptionId) throw fail('This membership has no provider subscription to resume', 409, 'PROVIDER_SUBSCRIPTION_REQUIRED');
  if (membership.subscriptionStatus !== 'paused') throw fail('Only paused subscriptions can be resumed', 409, 'SUBSCRIPTION_NOT_RESUMABLE');
  const previousState = snapshotState(membership);
  const result = await provider.resumeSubscription(membership.razorpay.subscriptionId);
  const periodEnd = fromUnix(result.current_end) || membership.expiresAt;
  await safeMembershipUpdate(membership, {
    membershipStatus: periodEnd && periodEnd <= new Date() ? 'expired' : 'active',
    subscriptionStatus: 'active', autoRenew: true, cancelAtCycleEnd: false,
    expiresAt: periodEnd, currentPeriodEnd: periodEnd,
    providerSnapshot: provider.sanitizeProviderSnapshot(result)
  });
  await projectEntitlement(membership);
  await appendEvent({ membership, action: 'resume', source: 'admin', actor, previousState, reason });
  await notifyLifecycle(membership, { title: 'Premium subscription resumed', message: 'Your recurring premium subscription has resumed.', action: 'resume' });
  return membership;
};

const setAutoRenew = async ({ membershipId, enabled, reason, actor }) => {
  if (typeof enabled !== 'boolean') throw fail('enabled must be a boolean');
  const membership = await getMembershipOrThrow(membershipId);
  if (!membership.razorpay?.subscriptionId) throw fail('Auto-renew controls require a provider subscription', 409, 'PROVIDER_SUBSCRIPTION_REQUIRED');
  if (enabled) {
    if (membership.autoRenew && !membership.cancelAtCycleEnd) return membership;
    throw fail('Razorpay cancellation cannot be reactivated; create a new subscription after access ends', 409, 'PROVIDER_OPERATION_UNSUPPORTED');
  }
  if (!membership.autoRenew && membership.cancelAtCycleEnd) return membership;
  const previousState = snapshotState(membership);
  const result = await provider.cancelSubscription(membership.razorpay.subscriptionId, true);
  await safeMembershipUpdate(membership, {
    autoRenew: enabled,
    cancelAtCycleEnd: !enabled,
    providerSnapshot: provider.sanitizeProviderSnapshot(result)
  });
  await appendEvent({ membership, action: 'auto_renew_change', source: 'admin', actor, previousState, reason, metadata: { enabled } });
  await notifyLifecycle(membership, { title: 'Premium auto-renew updated', message: 'Auto-renew has been disabled and cancellation is scheduled for the period end.', action: 'auto_renew_change' });
  return membership;
};

const refundMembershipPayment = async ({ membershipId, paymentTransactionId, amount, reason, actor }) => {
  if (safeString(reason, 1000).length < 3) throw fail('A refund reason of at least 3 characters is required');
  const membership = await getMembershipOrThrow(membershipId);
  const query = { membership: membership._id, status: { $in: ['completed', 'refunded'] }, provider: 'razorpay' };
  if (paymentTransactionId) {
    if (!isObjectId(String(paymentTransactionId))) throw fail('Payment transaction not found', 404, 'PAYMENT_NOT_FOUND');
    query._id = paymentTransactionId;
  }
  const candidate = await PaymentTransaction.findOne(query).sort({ paidAt: -1, createdAt: -1 }).lean();
  if (!candidate || !candidate.providerPaymentId || Number(candidate.capturedAmount || candidate.amount) <= 0) {
    throw fail('A captured Razorpay payment is required for a refund', 409, 'CAPTURED_PAYMENT_REQUIRED');
  }
  const captured = Number(candidate.capturedAmount || candidate.amount);
  const refunded = Number(candidate.refundedAmount || 0);
  const reserved = Number(candidate.refundReservedAmount || 0);
  const remaining = Math.max(0, captured - refunded - reserved);
  const requested = amount === undefined || amount === null || amount === '' ? remaining : Number(amount);
  if (!Number.isFinite(requested) || requested <= 0 || requested > remaining || Math.abs(requested * 100 - Math.round(requested * 100)) > 1e-8) {
    throw fail('Refund amount exceeds the remaining refundable amount', 400, 'INVALID_REFUND_AMOUNT');
  }
  const lockToken = crypto.randomUUID();
  const refundReceipt = `pm_${String(membership._id).slice(-8)}_${Date.now().toString().slice(-8)}`;
  const fundingDate = candidate.paidAt || candidate.createdAt;
  const newerFundingExists = Boolean(await PaymentTransaction.exists({
    membership: membership._id,
    _id: { $ne: candidate._id },
    status: 'completed',
    $or: [
      { paidAt: { $gt: fundingDate } },
      { paidAt: null, createdAt: { $gt: candidate.createdAt } }
    ]
  }));
  let transaction = await PaymentTransaction.findOneAndUpdate(
    {
      _id: candidate._id,
      $or: [{ refundLockToken: '' }, { refundLockToken: null }, { refundLockToken: { $exists: false } }],
      $expr: {
        $gte: [
          {
            $subtract: [
              { $cond: [{ $gt: ['$capturedAmount', 0] }, '$capturedAmount', '$amount'] },
              { $add: [{ $ifNull: ['$refundedAmount', 0] }, { $ifNull: ['$refundReservedAmount', 0] }] }
            ]
          },
          requested
        ]
      }
    },
    {
      $set: {
        refundLockToken: lockToken,
        refundLockAt: new Date(),
        refundLockAmount: requested,
        refundLockReceipt: refundReceipt
      },
      $inc: { refundReservedAmount: requested }
    },
    { new: true }
  );
  if (!transaction) throw fail('Another refund is in progress or the refundable balance changed', 409, 'REFUND_CONFLICT');

  let refund;
  try {
    refund = await provider.refundPayment(transaction.providerPaymentId, {
      amount: Math.round(requested * 100),
      notes: { membershipId: String(membership._id), reason: safeString(reason, 500) },
      receipt: refundReceipt
    });
  } catch (error) {
    if (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500) {
      await PaymentTransaction.updateOne(
        { _id: transaction._id, refundLockToken: lockToken },
        { $inc: { refundReservedAmount: -requested }, $set: { refundLockToken: '', refundLockAt: null, refundLockAmount: 0, refundLockReceipt: '' } }
      ).catch(() => null);
    } else {
      error.providerStatus = 'unknown_after_refund_request';
      error.localStatus = 'refund_lock_awaiting_reconciliation';
    }
    throw error;
  }

  const processed = refund.status === 'processed';
  const failed = refund.status === 'failed';
  const totalRefunded = refunded + (processed ? requested : 0);
  const transactionUpdate = {
    $set: {
      refundLockToken: '',
      refundLockAt: null,
      refundLockAmount: 0,
      refundLockReceipt: '',
      providerRefundId: refund.id,
      refundStatus: failed ? 'failed' : (processed ? (totalRefunded >= captured ? 'full' : 'partial') : 'pending')
    },
    $push: { refundHistory: { refundId: refund.id, amount: requested, status: processed ? 'processed' : (failed ? 'failed' : 'pending'), reservedAmount: (!processed && !failed) ? requested : 0, reason } }
  };
  if (processed) transactionUpdate.$inc = { refundReservedAmount: -requested, refundedAmount: requested };
  if (failed) transactionUpdate.$inc = { refundReservedAmount: -requested };
  if (processed && totalRefunded >= captured) transactionUpdate.$set.status = 'refunded';
  transaction = await PaymentTransaction.findOneAndUpdate(
    { _id: transaction._id, refundLockToken: lockToken, 'refundHistory.refundId': { $ne: refund.id } },
    transactionUpdate,
    { new: true, runValidators: true }
  );
  if (!transaction) {
    transaction = await PaymentTransaction.findOne({ _id: candidate._id, 'refundHistory.refundId': refund.id });
    const racedEntry = transaction?.refundHistory?.find((entry) => entry.refundId === refund.id);
    if (!transaction || !racedEntry) {
      const divergence = fail('Refund was submitted but local reconciliation is required', 503, 'REFUND_RECONCILIATION_REQUIRED');
      divergence.providerStatus = refund.status || 'submitted';
      divergence.localStatus = 'reconciliation_required';
      throw divergence;
    }
    await PaymentTransaction.updateOne(
      { _id: transaction._id, refundLockToken: lockToken },
      {
        $inc: { refundReservedAmount: -requested },
        $set: { refundLockToken: '', refundLockAt: null, refundLockAmount: 0, refundLockReceipt: '' }
      }
    );
    transaction = await PaymentTransaction.findById(transaction._id);
  }

  const fullRefundRequested = refunded + requested >= captured;
  if (processed && fullRefundRequested && !newerFundingExists && membership.razorpay?.subscriptionId && !TERMINAL_PROVIDER_STATUSES.has(membership.subscriptionStatus)) {
    try {
      await provider.cancelSubscription(membership.razorpay.subscriptionId, false);
    } catch (error) {
      membership.reconciliation.error = 'Full refund submitted; provider subscription cancellation requires reconciliation';
      await membership.save().catch(() => null);
      const divergence = fail('Refund was submitted but recurring billing cancellation requires reconciliation', 502, 'REFUND_CANCELLATION_RECONCILIATION_REQUIRED');
      divergence.providerStatus = refund.status || 'submitted';
      divergence.localStatus = 'reconciliation_required';
      throw divergence;
    }
  }
  const previousState = snapshotState(membership);
  if (processed && totalRefunded >= captured && !newerFundingExists) {
    const now = new Date();
    await safeMembershipUpdate(membership, {
      membershipStatus: 'refunded',
      subscriptionStatus: membership.razorpay?.subscriptionId ? 'cancelled' : membership.subscriptionStatus,
      autoRenew: false,
      cancelAtCycleEnd: false,
      endedAt: now,
      expiresAt: membership.billingPeriod === 'lifetime' ? null : now,
      currentPeriodEnd: membership.billingPeriod === 'lifetime' ? null : now
    });
    await projectEntitlement(membership);
  }
  await appendEvent({ membership, action: 'refund', source: 'admin', actor, previousState, reason, amount: requested, dedupeKey: `refund:${refund.id}`, razorpay: { ...membership.razorpay, refundId: refund.id } });
  await notifyLifecycle(membership, { title: 'Premium payment refunded', message: `A refund of ₹${requested.toFixed(2)} was ${processed ? 'processed' : 'requested'}.`, action: 'refund' });
  return { membership, transaction, refund: provider.sanitizeProviderSnapshot(refund) };
};

const providerStatusToMembership = (status, periodEnd) => {
  if (['active', 'authenticated', 'resumed'].includes(status)) return 'active';
  if (['pending', 'halted', 'paused'].includes(status) && periodEnd && periodEnd > new Date()) return 'active';
  if (status === 'cancelled') return 'cancelled';
  if (['completed', 'expired'].includes(status)) return 'expired';
  return null;
};

const providerBoolean = (value, fallback) => {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return fallback;
};

const applySubscriptionEvent = async ({ eventId, eventType, providerCreatedAt, subscription, payment }) => {
  let membership = await PremiumMembership.findOne({ 'razorpay.subscriptionId': subscription?.id, isCurrent: true });
  if (!membership && payment?.id) {
    const transaction = await PaymentTransaction.findOne({ $or: [{ paymentId: payment.id }, { providerPaymentId: payment.id }] });
    if (transaction?.membership) membership = await PremiumMembership.findById(transaction.membership);
  }
  if (!membership) {
    const notes = subscription?.notes || {};
    const userId = safeString(notes.userId, 24);
    const planKey = safeString(notes.planKey, 80);
    const billingPeriod = safeString(notes.billingPeriod, 30);
    if (isObjectId(userId) && BILLING_PERIODS.has(billingPeriod) && billingPeriod !== 'lifetime') {
      const user = await User.findById(userId).select('userType');
      if (user) {
        const accountType = user.userType === 'team' ? 'team' : (user.userType === 'creator' ? 'creator' : 'player');
        const plan = findPlan(planKey, accountType);
        const expectedPlanId = provider.getConfiguredPlanId(plan.id, billingPeriod);
        if (subscription.plan_id !== expectedPlanId) throw fail('Webhook subscription plan does not match signed notes', 400, 'SUBSCRIPTION_PLAN_MISMATCH');
        const current = await currentForUser(userId);
        if (!current || (current.source === 'razorpay_subscription' && current.planKey === plan.id && !current.razorpay?.subscriptionId)) {
          const start = fromUnix(subscription.current_start) || new Date();
          const end = fromUnix(subscription.current_end) || deriveExpiry(start, billingPeriod);
          membership = await upsertCurrentMembership({
            user,
            values: {
              accountType,
              planKey: plan.id,
              planTier: plan.id,
              billingPeriod,
              source: 'razorpay_subscription',
              platform: normalizePlatform(notes.platform),
              membershipStatus: 'trial',
              subscriptionStatus: 'created',
              autoRenew: true,
              startedAt: start,
              currentPeriodStart: start,
              currentPeriodEnd: end,
              expiresAt: end,
              amount: planPrice(plan, billingPeriod),
              currency: 'INR',
              razorpay: { subscriptionId: subscription.id, planId: subscription.plan_id, customerId: subscription.customer_id || undefined }
            }
          });
        }
      }
    }
  }
  if (!membership) return { ignored: false, retryable: true, reason: 'membership_not_found' };
  if (['removed', 'refunded'].includes(membership.membershipStatus)) return { ignored: true, reason: 'terminal_membership' };
  const eventAt = providerCreatedAt || new Date();
  if (membership.providerLastEventAt && eventAt < membership.providerLastEventAt) return { ignored: true, reason: 'out_of_order', membership };
  const providerStatus = safeString(subscription.status || eventType.split('.')[1], 40).toLowerCase();
  if (TERMINAL_PROVIDER_STATUSES.has(membership.subscriptionStatus) && !TERMINAL_PROVIDER_STATUSES.has(providerStatus)) {
    return { ignored: true, reason: 'terminal_provider_state', membership };
  }
  const previousState = snapshotState(membership);
  const periodStart = fromUnix(subscription.current_start) || membership.currentPeriodStart;
  const periodEnd = fromUnix(subscription.current_end) || membership.currentPeriodEnd || membership.expiresAt;
  const currentPlanId = provider.getConfiguredPlanId(membership.planKey, membership.billingPeriod);
  if (membership.razorpay?.planId && membership.razorpay.planId !== currentPlanId) {
    throw fail('Webhook subscription plan does not match membership', 400, 'SUBSCRIPTION_PLAN_MISMATCH');
  }
  const pendingChange = membership.scheduledChange?.planKey ? membership.scheduledChange : membership.metadata?.pendingPlanChange;
  let effectivePlanKey = membership.planKey;
  let effectiveBillingPeriod = membership.billingPeriod;
  let pendingActivated = false;
  if (subscription.plan_id !== currentPlanId) {
    if (!pendingChange?.planKey || !pendingChange?.billingPeriod) throw fail('Webhook subscription plan does not match membership', 400, 'SUBSCRIPTION_PLAN_MISMATCH');
    const pendingPlanId = provider.getConfiguredPlanId(pendingChange.planKey, pendingChange.billingPeriod);
    if (subscription.plan_id !== pendingPlanId || (pendingChange.planId && pendingChange.planId !== pendingPlanId)) {
      throw fail('Webhook subscription plan does not match scheduled change', 400, 'SUBSCRIPTION_PLAN_MISMATCH');
    }
    effectivePlanKey = pendingChange.planKey;
    effectiveBillingPeriod = pendingChange.billingPeriod;
    pendingActivated = true;
  }
  if (payment) {
    if (payment.status !== 'captured' || payment.subscription_id !== subscription.id) {
      throw fail('Webhook payment is not a captured payment for this subscription', 400, 'PAYMENT_SUBSCRIPTION_MISMATCH');
    }
    const plan = findPlan(effectivePlanKey, membership.accountType);
    assertProviderAmount({ payment, plan, billingPeriod: effectiveBillingPeriod });
  }
  const mappedMembershipStatus = providerStatusToMembership(providerStatus, periodEnd);
  const actionMap = {
    authenticated: 'subscription_authenticated', activated: 'activation', charged: 'renewal',
    completed: 'subscription_completed', expired: 'expiration', updated: 'synchronization', pending: 'subscription_pending',
    halted: 'subscription_halted', paused: 'subscription_paused', resumed: 'resume', cancelled: 'cancellation'
  };
  const suffix = eventType.split('.')[1];
  const providerCancelAtEnd = providerBoolean(subscription.cancel_at_cycle_end, membership.cancelAtCycleEnd);
  const terminalProvider = ['cancelled', 'completed', 'expired'].includes(providerStatus);
  await safeMembershipUpdate(membership, {
    ...(pendingActivated ? {
      planKey: effectivePlanKey,
      planTier: effectivePlanKey,
      billingPeriod: effectiveBillingPeriod,
      amount: planPrice(findPlan(effectivePlanKey, membership.accountType), effectiveBillingPeriod),
      scheduledChange: { planKey: undefined, planId: undefined, billingPeriod: undefined, effectiveAt: null },
      'metadata.pendingPlanChange': null
    } : {}),
    membershipStatus: mappedMembershipStatus || membership.membershipStatus,
    subscriptionStatus: providerStatus === 'resumed' ? 'active' : providerStatus,
    autoRenew: terminalProvider ? false : !providerCancelAtEnd,
    cancelAtCycleEnd: providerCancelAtEnd,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    expiresAt: periodEnd,
    cancelledAt: providerStatus === 'cancelled' ? eventAt : membership.cancelledAt,
    endedAt: mappedMembershipStatus && mappedMembershipStatus !== 'active' ? eventAt : null,
    lastPaymentAt: payment ? (fromUnix(payment.created_at) || eventAt) : membership.lastPaymentAt,
    providerLastEventAt: eventAt,
    providerLastEventId: eventId,
    razorpay: {
      ...(membership.razorpay?.toObject?.() || membership.razorpay || {}),
      customerId: subscription.customer_id || membership.razorpay.customerId,
      subscriptionId: subscription.id,
      planId: subscription.plan_id || membership.razorpay.planId,
      paymentId: payment?.id || membership.razorpay.paymentId,
      orderId: payment?.order_id || membership.razorpay.orderId,
      invoiceId: payment?.invoice_id || membership.razorpay.invoiceId
    },
    providerSnapshot: provider.sanitizeProviderSnapshot(subscription)
  });
  if (payment?.id && payment.status === 'captured') {
    const plan = findPlan(effectivePlanKey, membership.accountType);
    await recordPayment({ membership, payment, orderId: payment.order_id, description: `${plan.name} recurring (${effectiveBillingPeriod})`, platform: membership.platform, billingPeriod: effectiveBillingPeriod, planKey: effectivePlanKey });
    await grantPeriodCredits(membership, `payment:${payment.id}:credits`);
  }
  await projectEntitlement(membership);
  await appendEvent({
    membership,
    action: actionMap[suffix] || 'synchronization',
    source: 'webhook',
    actor: systemActor('provider:razorpay'),
    previousState,
    timestamp: eventAt,
    dedupeKey: `webhook:${eventId}:membership`,
    metadata: { eventType }
  });
  if (['activated', 'charged', 'cancelled', 'paused', 'resumed', 'pending', 'halted', 'completed', 'expired'].includes(suffix)) {
    const terminal = ['completed', 'expired'].includes(suffix);
    const billingIssue = ['pending', 'halted'].includes(suffix);
    await notifyLifecycle(membership, {
      title: suffix === 'charged' ? 'Premium renewed' : terminal ? 'Premium expired' : billingIssue ? 'Premium payment needs attention' : suffix === 'cancelled' ? 'Premium subscription cancelled' : 'Premium subscription updated',
      message: suffix === 'charged' ? 'Your recurring premium payment was received.' : terminal ? 'Your premium subscription has ended.' : billingIssue ? `Billing status is ${providerStatus}; access remains available only through the paid period.` : `Subscription status: ${providerStatus}.`,
      action: suffix
    });
  }
  return { membership, ignored: false };
};

const applyRefundEvent = async ({ eventId, eventType, providerCreatedAt, refund }) => {
  const paymentId = refund?.payment_id;
  if (!paymentId) return { ignored: true, reason: 'payment_missing' };
  let transaction = await PaymentTransaction.findOne({ $or: [{ paymentId }, { providerPaymentId: paymentId }] });
  if (!transaction?.membership) return { ignored: false, retryable: true, reason: 'transaction_not_found' };
  const membership = await PremiumMembership.findById(transaction.membership);
  if (!membership) return { ignored: false, retryable: true, reason: 'membership_not_found' };
  const amount = Number(refund.amount || 0) / 100;
  const status = eventType === 'refund.failed' ? 'failed' : 'processed';
  const existingEntry = transaction.refundHistory.find((entry) => entry.refundId === refund.id);
  if (existingEntry?.status === 'pending') {
    const reservedAmount = Number(existingEntry.reservedAmount || 0);
    const increments = reservedAmount > 0 ? { refundReservedAmount: -reservedAmount } : {};
    if (status === 'processed') increments.refundedAmount = amount;
    await PaymentTransaction.updateOne(
      { _id: transaction._id, refundHistory: { $elemMatch: { refundId: refund.id, status: 'pending' } } },
      {
        $set: { 'refundHistory.$.status': status, 'refundHistory.$.reservedAmount': 0, providerRefundId: refund.id },
        $inc: increments
      }
    );
  } else if (existingEntry?.status === 'failed' && status === 'processed') {
    await PaymentTransaction.updateOne(
      { _id: transaction._id, refundHistory: { $elemMatch: { refundId: refund.id, status: 'failed' } } },
      { $set: { 'refundHistory.$.status': 'processed', providerRefundId: refund.id }, $inc: { refundedAmount: amount } }
    );
  } else if (!existingEntry) {
    const lockMatches = Boolean(
      transaction.refundLockReceipt &&
      (refund.receipt === transaction.refundLockReceipt || refund.notes?.receipt === transaction.refundLockReceipt)
    );
    const reservedAmount = lockMatches ? Number(transaction.refundLockAmount || amount) : 0;
    const update = {
      $push: { refundHistory: { refundId: refund.id, amount, status, reservedAmount: 0, reason: safeString(refund.notes?.reason, 1000) } },
      $set: {
        providerRefundId: refund.id,
        ...(lockMatches ? { refundLockToken: '', refundLockAt: null, refundLockAmount: 0, refundLockReceipt: '' } : {})
      }
    };
    update.$inc = {};
    if (status === 'processed') update.$inc.refundedAmount = amount;
    if (reservedAmount > 0) update.$inc.refundReservedAmount = -reservedAmount;
    if (Object.keys(update.$inc).length === 0) delete update.$inc;
    await PaymentTransaction.updateOne({ _id: transaction._id, 'refundHistory.refundId': { $ne: refund.id } }, update);
  }
  transaction = await PaymentTransaction.findById(transaction._id);
  const captured = Number(transaction.capturedAmount || transaction.amount);
  const hasPending = transaction.refundHistory.some((entry) => entry.status === 'pending');
  transaction.refundStatus = transaction.refundedAmount >= captured
    ? 'full'
    : (transaction.refundedAmount > 0 ? 'partial' : (hasPending ? 'pending' : 'failed'));
  if (transaction.refundStatus === 'full') transaction.status = 'refunded';
  transaction.providerRefundId = refund.id || transaction.providerRefundId;
  await transaction.save();
  const previousState = snapshotState(membership);
  const fundingDate = transaction.paidAt || transaction.createdAt;
  const newerFundingExists = Boolean(await PaymentTransaction.exists({
    membership: membership._id,
    _id: { $ne: transaction._id },
    status: 'completed',
    $or: [{ paidAt: { $gt: fundingDate } }, { paidAt: null, createdAt: { $gt: transaction.createdAt } }]
  }));
  if (transaction.refundStatus === 'full' && !newerFundingExists) {
    const now = providerCreatedAt || new Date();
    if (membership.razorpay?.subscriptionId && !TERMINAL_PROVIDER_STATUSES.has(membership.subscriptionStatus)) {
      await provider.cancelSubscription(membership.razorpay.subscriptionId, false);
    }
    await safeMembershipUpdate(membership, {
      membershipStatus: 'refunded',
      subscriptionStatus: membership.razorpay?.subscriptionId ? 'cancelled' : membership.subscriptionStatus,
      autoRenew: false,
      cancelAtCycleEnd: false,
      endedAt: now,
      expiresAt: membership.billingPeriod === 'lifetime' ? null : now,
      currentPeriodEnd: membership.billingPeriod === 'lifetime' ? null : now
    });
    await projectEntitlement(membership);
  }
  await appendEvent({ membership, action: 'refund', source: 'webhook', actor: systemActor('provider:razorpay'), previousState, amount, timestamp: providerCreatedAt, dedupeKey: `webhook:${eventId}:refund`, razorpay: { ...membership.razorpay, refundId: refund.id }, metadata: { status } });
  if (!existingEntry || existingEntry.status !== status) {
    await notifyLifecycle(membership, {
      title: status === 'processed' ? 'Premium refund processed' : 'Premium refund failed',
      message: status === 'processed' ? `Your ₹${amount.toFixed(2)} refund has been processed.` : 'Your premium refund could not be processed. Please contact support.',
      action: 'refund'
    });
  }
  return { membership, transaction, ignored: false };
};

const processWebhookPayload = async ({ eventId, eventType, payload, providerCreatedAt }) => {
  const subscription = payload?.subscription?.entity;
  const payment = payload?.payment?.entity;
  const refund = payload?.refund?.entity;
  if (eventType.startsWith('subscription.') && subscription) {
    return applySubscriptionEvent({ eventId, eventType, providerCreatedAt, subscription, payment });
  }
  if (['refund.processed', 'refund.failed'].includes(eventType) && refund) {
    return applyRefundEvent({ eventId, eventType, providerCreatedAt, refund });
  }
  if (eventType === 'payment.captured' && payment) {
    return activateOneTimeWebhookPayment({ payment, eventId });
  }
  if (eventType === 'payment.failed' && payment) {
    return recordFailedWebhookPayment({ payment, eventId });
  }
  return { ignored: true, reason: 'unsupported_event' };
};

const reconcileStaleRefundLocks = async (limit = 50) => {
  const staleAt = new Date(Date.now() - 10 * 60 * 1000);
  const transactions = await PaymentTransaction.find({
    refundLockToken: { $nin: ['', null] },
    refundLockAt: { $lte: staleAt },
    providerPaymentId: { $type: 'string', $gt: '' }
  }).sort({ refundLockAt: 1, _id: 1 }).limit(Math.max(1, Math.min(200, Number(limit) || 50)));
  let reconciled = 0;
  for (const transaction of transactions) {
    const response = await provider.fetchPaymentRefunds(transaction.providerPaymentId);
    const refunds = Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
    const match = refunds.find((refund) =>
      refund.receipt === transaction.refundLockReceipt ||
      refund.notes?.receipt === transaction.refundLockReceipt
    );
    if (!match) {
      await PaymentTransaction.updateOne(
        { _id: transaction._id, refundLockToken: transaction.refundLockToken },
        {
          $inc: { refundReservedAmount: -Number(transaction.refundLockAmount || 0) },
          $set: { refundLockToken: '', refundLockAt: null, refundLockAmount: 0, refundLockReceipt: '' }
        }
      );
      reconciled += 1;
      continue;
    }
    if (match.status === 'processed' || match.status === 'failed') {
      await applyRefundEvent({
        eventId: `refund-recovery:${match.id}`,
        eventType: match.status === 'processed' ? 'refund.processed' : 'refund.failed',
        providerCreatedAt: fromUnix(match.created_at) || new Date(),
        refund: { ...match, payment_id: match.payment_id || transaction.providerPaymentId }
      });
    } else {
      await PaymentTransaction.updateOne(
        { _id: transaction._id, refundLockToken: transaction.refundLockToken, 'refundHistory.refundId': { $ne: match.id } },
        {
          $push: {
            refundHistory: {
              refundId: match.id,
              amount: Number(match.amount || 0) / 100,
              status: 'pending',
              reservedAmount: Number(transaction.refundLockAmount || 0),
              reason: safeString(match.notes?.reason, 1000)
            }
          },
          $set: { refundStatus: 'pending', providerRefundId: match.id, refundLockToken: '', refundLockAt: null, refundLockAmount: 0, refundLockReceipt: '' }
        }
      );
    }
    reconciled += 1;
  }
  return reconciled;
};

const reconcilePendingRefunds = async (limit = 50, membershipId = null) => {
  const transactions = await PaymentTransaction.find({
    'refundHistory.status': 'pending',
    providerPaymentId: { $type: 'string', $gt: '' },
    ...(membershipId ? { membership: membershipId } : {})
  }).sort({ updatedAt: 1, _id: 1 }).limit(Math.max(1, Math.min(200, Number(limit) || 50)));
  let reconciled = 0;
  for (const transaction of transactions) {
    const response = await provider.fetchPaymentRefunds(transaction.providerPaymentId);
    const refunds = Array.isArray(response) ? response : (Array.isArray(response?.items) ? response.items : []);
    for (const pending of transaction.refundHistory.filter((entry) => entry.status === 'pending')) {
      const match = refunds.find((refund) => refund.id === pending.refundId);
      if (!match || !['processed', 'failed'].includes(match.status)) continue;
      await applyRefundEvent({
        eventId: `refund-poll:${match.id}:${match.status}`,
        eventType: match.status === 'processed' ? 'refund.processed' : 'refund.failed',
        providerCreatedAt: fromUnix(match.created_at) || new Date(),
        refund: { ...match, payment_id: match.payment_id || transaction.providerPaymentId }
      });
      reconciled += 1;
    }
  }
  return reconciled;
};

const reconcileMembership = async (membershipId, { actor = systemActor('system:reconciliation') } = {}) => {
  const membership = await getMembershipOrThrow(membershipId);
  const previousState = snapshotState(membership);
  let providerResult = null;
  if (membership.razorpay?.subscriptionId) {
    providerResult = await provider.fetchSubscription(membership.razorpay.subscriptionId);
    const currentPlanId = provider.getConfiguredPlanId(membership.planKey, membership.billingPeriod);
    if (membership.razorpay?.planId && membership.razorpay.planId !== currentPlanId) {
      throw fail('Provider subscription plan does not match membership', 409, 'SUBSCRIPTION_PLAN_MISMATCH');
    }
    const pending = membership.scheduledChange?.planKey ? membership.scheduledChange : membership.metadata?.pendingPlanChange;
    let effectivePlanKey = membership.planKey;
    let effectiveBillingPeriod = membership.billingPeriod;
    let pendingActivated = false;
    if (providerResult.plan_id !== currentPlanId) {
      if (!pending?.planKey || !pending?.billingPeriod) throw fail('Provider subscription plan does not match membership', 409, 'SUBSCRIPTION_PLAN_MISMATCH');
      const pendingPlanId = provider.getConfiguredPlanId(pending.planKey, pending.billingPeriod);
      if (providerResult.plan_id !== pendingPlanId || (pending.planId && pending.planId !== pendingPlanId)) {
        throw fail('Provider subscription plan does not match pending change', 409, 'SUBSCRIPTION_PLAN_MISMATCH');
      }
      effectivePlanKey = pending.planKey;
      effectiveBillingPeriod = pending.billingPeriod;
      pendingActivated = true;
    }
    const periodEnd = fromUnix(providerResult.current_end) || membership.expiresAt;
    const status = safeString(providerResult.status, 40).toLowerCase();
    const mapped = providerStatusToMembership(status, periodEnd);
    if (!['removed', 'refunded'].includes(membership.membershipStatus)) {
      const cancelAtCycleEnd = providerBoolean(providerResult.cancel_at_cycle_end, membership.cancelAtCycleEnd);
      const terminal = TERMINAL_PROVIDER_STATUSES.has(status);
      await safeMembershipUpdate(membership, {
        ...(pendingActivated ? {
          planKey: effectivePlanKey,
          planTier: effectivePlanKey,
          billingPeriod: effectiveBillingPeriod,
          amount: planPrice(findPlan(effectivePlanKey, membership.accountType), effectiveBillingPeriod),
          razorpay: { ...(membership.razorpay?.toObject?.() || membership.razorpay || {}), planId: providerResult.plan_id },
          scheduledChange: { planKey: undefined, planId: undefined, billingPeriod: undefined, effectiveAt: null },
          'metadata.pendingPlanChange': null
        } : {}),
        membershipStatus: mapped || membership.membershipStatus,
        subscriptionStatus: status || membership.subscriptionStatus,
        autoRenew: terminal ? false : !cancelAtCycleEnd,
        cancelAtCycleEnd,
        currentPeriodStart: fromUnix(providerResult.current_start) || membership.currentPeriodStart,
        currentPeriodEnd: periodEnd,
        expiresAt: periodEnd,
        providerSnapshot: provider.sanitizeProviderSnapshot(providerResult),
        'reconciliation.lastCheckedAt': new Date(),
        'reconciliation.error': ''
      });
    }
  } else {
    membership.reconciliation.lastCheckedAt = new Date();
    membership.reconciliation.error = '';
    await membership.save();
  }
  const entitled = await projectEntitlement(membership);
  await reconcilePendingRefunds(50, membership._id).catch(() => null);
  await appendEvent({ membership, action: 'synchronization', source: 'system', actor, previousState, metadata: { entitled, providerChecked: Boolean(providerResult) } });
  return membership;
};

const processLifecycleBatch = async ({ limit = 200, refreshProvider = false } = {}) => {
  const boundedLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
  const now = new Date();
  let expired = 0;
  let repaired = 0;
  const refundLocksReconciled = await reconcileStaleRefundLocks(Math.min(50, boundedLimit)).catch(() => 0);
  const pendingRefundsReconciled = await reconcilePendingRefunds(Math.min(50, boundedLimit)).catch(() => 0);
  for (let index = 0; index < boundedLimit; index += 1) {
    const claimToken = crypto.randomUUID();
    const membership = await PremiumMembership.findOneAndUpdate(
      {
        isCurrent: true,
        membershipStatus: 'active',
        expiresAt: { $ne: null, $lte: now },
        $and: [
          { $or: [
            { source: { $ne: 'razorpay_subscription' } },
            { autoRenew: false },
            { cancelAtCycleEnd: true },
            { subscriptionStatus: { $in: ['cancelled', 'completed', 'expired'] } }
          ] },
          { $or: [
            { 'reconciliation.claimedAt': null },
            { 'reconciliation.claimedAt': { $lte: new Date(Date.now() - 10 * 60 * 1000) } }
          ] }
        ]
      },
      { $set: { 'reconciliation.claimedAt': now, 'reconciliation.claimToken': claimToken } },
      { new: true, sort: { expiresAt: 1, _id: 1 } }
    );
    if (!membership) break;
    const previousState = snapshotState(membership);
    membership.membershipStatus = membership.cancelAtCycleEnd ? 'cancelled' : 'expired';
    membership.subscriptionStatus = membership.subscriptionStatus === 'not_applicable' ? 'not_applicable' : 'expired';
    membership.autoRenew = false;
    membership.endedAt = now;
    membership.reconciliation.claimedAt = null;
    membership.reconciliation.claimToken = '';
    membership.reconciliation.lastCheckedAt = now;
    membership.version = Number(membership.version || 0) + 1;
    await membership.save();
    await projectEntitlement(membership);
    await appendEvent({ membership, action: 'expiration', source: 'lifecycle_job', actor: systemActor('job:premium-lifecycle'), previousState, dedupeKey: `expiration:${membership._id}:${new Date(membership.expiresAt).toISOString()}` });
    await notifyLifecycle(membership, { title: 'Premium expired', message: 'Your premium access has expired.', action: 'expiration', source: 'lifecycle_job' });
    expired += 1;
  }

  const driftCandidates = await PremiumMembership.find({ isCurrent: true }).sort({ 'reconciliation.lastCheckedAt': 1, _id: 1 }).limit(boundedLimit).lean();
  for (const membership of driftCandidates) {
    const shouldBePremium = isEntitled(membership, now);
    const user = await User.findById(membership.user).select('isPremium membership').lean();
    if (user && (Boolean(user.isPremium) !== shouldBePremium || (shouldBePremium && user.membership?.tier !== membership.planKey))) {
      await projectEntitlement(membership);
      await PremiumMembership.updateOne({ _id: membership._id }, { $set: { 'reconciliation.lastDriftAt': now } });
      repaired += 1;
    }
    await PremiumMembership.updateOne({ _id: membership._id }, { $set: { 'reconciliation.lastCheckedAt': now } });
  }

  let providerRefreshed = 0;
  if (refreshProvider) {
    const due = await PremiumMembership.find({
      isCurrent: true,
      'razorpay.subscriptionId': { $type: 'string' },
      subscriptionStatus: { $nin: ['cancelled', 'completed', 'expired'] }
    }).select('_id').sort({ 'reconciliation.lastCheckedAt': 1, _id: 1 }).limit(Math.min(50, boundedLimit)).lean();
    for (const candidate of due) {
      const claimToken = crypto.randomUUID();
      const membership = await PremiumMembership.findOneAndUpdate(
        {
          _id: candidate._id,
          $or: [
            { 'reconciliation.claimedAt': null },
            { 'reconciliation.claimedAt': { $lte: new Date(Date.now() - 10 * 60 * 1000) } }
          ]
        },
        { $set: { 'reconciliation.claimedAt': now, 'reconciliation.claimToken': claimToken } },
        { new: true }
      );
      if (!membership) continue;
      try {
        await reconcileMembership(membership._id);
        providerRefreshed += 1;
      } catch (error) {
        await PremiumMembership.updateOne(
          { _id: membership._id, 'reconciliation.claimToken': claimToken },
          { $set: { 'reconciliation.error': safeString(error?.code || error?.message, 500), 'reconciliation.lastCheckedAt': now } }
        );
      } finally {
        await PremiumMembership.updateOne(
          { _id: membership._id, 'reconciliation.claimToken': claimToken },
          { $set: { 'reconciliation.claimedAt': null, 'reconciliation.claimToken': '' } }
        ).catch(() => null);
      }
    }
  }
  return { expired, repaired, providerRefreshed, refundLocksReconciled, pendingRefundsReconciled };
};

const listMemberships = async (query = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 25));
  const filter = { isCurrent: true };
  if (query.status) {
    const statuses = ['trial', 'active', 'expired', 'cancelled', 'refunded', 'removed'];
    if (!statuses.includes(query.status)) throw fail('status filter is invalid');
    filter.membershipStatus = query.status;
  }
  if (query.plan) filter.billingPeriod = normalizeBillingPeriod(query.plan);
  if (query.planKey) filter.planKey = safeString(query.planKey, 80);
  if (query.platform) {
    const platform = normalizePlatform(query.platform);
    if (platform === 'unknown' && query.platform !== 'unknown') throw fail('platform filter is invalid');
    filter.platform = platform;
  }
  if (query.accountType) {
    if (!['user', 'player', 'team', 'creator', 'admin', 'unknown'].includes(query.accountType)) throw fail('accountType filter is invalid');
    filter.accountType = ['user', 'player'].includes(query.accountType) ? { $in: ['player', 'creator'] } : query.accountType;
  }
  if (query.autoRenew !== undefined) {
    if (!['true', 'false'].includes(String(query.autoRenew))) throw fail('autoRenew filter must be true or false');
    filter.autoRenew = String(query.autoRenew) === 'true';
  }
  const search = safeString(query.search, 100);
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    const users = await User.find({ $or: [
      { username: pattern },
      { email: pattern },
      { phone: pattern },
      { phoneNumber: pattern },
      { 'profile.displayName': pattern },
      { 'profile.phone': pattern }
    ] }).select('_id').limit(500).lean();
    const searchConditions = [
      { user: { $in: users.map((user) => user._id) } },
      { 'razorpay.subscriptionId': pattern },
      { 'razorpay.paymentId': pattern },
      { 'razorpay.orderId': pattern }
    ];
    if (isObjectId(search)) searchConditions.push({ _id: search }, { user: search });
    filter.$or = searchConditions;
  }
  const sortFields = new Set(['createdAt', 'updatedAt', 'expiresAt', 'startedAt', 'amount', 'planKey', 'accountType', 'billingPeriod', 'membershipStatus', 'subscriptionStatus', 'autoRenew', 'platform']);
  const sort = sortFields.has(query.sort) ? query.sort : 'createdAt';
  const order = query.order === 'asc' ? 1 : -1;
  const [memberships, total] = await Promise.all([
    PremiumMembership.find(filter).populate('user', 'username email profile.displayName profile.avatar userType isPremium createdAt lastSeen').sort({ [sort]: order, _id: order }).skip((page - 1) * limit).limit(limit).lean(),
    PremiumMembership.countDocuments(filter)
  ]);
  return { memberships: memberships.map(serializeMembership), pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

const getDashboard = async () => {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const revenuePipeline = (since) => [
    { $match: { type: 'subscription', status: { $in: ['completed', 'refunded'] }, ...(since ? { createdAt: { $gte: since } } : {}) } },
    { $group: {
      _id: null,
      captured: { $sum: { $cond: [{ $gt: ['$capturedAmount', 0] }, '$capturedAmount', '$amount'] } },
      refunded: { $sum: { $ifNull: ['$refundedAmount', 0] } }
    } }
  ];
  const [total, active, expired, cancelled, autoRenewEnabled, autoRenewDisabled, purchasedToday, expiring7, expiring30, byTerm, revenueTodayRows, revenueMonthRows, revenueLifetimeRows] = await Promise.all([
    PremiumMembership.countDocuments({ isCurrent: true }),
    PremiumMembership.countDocuments({ isCurrent: true, membershipStatus: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }),
    PremiumMembership.countDocuments({ isCurrent: true, membershipStatus: 'expired' }),
    PremiumMembership.countDocuments({ isCurrent: true, $or: [{ membershipStatus: 'cancelled' }, { cancelAtCycleEnd: true }] }),
    PremiumMembership.countDocuments({ isCurrent: true, autoRenew: true }),
    PremiumMembership.countDocuments({ isCurrent: true, autoRenew: false }),
    PremiumMembership.countDocuments({ isCurrent: true, membershipStatus: 'active', startedAt: { $gte: startOfToday } }),
    PremiumMembership.countDocuments({ isCurrent: true, membershipStatus: 'active', expiresAt: { $gt: now, $lte: in7Days } }),
    PremiumMembership.countDocuments({ isCurrent: true, membershipStatus: 'active', expiresAt: { $gt: now, $lte: in30Days } }),
    PremiumMembership.aggregate([{ $match: { isCurrent: true } }, { $group: { _id: '$billingPeriod', count: { $sum: 1 } } }]),
    PaymentTransaction.aggregate(revenuePipeline(startOfToday)),
    PaymentTransaction.aggregate(revenuePipeline(startOfMonth)),
    PaymentTransaction.aggregate(revenuePipeline(null))
  ]);
  const net = (rows) => Math.max(0, Number(rows[0]?.captured || 0) - Number(rows[0]?.refunded || 0));
  return {
    totalMembers: total,
    activeMembers: active,
    expiredMemberships: expired,
    cancelledMemberships: cancelled,
    autoRenewEnabled,
    autoRenewDisabled,
    purchasedToday,
    expiringIn7Days: expiring7,
    expiringIn30Days: expiring30,
    revenueToday: net(revenueTodayRows),
    revenueThisMonth: net(revenueMonthRows),
    lifetimeRevenue: net(revenueLifetimeRows),
    // Compatibility aliases for early admin clients.
    total,
    active,
    expired,
    cancelled,
    autoRenew: autoRenewEnabled,
    expiringSoon: expiring30,
    byTerm: Object.fromEntries(byTerm.map((entry) => [entry._id, entry.count])),
    netRevenue: net(revenueLifetimeRows),
    totalPremiumUsers: total,
    activePremiumUsers: active,
    expiredPremiumUsers: expired,
    cancelledSubscriptions: cancelled,
    premiumPurchasedToday: purchasedToday,
    lifetimePremiumRevenue: net(revenueLifetimeRows),
    currency: 'INR'
  };
};

const getMembershipDetails = async (membershipId) => {
  if (!isObjectId(String(membershipId))) throw fail('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');
  const membership = await PremiumMembership.findById(membershipId).populate('user', 'username email profile.displayName profile.avatar userType isPremium isVerifiedHost isCreator creatorMonetizationStatus createdAt lastSeen notificationClients pushTokens.platform pushTokens.deviceName pushTokens.appVersion pushTokens.lastUsedAt').lean();
  if (!membership) throw fail('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');
  const reports = await Report.find({ targetType: 'user', targetId: membership.user?._id || membership.user })
    .select('reason details status adminAction createdAt reviewedAt')
    .sort({ createdAt: -1 })
    .limit(25)
    .lean();
  const devices = [
    ...((membership.user?.notificationClients || []).map((client, index) => ({
      id: `client-${index + 1}`,
      platform: client.platform || 'unknown',
      appVersion: client.appVersion || '',
      deviceName: '',
      lastSeenAt: client.lastSeenAt || null,
      notificationPermission: client.notificationPermission || 'unknown'
    }))),
    ...((membership.user?.pushTokens || []).map((token, index) => ({
      id: `push-device-${index + 1}`,
      platform: token.platform || 'unknown',
      appVersion: token.appVersion || '',
      deviceName: token.deviceName || '',
      lastSeenAt: token.lastUsedAt || null,
      notificationPermission: 'unknown'
    })))
  ];
  return {
    ...serializeMembership(membership),
    devices,
    reports: { total: reports.length, items: reports },
    loginHistory: { available: false, reason: 'Login history is not retained by the current authentication data model.' }
  };
};

const listPayments = async (membershipId, { page = 1, limit = 25 } = {}) => {
  if (!isObjectId(String(membershipId))) throw fail('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(limit) || 25));
  const [payments, total] = await Promise.all([
    PaymentTransaction.find({ membership: membershipId }).sort({ paidAt: -1, createdAt: -1 }).skip((currentPage - 1) * pageSize).limit(pageSize).lean(),
    PaymentTransaction.countDocuments({ membership: membershipId })
  ]);
  const serialized = payments.map((payment) => ({
    id: String(payment._id),
    type: payment.type,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    description: payment.description,
    provider: payment.provider,
    providerCustomerId: payment.providerCustomerId,
    providerSubscriptionId: payment.providerSubscriptionId,
    providerPaymentId: payment.providerPaymentId || payment.paymentId,
    providerOrderId: payment.providerOrderId || payment.orderId,
    providerInvoiceId: payment.providerInvoiceId,
    providerRefundId: payment.providerRefundId,
    platform: payment.platform,
    paymentMethod: payment.paymentMethod,
    gstAmount: payment.gstAmount,
    discountAmount: payment.discountAmount,
    couponCode: payment.couponCode,
    invoiceUrl: /^https:\/\//i.test(payment.invoiceUrl || '') ? payment.invoiceUrl : '',
    capturedAmount: payment.capturedAmount || payment.amount,
    refundedAmount: payment.refundedAmount,
    refundStatus: payment.refundStatus,
    refundHistory: (payment.refundHistory || []).map((refund) => ({ refundId: refund.refundId, amount: refund.amount, status: refund.status, reason: refund.reason, createdAt: refund.createdAt })),
    paidAt: payment.paidAt,
    createdAt: payment.createdAt
  }));
  return { payments: serialized, pagination: { page: currentPage, limit: pageSize, total, pages: Math.ceil(total / pageSize) } };
};

const listTimeline = async (membershipId, { page = 1, limit = 50 } = {}) => {
  if (!isObjectId(String(membershipId))) throw fail('Membership not found', 404, 'MEMBERSHIP_NOT_FOUND');
  const currentPage = Math.max(1, Number(page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(limit) || 50));
  const [events, total] = await Promise.all([
    PremiumMembershipEvent.find({ membership: membershipId }).sort({ timestamp: -1, _id: -1 }).skip((currentPage - 1) * pageSize).limit(pageSize).lean(),
    PremiumMembershipEvent.countDocuments({ membership: membershipId })
  ]);
  return { events, pagination: { page: currentPage, limit: pageSize, total, pages: Math.ceil(total / pageSize) } };
};

module.exports = {
  fail,
  actorFromRequestUser,
  systemActor,
  findPlan,
  normalizeBillingPeriod,
  planPrice,
  deriveExpiry,
  validateMembershipDates,
  serializeMembership,
  appendEvent,
  claimMutation,
  completeMutation,
  failMutation,
  projectEntitlement,
  verifyOneTimePurchase,
  activateOneTimeWebhookPayment,
  recordFailedWebhookPayment,
  createRecurringSubscription,
  verifyRecurringSubscription,
  grantMembership,
  extendMembership,
  changePlan,
  cancelMembership,
  removeMembership,
  resumeMembership,
  setAutoRenew,
  refundMembershipPayment,
  processWebhookPayload,
  reconcileStaleRefundLocks,
  reconcilePendingRefunds,
  reconcileMembership,
  processLifecycleBatch,
  currentForUser,
  ensureCanonicalForUser,
  cancelCurrentForUser,
  listMemberships,
  getDashboard,
  getMembershipDetails,
  listPayments,
  listTimeline,
  notifyLifecycle,
  providerStatusToMembership,
  providerBoolean
};
