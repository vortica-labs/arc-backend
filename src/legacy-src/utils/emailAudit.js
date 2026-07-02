const { createHash } = require('crypto');

const normalizeRecipient = (value) => String(value || '').trim().toLowerCase();

const maskRecipient = (value) => {
  const recipient = normalizeRecipient(value);
  const at = recipient.lastIndexOf('@');
  if (at <= 0) return recipient ? `${recipient.slice(0, 1)}***` : 'missing';
  const local = recipient.slice(0, at);
  const domain = recipient.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain || 'unknown'}`;
};

const recipientValues = (value) => (Array.isArray(value) ? value : [value])
  .map(normalizeRecipient)
  .filter(Boolean);

const maskEmailRecipient = (value) => {
  const values = recipientValues(value);
  return values.length ? values.map(maskRecipient).join(',') : 'missing';
};

const hashEmailRecipient = (value) => {
  const normalized = recipientValues(value).sort().join(',');
  return normalized
    ? createHash('sha256').update(normalized).digest('hex').slice(0, 16)
    : 'missing';
};

const hashEmailAuditValue = (value) => {
  const normalized = String(value || '').trim();
  return normalized
    ? createHash('sha256').update(normalized).digest('hex').slice(0, 16)
    : 'missing';
};

const sanitizeEmailAuditError = (error) => String(error?.message || error || 'unknown_email_error')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
  .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
  .slice(0, 600);

const captureEmailCallStack = () => {
  if (process.env.EMAIL_DISPATCH_AUDIT_STACK === 'false') return '';
  const frames = String(new Error('email_dispatch_audit').stack || '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('emailAudit.js') && !line.includes('node:internal'))
    .slice(0, 8);
  return frames.join(' <- ').slice(0, 1600);
};

const inferEmailTriggerSource = (stack = '') => {
  const firstFrame = String(stack)
    .split(' <- ')
    .find((frame) => frame && !frame.includes('/utils/jobQueue.js') && !frame.includes('/utils/email.js'));
  if (!firstFrame) return 'unknown';
  const pathMatch = firstFrame.match(/(?:at\s+)?(?:[^\s(]+\s+\()?(.+?):\d+:\d+\)?$/);
  return (pathMatch?.[1] || firstFrame).replace(process.cwd(), '.').slice(0, 320);
};

const buildEmailAuditContext = ({
  to,
  intent,
  eventType,
  notificationType,
  templateKey,
  triggerSource,
  producerStack,
  callStack
} = {}) => {
  const resolvedCallStack = producerStack || callStack || captureEmailCallStack();
  return {
    event: eventType || notificationType || 'missing',
    intent: intent || 'missing',
    template: templateKey || 'transactional_notification',
    recipient: maskEmailRecipient(to),
    recipientHash: hashEmailRecipient(to),
    triggerSource: triggerSource || inferEmailTriggerSource(resolvedCallStack),
    callStack: resolvedCallStack || 'disabled'
  };
};

module.exports = {
  maskEmailRecipient,
  hashEmailRecipient,
  hashEmailAuditValue,
  sanitizeEmailAuditError,
  captureEmailCallStack,
  inferEmailTriggerSource,
  buildEmailAuditContext
};
