const { enqueueEmail } = require('./jobQueue');
const { EMAIL_INTENTS } = require('./notificationChannelPolicy');

const PASSWORD_SECURITY_EVENTS = Object.freeze({
  password_reset: Object.freeze({
    subject: 'Your ARC password was reset',
    text: 'Your ARC account password was reset successfully. If you did not make this change, contact ARC support immediately.'
  }),
  password_changed: Object.freeze({
    subject: 'Your ARC password was changed',
    text: 'Your ARC account password was changed successfully. If you did not make this change, contact ARC support immediately.'
  }),
  admin_password_reset: Object.freeze({
    subject: 'Your ARC password was reset by an administrator',
    text: 'An ARC administrator reset your account password. If you did not expect this change, contact ARC support immediately.'
  })
});

const securitySettingsUrl = () => {
  const configured = String(process.env.CLIENT_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return '';
  try {
    const parsed = new URL(configured);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return `${parsed.toString().replace(/\/+$/, '')}/settings/security`;
  } catch {
    return '';
  }
};

const buildPasswordSecurityEmail = (eventType) => {
  const template = PASSWORD_SECURITY_EVENTS[eventType];
  if (!template) {
    const error = new Error('Unsupported password security email event');
    error.code = 'UNSUPPORTED_SECURITY_EMAIL_EVENT';
    throw error;
  }
  return { ...template, eventType };
};

const enqueuePasswordSecurityEmail = async ({ to, eventType }) => {
  if (!to) return { queued: false, reason: 'missing_recipient' };
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { queued: false, reason: 'email_not_configured' };
  }
  const template = buildPasswordSecurityEmail(eventType);
  await enqueueEmail(
    to,
    template.subject,
    template.text,
    securitySettingsUrl(),
    { intent: EMAIL_INTENTS.SECURITY, eventType }
  );
  return { queued: true };
};

module.exports = {
  PASSWORD_SECURITY_EVENTS,
  buildPasswordSecurityEmail,
  enqueuePasswordSecurityEmail,
  securitySettingsUrl
};
