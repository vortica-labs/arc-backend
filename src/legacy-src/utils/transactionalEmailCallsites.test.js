const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

assert(recruitment.includes('intent: EMAIL_INTENTS.RECRUITMENT_STATUS'));
assert(recruitment.includes("notificationType: 'recruitment'"));
assert(!recruitment.includes('sendMail({'), 'recruitment decisions must use the typed queue rather than raw HTML transport');

assert(premium.includes('intent: EMAIL_INTENTS.PREMIUM_LIFECYCLE'));
assert(premium.includes('eventType: action'));

const requiredAdminIntents = [
  'EMAIL_INTENTS.ACCOUNT_LIFECYCLE',
  'EMAIL_INTENTS.PLATFORM_CRITICAL',
  'EMAIL_INTENTS.CREATOR_STATUS',
  'EMAIL_INTENTS.HOST_STATUS',
  'EMAIL_INTENTS.PAYMENT_TRANSACTIONAL'
];
for (const intent of requiredAdminIntents) {
  assert(admin.includes(intent), `admin critical outcomes must opt into ${intent}`);
}

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
