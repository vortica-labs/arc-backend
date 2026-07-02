const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EMAIL_INTENTS, evaluateEmailPolicy } = require('./notificationChannelPolicy');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const auth = read('controllers/authController.js');
const admin = read('controllers/adminController.js');
const recruitment = read('controllers/recruitmentController.js');
const premium = read('services/premiumMembershipService.js');
const securityEmail = read('utils/securityEmail.js');

for (const eventType of ['password_reset', 'password_changed']) {
  assert(auth.includes(`eventType: '${eventType}'`), `${eventType} must enqueue a confirmation after a successful mutation`);
}
assert(admin.includes("eventType: 'admin_password_reset'"));
assert(securityEmail.includes('intent: EMAIL_INTENTS.SECURITY'));
assert(!securityEmail.toLowerCase().includes('temporary password'));
assert(!securityEmail.toLowerCase().includes('one-time'));

assert(!recruitment.includes('enqueueEmail('), 'recruitment activity must not enqueue email');
assert(!recruitment.includes('EMAIL_INTENTS.'), 'recruitment activity must remain push + in-app only');

assert(premium.includes('intent: EMAIL_INTENTS.PREMIUM_LIFECYCLE'));
assert(premium.includes('eventType: action'));
for (const eventType of [
  'activation',
  'renewal',
  'plan_change',
  'cancellation',
  'access_removal',
  'resume',
  'auto_renew_change',
  'refund',
  'activated',
  'charged',
  'cancelled',
  'paused',
  'resumed',
  'pending',
  'halted',
  'completed',
  'expired',
  'expiration'
]) {
  assert(premium.includes(`'${eventType}'`), `missing premium lifecycle producer event: ${eventType}`);
  assert.equal(
    evaluateEmailPolicy({ intent: EMAIL_INTENTS.PREMIUM_LIFECYCLE, eventType }).allowed,
    true,
    `premium lifecycle event is not registered: ${eventType}`
  );
}

const requiredAdminIntents = [
  'EMAIL_INTENTS.ACCOUNT_LIFECYCLE',
  'EMAIL_INTENTS.PAYMENT_TRANSACTIONAL'
];
for (const intent of requiredAdminIntents) {
  assert(admin.includes(intent), `admin critical outcomes must opt into ${intent}`);
}

for (const [intent, eventType] of [
  [EMAIL_INTENTS.ACCOUNT_LIFECYCLE, 'account_restored'],
  [EMAIL_INTENTS.ACCOUNT_LIFECYCLE, 'account_suspended'],
  [EMAIL_INTENTS.ACCOUNT_LIFECYCLE, 'report_account_suspended'],
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL, 'payout_held'],
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL, 'withdrawal_approved'],
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL, 'withdrawal_rejected'],
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL, 'creator_payout_approved'],
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL, 'creator_payout_processing'],
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL, 'creator_payout_paid'],
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL, 'creator_payout_rejected'],
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL, 'creator_payout_cancelled']
]) {
  assert.equal(evaluateEmailPolicy({ intent, eventType }).allowed, true, `admin transactional event is not registered: ${eventType}`);
}

for (const disabledIntent of [
  'EMAIL_INTENTS.CREATOR_STATUS',
  'EMAIL_INTENTS.HOST_STATUS',
  'EMAIL_INTENTS.RECRUITMENT_STATUS',
  'EMAIL_INTENTS.TOURNAMENT_REGISTRATION_PRIZE'
]) {
  assert(!admin.includes(disabledIntent), `${disabledIntent} must not be used by admin activity notifications`);
}
assert(!admin.includes("notificationEmail(EMAIL_INTENTS.PLATFORM_CRITICAL, 'content_report_warning')"));

for (const eventType of [
  'account_restored',
  'account_suspended',
  'content_report_warning',
  'report_account_suspended',
  'monetization_approved',
  'monetization_rejected',
  'monetization_revoked',
  'monetization_granted',
  'monetization_suspended',
  'monetization_reactivated',
  'withdrawal_approved',
  'withdrawal_rejected',
  'host_verification_approved',
  'host_verification_rejected',
  'host_verification_revoked',
  'payout_held'
]) {
  assert(admin.includes(eventType), `missing typed critical admin event: ${eventType}`);
}

assert(admin.includes("typeof isActive !== 'boolean'"));
assert(admin.includes('await invalidateUserCache(userId)'));

console.log('Transactional email call-site contract tests passed');
