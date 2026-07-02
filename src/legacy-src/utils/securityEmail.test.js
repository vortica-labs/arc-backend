const assert = require('node:assert/strict');

const queued = [];
const jobQueuePath = require.resolve('./jobQueue');
require.cache[jobQueuePath] = {
  id: jobQueuePath,
  filename: jobQueuePath,
  loaded: true,
  exports: {
    enqueueEmail: async (...args) => queued.push(args)
  },
  children: [],
  paths: []
};

const { EMAIL_INTENTS } = require('./notificationChannelPolicy');
const {
  PASSWORD_SECURITY_EVENTS,
  buildPasswordSecurityEmail,
  enqueuePasswordSecurityEmail,
  securitySettingsUrl
} = require('./securityEmail');

const previousSmtpUser = process.env.SMTP_USER;
const previousSmtpPass = process.env.SMTP_PASS;

(async () => {
  for (const eventType of ['password_reset', 'password_changed', 'admin_password_reset']) {
    const email = buildPasswordSecurityEmail(eventType);
    assert.equal(email.eventType, eventType);
    assert.ok(email.subject.includes('password'));
    assert.ok(email.text.includes('contact ARC support immediately'));
    assert.equal(/otp|one[- ]time|new password|temporary password/i.test(`${email.subject} ${email.text}`), false);
  }

  assert.throws(
    () => buildPasswordSecurityEmail('login_like'),
    (error) => error?.code === 'UNSUPPORTED_SECURITY_EMAIL_EVENT'
  );

  const previousClientUrl = process.env.CLIENT_URL;
  process.env.CLIENT_URL = 'https://arc.example.test/app/';
  assert.equal(securitySettingsUrl(), 'https://arc.example.test/app/settings/security');
  process.env.CLIENT_URL = 'javascript:alert(1)';
  assert.equal(securitySettingsUrl(), '');

  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  assert.deepEqual(
    await enqueuePasswordSecurityEmail({ to: 'member@example.test', eventType: 'password_changed' }),
    { queued: false, reason: 'email_not_configured' }
  );
  assert.equal(queued.length, 0);

  process.env.SMTP_USER = 'smtp-user@example.test';
  process.env.SMTP_PASS = 'smtp-password';
  await enqueuePasswordSecurityEmail({ to: 'member@example.test', eventType: 'password_changed' });
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], [
    'member@example.test',
    PASSWORD_SECURITY_EVENTS.password_changed.subject,
    PASSWORD_SECURITY_EVENTS.password_changed.text,
    '',
    { intent: EMAIL_INTENTS.SECURITY, eventType: 'password_changed' }
  ]);

  const missing = await enqueuePasswordSecurityEmail({ to: '', eventType: 'password_reset' });
  assert.deepEqual(missing, { queued: false, reason: 'missing_recipient' });
  assert.equal(queued.length, 1);

  if (previousClientUrl === undefined) delete process.env.CLIENT_URL;
  else process.env.CLIENT_URL = previousClientUrl;

  if (previousSmtpUser === undefined) delete process.env.SMTP_USER;
  else process.env.SMTP_USER = previousSmtpUser;
  if (previousSmtpPass === undefined) delete process.env.SMTP_PASS;
  else process.env.SMTP_PASS = previousSmtpPass;

  console.log('Security email tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
