const User = require('../models/User');
const PremiumMembership = require('../models/PremiumMembership');
const service = require('../services/premiumMembershipService');

const respondError = (res, error) => res.status(Number(error?.statusCode) || 500).json({
  success: false,
  code: error?.code || 'PREMIUM_MEMBERSHIP_ERROR',
  message: Number(error?.statusCode) && Number(error.statusCode) < 500
    ? error.message
    : 'Premium membership operation failed',
  correlationId: res.locals?.auditCorrelationId || null,
  providerStatus: error?.providerStatus || undefined,
  localStatus: error?.localStatus || undefined
});

const actor = (req, res) => service.actorFromRequestUser(req.user, 'admin', {
  ip: String(req.ip || req.headers?.['x-forwarded-for'] || ''),
  userAgent: req.get?.('user-agent') || '',
  correlationId: res.locals?.auditCorrelationId || ''
});
const idempotencyKey = (req) => String(req.get?.('Idempotency-Key') || '').trim();

const executeMutation = async (req, res, operation, payload, callback) => {
  let claim;
  let businessCompleted = false;
  try {
    const admin = actor(req, res);
    const result = await service.claimMutation({
      actorKey: admin.actorKey,
      operation,
      idempotencyKey: idempotencyKey(req),
      payload
    });
    if (result.replay) {
      return res.status(200).json({ success: true, idempotentReplay: true, correlationId: res.locals?.auditCorrelationId || null, data: result.result });
    }
    claim = result.claim;
    const value = await callback(admin);
    businessCompleted = true;
    const serialized = value?.membership
      ? { ...value, membership: service.serializeMembership(value.membership) }
      : service.serializeMembership(value);
    await service.completeMutation(claim, value?.membership || value, serialized);
    res.locals.auditAfter = serialized;
    return res.status(200).json({ success: true, idempotentReplay: false, correlationId: res.locals?.auditCorrelationId || null, data: serialized });
  } catch (error) {
    if (!businessCompleted) await service.failMutation(claim, error).catch(() => null);
    if (businessCompleted) {
      return res.status(503).json({ success: false, code: 'IDEMPOTENCY_OUTCOME_PERSIST_FAILED', message: 'Operation completed but its idempotency outcome requires reconciliation', operationCompleted: true, correlationId: res.locals?.auditCorrelationId || null, providerStatus: error?.providerStatus, localStatus: 'reconciliation_required' });
    }
    return respondError(res, error);
  }
};

const getDashboard = async (_req, res) => {
  try {
    return res.json({ success: true, data: await service.getDashboard() });
  } catch (error) { return respondError(res, error); }
};

const listMemberships = async (req, res) => {
  try {
    return res.json({ success: true, data: await service.listMemberships(req.query) });
  } catch (error) { return respondError(res, error); }
};

const eligibleUsers = async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 100) : '';
    if (search.length < 2) return res.status(400).json({ success: false, message: 'search must contain at least 2 characters' });
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const identityConditions = [
      { username: new RegExp(escaped, 'i') },
      { email: new RegExp(escaped, 'i') },
      { 'profile.displayName': new RegExp(escaped, 'i') }
    ];
    if (/^[a-f\d]{24}$/i.test(search)) identityConditions.push({ _id: search });
    const candidates = await User.find({
      userType: { $ne: 'admin' },
      $or: identityConditions
    }).select('username email profile.displayName profile.avatar userType').sort({ username: 1, _id: 1 }).limit(75).lean();
    const activeUserIds = new Set((await PremiumMembership.distinct('user', {
      user: { $in: candidates.map((user) => user._id) },
      isCurrent: true,
      membershipStatus: { $in: ['trial', 'active'] },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    })).map(String));
    const users = candidates.filter((user) => !activeUserIds.has(String(user._id))).slice(0, 25);
    return res.json({ success: true, data: users.map((user) => ({
      id: String(user._id),
      displayName: user.profile?.displayName || user.username,
      username: user.username,
      email: user.email,
      accountType: user.userType,
      avatar: user.profile?.avatar || ''
    })) });
  } catch (error) { return respondError(res, error); }
};

const getMembership = async (req, res) => {
  try { return res.json({ success: true, data: await service.getMembershipDetails(req.params.id) }); }
  catch (error) { return respondError(res, error); }
};
const getPayments = async (req, res) => {
  try { return res.json({ success: true, data: await service.listPayments(req.params.id, req.query) }); }
  catch (error) { return respondError(res, error); }
};
const getTimeline = async (req, res) => {
  try { return res.json({ success: true, data: await service.listTimeline(req.params.id, req.query) }); }
  catch (error) { return respondError(res, error); }
};

const grant = (req, res) => executeMutation(req, res, 'grant', req.body, (admin) => service.grantMembership({
  userId: req.body?.userId,
  planKey: req.body?.planKey || req.body?.tier,
  billingPeriod: req.body?.billingPeriod || req.body?.term,
  startAt: req.body?.startAt || req.body?.startDate,
  expiresAt: req.body?.expiresAt,
  reason: req.body?.reason,
  platform: 'admin',
  actor: admin
}));
const extend = (req, res) => executeMutation(req, res, 'extend', { id: req.params.id, ...req.body }, (admin) => service.extendMembership({ membershipId: req.params.id, ...req.body, actor: admin }));
const changePlan = (req, res) => executeMutation(req, res, 'change-plan', { id: req.params.id, ...req.body }, (admin) => service.changePlan({ membershipId: req.params.id, ...req.body, actor: admin }));
const cancel = (req, res) => executeMutation(req, res, 'cancel', { id: req.params.id, ...req.body }, (admin) => service.cancelMembership({ membershipId: req.params.id, mode: req.body?.mode, reason: req.body?.reason, actor: admin }));
const remove = (req, res) => executeMutation(req, res, 'remove', { id: req.params.id, ...req.body }, (admin) => service.removeMembership({ membershipId: req.params.id, reason: req.body?.reason, actor: admin }));
const resume = (req, res) => executeMutation(req, res, 'resume', { id: req.params.id, ...req.body }, (admin) => service.resumeMembership({ membershipId: req.params.id, reason: req.body?.reason, actor: admin }));
const autoRenew = (req, res) => executeMutation(req, res, 'auto-renew', { id: req.params.id, ...req.body }, (admin) => service.setAutoRenew({ membershipId: req.params.id, enabled: req.body?.enabled, reason: req.body?.reason, actor: admin }));
const refund = (req, res) => executeMutation(req, res, 'refund', { id: req.params.id, ...req.body }, (admin) => service.refundMembershipPayment({ membershipId: req.params.id, paymentTransactionId: req.body?.paymentTransactionId, amount: req.body?.amount, reason: req.body?.reason, actor: admin }));
const reconcile = (req, res) => executeMutation(req, res, 'reconcile', { id: req.params.id }, (admin) => service.reconcileMembership(req.params.id, { actor: admin }));

const legacyGrant = (req, res) => {
  const days = Math.max(1, Math.min(3650, Number.parseInt(req.body?.days, 10) || 30));
  const startAt = new Date();
  const expiresAt = new Date(startAt.getTime() + days * 24 * 60 * 60 * 1000);
  const payload = { userId: req.params.userId, tier: req.body?.tier || 'player_pro', days, reason: req.body?.reason };
  return executeMutation(req, res, 'legacy-grant', payload, (admin) => service.grantMembership({
    userId: req.params.userId,
    planKey: req.body?.tier || 'player_pro',
    billingPeriod: req.body?.billingPeriod || 'monthly',
    startAt,
    expiresAt,
    reason: req.body?.reason || 'Granted from legacy admin user action',
    platform: 'admin',
    actor: admin
  }));
};

const legacyRemove = (req, res) => executeMutation(
  req,
  res,
  'legacy-remove',
  { userId: req.params.userId, reason: req.body?.reason },
  async (admin) => {
    const membership = await service.ensureCanonicalForUser(req.params.userId);
    return service.removeMembership({ membershipId: membership._id, reason: req.body?.reason || 'Removed from legacy admin user action', actor: admin });
  }
);

module.exports = {
  getDashboard,
  listMemberships,
  eligibleUsers,
  getMembership,
  getPayments,
  getTimeline,
  grant,
  extend,
  changePlan,
  cancel,
  remove,
  resume,
  autoRenew,
  refund,
  reconcile,
  legacyGrant,
  legacyRemove
};
