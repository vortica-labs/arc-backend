const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const deliveries = [];
const nodemailerPath = require.resolve('nodemailer');
require.cache[nodemailerPath] = {
  id: nodemailerPath,
  filename: nodemailerPath,
  loaded: true,
  exports: {
    createTransport: () => ({
      sendMail: async (payload) => {
        deliveries.push(payload);
        return { messageId: `email-branding-${deliveries.length}` };
      }
    })
  },
  children: [],
  paths: []
};

const previousEnvironment = {
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  SMTP_FROM: process.env.SMTP_FROM
};

process.env.SMTP_USER = 'smtp-user@example.test';
process.env.SMTP_PASS = 'smtp-password';
// Production may retain an old display label. Delivery must still expose the
// canonical Squadhunt brand while preserving the configured mailbox.
process.env.SMTP_FROM = 'ARC <legacy-mailbox@example.test>';

const {
  resolveEmailFrom,
  sendNotificationEmail,
  sendOTPEmail
} = require('./email');
const { EMAIL_INTENTS } = require('./notificationChannelPolicy');

const assertSquadhuntDelivery = (delivery) => {
  assert.equal(delivery.from, 'Squadhunt <legacy-mailbox@example.test>');
  assert.match(delivery.subject, /Squadhunt/i);
  assert.match(delivery.text, /Squadhunt/i);
  assert.match(delivery.html, /Squadhunt/i);
  assert.equal(/\bARC\b/i.test(`${delivery.from}\n${delivery.subject}\n${delivery.text}\n${delivery.html}`), false);
};

(async () => {
  assert.equal(resolveEmailFrom(), 'Squadhunt <legacy-mailbox@example.test>');

  for (const purpose of ['login', 'register', 'forgot_password']) {
    const result = await sendOTPEmail('member@example.test', '123456', purpose);
    assert.equal(result.sent, true);
  }

  const notificationResult = await sendNotificationEmail(
    'member@example.test',
    'Password updated',
    'Your password was updated.',
    'https://squadhunt.in/settings/security',
    {
      intent: EMAIL_INTENTS.SECURITY,
      eventType: 'password_changed',
      templateKey: 'security_password_changed',
      triggerSource: 'email-branding-test'
    }
  );
  assert.equal(notificationResult.sent, true);
  assert.equal(deliveries.length, 4);
  deliveries.forEach(assertSquadhuntDelivery);

  const notificationDelivery = deliveries.at(-1);
  assert.match(notificationDelivery.text, /View in Squadhunt/);
  assert.match(notificationDelivery.html, />View in Squadhunt</);
  assert.match(notificationDelivery.text, /— Squadhunt/);
  assert.match(notificationDelivery.html, /— Squadhunt/);

  // These are the only hand-authored email templates. Premium, payment,
  // account, legal and critical notifications all use sendNotificationEmail.
  for (const relativePath of ['email.js', 'securityEmail.js']) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    assert.equal(
      /(?:['"`])[^'"`\r\n]*\bARC\b[^'"`\r\n]*(?:['"`])/i.test(source),
      false,
      `${relativePath} contains a legacy ARC-branded email literal`
    );
  }

  const adminSource = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'adminController.js'), 'utf8');
  assert.equal(/Your ARC account|Contact ARC support/i.test(adminSource), false);

  console.log('Email branding tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
