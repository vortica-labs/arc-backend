const nodemailer = require('nodemailer');
const log = require('./logger');
const { EMAIL_INTENTS, evaluateEmailPolicy } = require('./notificationChannelPolicy');
const {
  buildEmailAuditContext,
  captureEmailCallStack,
  hashEmailAuditValue,
  sanitizeEmailAuditError
} = require('./emailAudit');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) {
    console.warn('Email: SMTP_USER or SMTP_PASS not set. Emails will not be sent.');
    return null;
  }
  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
  return transporter;
}

/**
 * Send a generic email
 */
async function sendMail({
  to,
  subject,
  text,
  html,
  intent,
  eventType,
  notificationType,
  templateKey,
  triggerSource,
  producerStack
}) {
  const policy = evaluateEmailPolicy({ intent, eventType, notificationType });
  const audit = buildEmailAuditContext({
    to,
    intent: policy.intent || intent,
    eventType: policy.eventType || eventType,
    notificationType,
    templateKey,
    triggerSource,
    producerStack,
    callStack: captureEmailCallStack()
  });
  if (!policy.allowed) {
    log.info('Email suppressed by channel policy', {
      ...audit,
      reason: policy.reason,
      routineEventType: policy.routineEventType || ''
    });
    return { sent: false, blocked: true, reason: policy.reason };
  }
  const trans = getTransporter();
  if (!trans) {
    log.warn('Email transport unavailable', audit);
    return { sent: false, error: 'Email not configured' };
  }
  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'ARC Gaming <noreply@arc.local>';
    log.info('Email dispatch authorized', audit);
    const info = await trans.sendMail({
      from,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject: subject || 'ARC Gaming',
      text: text || '',
      html: html || text
    });
    log.info('Email provider accepted', {
      ...audit,
      providerMessageHash: hashEmailAuditValue(info.messageId)
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    const sanitizedError = sanitizeEmailAuditError(err);
    log.error('Email provider rejected dispatch', { ...audit, error: sanitizedError });
    return { sent: false, error: sanitizedError };
  }
}

async function sendTransactionalEmail(options) {
  return sendMail(options);
}

/**
 * Send OTP email for login/register/forgot_password
 */
async function sendOTPEmail(to, otp, purpose = 'login') {
  const purposes = {
    login: 'Login',
    register: 'Email verification',
    forgot_password: 'Reset password'
  };
  const title = purposes[purpose] || 'Verification';

  // Subject + header text alag-alag purpose ke liye
  let subject = '';
  let headerTitle = '';
  let headerSubtitle = '';

  if (purpose === 'login') {
    subject = 'Login to ARC using OTP';
    headerTitle = 'Login to ARC using OTP';
    headerSubtitle = 'Secure one‑time verification for your account.';
  } else if (purpose === 'register') {
    subject = 'Verify your email for ARC';
    headerTitle = 'Verify your email for ARC';
    headerSubtitle = 'Complete your signup by confirming this email address.';
  } else if (purpose === 'forgot_password') {
    subject = 'Reset your ARC password';
    headerTitle = 'Reset your ARC password';
    headerSubtitle = 'Use this OTP to securely reset your password.';
  } else {
    subject = 'ARC verification code';
    headerTitle = 'ARC verification code';
    headerSubtitle = 'Use this code to complete your action.';
  }

  const text = `Your ARC OTP is: ${otp}. Valid for 10 minutes. Do not share with anyone.`;

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0b1120; padding:24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#020617;border-radius:16px;border:1px solid #1e293b;overflow:hidden;">
        <tr>
          <td style="padding:20px 24px 16px;background:linear-gradient(135deg,#4f46e5,#7c3aed);">
            <h1 style="margin:0;font-size:20px;font-weight:700;color:#e5e7eb;">${headerTitle}</h1>
            <p style="margin:4px 0 0;font-size:12px;color:#e5e7eb;opacity:0.85;">${headerSubtitle}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 24px 6px;color:#e5e7eb;">
            <p style="margin:0 0 8px;font-size:14px;">Your one-time verification code is:</p>
            <div style="margin:8px 0 12px;padding:14px 18px;border-radius:12px;background:#020617;border:1px solid #4f46e5;text-align:center;">
              <span style="display:inline-block;font-size:26px;letter-spacing:6px;font-weight:700;color:#f9fafb;">${otp}</span>
            </div>
            <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;">Valid for <strong>10 minutes</strong>. Do not share this code with anyone.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 24px 18px;">
            <p style="margin:0;font-size:11px;color:#64748b;">If you didn’t request this, you can safely ignore this email. Someone may have typed your email address by mistake.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 24px 16px;border-top:1px solid #1f2937;background:#020617;">
            <p style="margin:0 0 4px;font-size:11px;color:#6b7280;">
              Need help? Email
              <a href="mailto:support@squadhunt.com" style="color:#9ca3af;text-decoration:none;"> support@squadhunt.com</a>
              or visit
              <a href="https://arc.squadhunt.com" style="color:#9ca3af;text-decoration:none;"> arc.squadhunt.com</a>.
            </p>
            <p style="margin:0;font-size:11px;color:#6b7280;">— ARC</p>
          </td>
        </tr>
      </table>
    </div>
  `;

  return sendTransactionalEmail({
    to,
    subject,
    text,
    html,
    intent: EMAIL_INTENTS.SECURITY,
    eventType: `otp_${purpose}`,
    templateKey: 'security_otp',
    triggerSource: 'auth.otp',
    producerStack: captureEmailCallStack()
  });
}

/**
 * Send a policy-approved notification-shaped transactional email.
 */
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const sanitizeEmailLink = (value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
};

async function sendNotificationEmail(to, title, message, link, context = {}) {
  const subject = `ARC: ${title}`;
  const safeLink = sanitizeEmailLink(link);
  const text = `${title}\n\n${message}${safeLink ? `\n\nView: ${safeLink}` : ''}`;
  const html = `
    <div style="font-family: sans-serif;">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      ${safeLink ? `<p><a href="${escapeHtml(safeLink)}">View</a></p>` : ''}
      <p style="margin:8px 0 2px;color: #999; font-size: 12px;">Need help? Email <a href="mailto:support@squadhunt.com" style="color:#9ca3af;text-decoration:none;">support@squadhunt.com</a>.</p>
      <p style="margin:0;color: #999; font-size: 12px;">— ARC</p>
    </div>
  `;
  return sendTransactionalEmail({
    to,
    subject,
    text,
    html,
    intent: context.intent,
    eventType: context.eventType,
    notificationType: context.notificationType,
    templateKey: context.templateKey || 'transactional_notification',
    triggerSource: context.triggerSource,
    producerStack: context.producerStack
  });
}

module.exports = {
  sendOTPEmail,
  sendNotificationEmail,
  escapeHtml,
  sanitizeEmailLink
};
