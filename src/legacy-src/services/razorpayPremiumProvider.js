const crypto = require('crypto');
const Razorpay = require('razorpay');

let client;

const providerError = (message, code = 'PAYMENT_PROVIDER_ERROR', statusCode = 502) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const safeProviderId = (value, label, prefixes = []) => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 200 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw providerError(`${label} is invalid`, 'INVALID_PROVIDER_ID', 400);
  }
  if (prefixes.length && !prefixes.some((prefix) => id.startsWith(prefix))) {
    throw providerError(`${label} is invalid`, 'INVALID_PROVIDER_ID', 400);
  }
  return id;
};

const getClient = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw providerError('Razorpay credentials are not configured', 'PAYMENT_GATEWAY_NOT_CONFIGURED', 503);
  }
  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
  }
  return client;
};

const timingSafeHexEqual = (expectedHex, suppliedHex) => {
  if (typeof expectedHex !== 'string' || typeof suppliedHex !== 'string') return false;
  if (!/^[a-f\d]{64}$/i.test(expectedHex) || !/^[a-f\d]{64}$/i.test(suppliedHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const supplied = Buffer.from(suppliedHex, 'hex');
  return expected.length > 0 && expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
};

const hmac = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('hex');

const verifyOrderSignature = ({ orderId, paymentId, signature }) => {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    throw providerError('Razorpay credentials are not configured', 'PAYMENT_GATEWAY_NOT_CONFIGURED', 503);
  }
  const order = safeProviderId(orderId, 'Razorpay order ID', ['order_']);
  const payment = safeProviderId(paymentId, 'Razorpay payment ID', ['pay_']);
  return timingSafeHexEqual(hmac(`${order}|${payment}`, process.env.RAZORPAY_KEY_SECRET), signature);
};

const verifySubscriptionSignature = ({ subscriptionId, paymentId, signature }) => {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    throw providerError('Razorpay credentials are not configured', 'PAYMENT_GATEWAY_NOT_CONFIGURED', 503);
  }
  const subscription = safeProviderId(subscriptionId, 'Razorpay subscription ID', ['sub_']);
  const payment = safeProviderId(paymentId, 'Razorpay payment ID', ['pay_']);
  // Razorpay subscription checkout signs payment_id|subscription_id.
  return timingSafeHexEqual(hmac(`${payment}|${subscription}`, process.env.RAZORPAY_KEY_SECRET), signature);
};

const verifyWebhookSignature = (rawBody, signature) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw providerError('Razorpay webhook secret is not configured', 'WEBHOOK_NOT_CONFIGURED', 503);
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) return false;
  return timingSafeHexEqual(hmac(rawBody, secret), signature);
};

const parsePlanMap = () => {
  let configured = {};
  const raw = process.env.RAZORPAY_PREMIUM_PLAN_IDS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) configured = parsed;
    } catch {
      throw providerError('Razorpay premium plan mapping is invalid JSON', 'PAYMENT_PLAN_MAPPING_INVALID', 503);
    }
  }
  return configured;
};

const getConfiguredPlanId = (planKey, billingPeriod) => {
  const planMap = parsePlanMap();
  const compound = `${planKey}:${billingPeriod}`;
  const nested = planMap?.[planKey]?.[billingPeriod];
  const flat = planMap?.[compound];
  const envKey = `RAZORPAY_PLAN_${String(planKey).toUpperCase()}_${String(billingPeriod).toUpperCase()}`;
  const value = nested || flat || process.env[envKey];
  if (!value) {
    throw providerError(
      `Recurring billing is not configured for ${planKey} ${billingPeriod}`,
      'SUBSCRIPTION_PLAN_NOT_CONFIGURED',
      503
    );
  }
  return safeProviderId(value, 'Razorpay plan ID', ['plan_']);
};

const subscriptionTotalCount = (billingPeriod) => {
  const configured = Number(process.env.PREMIUM_SUBSCRIPTION_YEARS || 10);
  const years = Number.isFinite(configured) ? Math.max(1, Math.min(10, Math.floor(configured))) : 10;
  if (billingPeriod === 'monthly') return years * 12;
  if (billingPeriod === 'quarterly') return years * 4;
  if (billingPeriod === 'yearly') return years;
  throw providerError('Lifetime plans cannot use recurring billing', 'INVALID_BILLING_PERIOD', 400);
};

const createSubscription = async ({ planKey, billingPeriod, userId, platform, correlationId }) => {
  const planId = getConfiguredPlanId(planKey, billingPeriod);
  const subscription = await getClient().subscriptions.create({
    plan_id: planId,
    total_count: subscriptionTotalCount(billingPeriod),
    quantity: 1,
    customer_notify: 1,
    notes: { userId: String(userId), planKey, billingPeriod, platform: platform || 'unknown', correlationId: String(correlationId || '') }
  });
  return subscription;
};

const fetchPayment = (paymentId) => getClient().payments.fetch(
  safeProviderId(paymentId, 'Razorpay payment ID', ['pay_'])
);
const fetchOrder = (orderId) => getClient().orders.fetch(
  safeProviderId(orderId, 'Razorpay order ID', ['order_'])
);
const fetchSubscription = (subscriptionId) => getClient().subscriptions.fetch(
  safeProviderId(subscriptionId, 'Razorpay subscription ID', ['sub_'])
);
const cancelSubscription = (subscriptionId, cancelAtCycleEnd) => getClient().subscriptions.cancel(
  safeProviderId(subscriptionId, 'Razorpay subscription ID', ['sub_']),
  Boolean(cancelAtCycleEnd)
);
const pauseSubscription = (subscriptionId) => getClient().subscriptions.pause(
  safeProviderId(subscriptionId, 'Razorpay subscription ID', ['sub_']),
  { pause_at: 'now' }
);
const resumeSubscription = (subscriptionId) => getClient().subscriptions.resume(
  safeProviderId(subscriptionId, 'Razorpay subscription ID', ['sub_']),
  { resume_at: 'now' }
);
const cancelScheduledChanges = (subscriptionId) => {
  const subscriptions = getClient().subscriptions;
  if (typeof subscriptions.cancelScheduledChanges !== 'function') {
    throw providerError(
      'The installed Razorpay SDK does not support cancelling scheduled subscription changes',
      'PROVIDER_OPERATION_UNSUPPORTED',
      501
    );
  }
  return subscriptions.cancelScheduledChanges(
    safeProviderId(subscriptionId, 'Razorpay subscription ID', ['sub_'])
  );
};
const updateSubscription = (subscriptionId, { planId, scheduleChangeAt = 'now' }) => {
  const subscriptions = getClient().subscriptions;
  if (typeof subscriptions.update !== 'function') {
    throw providerError('The installed Razorpay SDK does not support subscription updates', 'PROVIDER_OPERATION_UNSUPPORTED', 501);
  }
  if (!['now', 'cycle_end'].includes(scheduleChangeAt)) {
    throw providerError('Subscription plan change timing is invalid', 'INVALID_SCHEDULE_CHANGE_AT', 400);
  }
  return subscriptions.update(
    safeProviderId(subscriptionId, 'Razorpay subscription ID', ['sub_']),
    { plan_id: safeProviderId(planId, 'Razorpay plan ID', ['plan_']), schedule_change_at: scheduleChangeAt }
  );
};
const refundPayment = (paymentId, { amount, notes, receipt }) => getClient().payments.refund(
  safeProviderId(paymentId, 'Razorpay payment ID', ['pay_']),
  { amount, notes, receipt }
);
const fetchPaymentRefunds = (paymentId) => {
  const payments = getClient().payments;
  if (typeof payments.fetchMultipleRefund !== 'function') {
    throw providerError('The installed Razorpay SDK does not support refund reconciliation', 'PROVIDER_OPERATION_UNSUPPORTED', 501);
  }
  return payments.fetchMultipleRefund(safeProviderId(paymentId, 'Razorpay payment ID', ['pay_']));
};

const sanitizeProviderSnapshot = (value, depth = 0) => {
  if (depth > 5) return '[TRUNCATED]';
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeProviderSnapshot(entry, depth + 1));
  if (typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 2000) : value;
  return Object.entries(value).reduce((output, [key, nested]) => {
    if (/secret|signature|token|card|vpa|email|contact|authorization|cookie/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = sanitizeProviderSnapshot(nested, depth + 1);
    }
    return output;
  }, {});
};

module.exports = {
  providerError,
  getClient,
  getConfiguredPlanId,
  verifyOrderSignature,
  verifySubscriptionSignature,
  verifyWebhookSignature,
  timingSafeHexEqual,
  createSubscription,
  fetchPayment,
  fetchOrder,
  fetchSubscription,
  cancelSubscription,
  pauseSubscription,
  resumeSubscription,
  cancelScheduledChanges,
  updateSubscription,
  refundPayment,
  fetchPaymentRefunds,
  sanitizeProviderSnapshot
};
