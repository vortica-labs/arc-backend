/**
 * Job Queue Bridge
 * ----------------
 * Provides enqueueEmail() and enqueueBulkNotifications() to legacy JS code.
 * The actual queue handlers are injected from TypeScript at startup.
 *
 * If the queue is not available (Redis down, not injected yet),
 * falls back to synchronous execution.
 */

const log = require('./logger');
const { createHash, randomUUID } = require('crypto');
const { evaluateEmailPolicy } = require('./notificationChannelPolicy');
const {
  buildEmailAuditContext,
  captureEmailCallStack,
  inferEmailTriggerSource,
  sanitizeEmailAuditError
} = require('./emailAudit');

let _enqueueEmail = null;
let _enqueueBulkNotifications = null;
let _enqueuePushReceipts = null;
let _enqueuePushSend = null;
let _enqueueBroadcast = null;
let _enqueueBroadcastReceipts = null;
let _removeBroadcastJobs = null;

/**
 * Inject the queue functions from TypeScript land.
 */
const setQueueFunctions = ({ enqueueEmail, enqueueBulkNotifications, enqueuePushReceipts, enqueuePushSend, enqueueBroadcast, enqueueBroadcastReceipts, removeBroadcastJobs }) => {
  _enqueueEmail = enqueueEmail;
  _enqueueBulkNotifications = enqueueBulkNotifications;
  _enqueuePushReceipts = enqueuePushReceipts;
  _enqueuePushSend = enqueuePushSend;
  _enqueueBroadcast = enqueueBroadcast;
  _enqueueBroadcastReceipts = enqueueBroadcastReceipts;
  _removeBroadcastJobs = removeBroadcastJobs;
};

const enqueuePushSend = async (attemptIds, runAt, retryKey) => {
  if (!_enqueuePushSend) {
    const error = new Error('Push retry queue is not available');
    error.statusCode = 503;
    throw error;
  }
  return _enqueuePushSend(attemptIds, runAt, retryKey);
};

const enqueuePushReceipts = async (attemptIds, runAt, reconciliationKey) => {
  if (!_enqueuePushReceipts) {
    const error = new Error('Push receipt queue is not available');
    error.statusCode = 503;
    throw error;
  }
  return _enqueuePushReceipts(attemptIds, runAt, reconciliationKey);
};

const enqueueBroadcastReceipts = async (receiptRecordIds, runAt, reconciliationKey) => {
  if (!_enqueueBroadcastReceipts) {
    const error = new Error('Broadcast receipt queue is not available');
    error.statusCode = 503;
    throw error;
  }
  return _enqueueBroadcastReceipts(receiptRecordIds, runAt, reconciliationKey);
};

/**
 * Queue one immediate or delayed broadcast dispatch. Broadcast delivery never
 * falls back to the request process because fan-out must remain asynchronous.
 */
const enqueueBroadcast = async (broadcastId, runAt, occurrenceKey, recoveryKey) => {
  if (!_enqueueBroadcast) {
    const error = new Error('Broadcast queue is not available');
    error.statusCode = 503;
    throw error;
  }
  return _enqueueBroadcast(broadcastId, runAt, occurrenceKey, recoveryKey);
};

const removeBroadcastJobs = async (broadcastId) => {
  if (!_removeBroadcastJobs) return;
  return _removeBroadcastJobs(broadcastId);
};

/**
 * Enqueue an email to be sent in the background.
 * Uses direct delivery only before a queue function has been injected. Once
 * BullMQ is active, enqueue errors are surfaced to avoid ambiguous duplicates.
 * @param {string} to
 * @param {string} subject
 * @param {string} text
 * @param {string} [link]
 * @param {{intent: string, eventType?: string, notificationType?: string}} [context]
 */
const enqueueEmail = async (to, subject, text, link, context = {}) => {
  const producerStack = context.producerStack || captureEmailCallStack();
  const triggerSource = context.triggerSource || inferEmailTriggerSource(producerStack);
  const policy = evaluateEmailPolicy(context);
  const audit = buildEmailAuditContext({
    to,
    intent: policy.intent || context.intent,
    eventType: policy.eventType || context.eventType,
    notificationType: context.notificationType,
    templateKey: context.templateKey,
    triggerSource,
    producerStack
  });
  if (!policy.allowed) {
    log.info('Email queue submission suppressed by channel policy', {
      ...audit,
      reason: policy.reason,
      routineEventType: policy.routineEventType || ''
    });
    return { queued: false, blocked: true, reason: policy.reason };
  }
  const typedContext = {
    ...context,
    intent: policy.intent,
    eventType: policy.eventType,
    triggerSource,
    producerStack,
    templateKey: context.templateKey || 'transactional_notification'
  };
  log.info('Email queue submission authorized', audit);

  if (_enqueueEmail) {
    try {
      await _enqueueEmail(to, subject, text, link, typedContext);
      return { queued: true, blocked: false };
    } catch (error) {
      // An enqueue acknowledgement can be lost after Redis accepted the job.
      // Sending synchronously here could therefore deliver the same email
      // twice. Surface the queue failure and let the caller/recovery path retry
      // with durable state instead of opening a second delivery path.
      log.error('Email queue submission failed', {
        ...audit,
        error: sanitizeEmailAuditError(error)
      });
      throw error;
    }
  }

  // Bootstrap/test fallback only. Production injects BullMQ before accepting
  // requests, so there is exactly one active delivery path.
  const { sendNotificationEmail } = require('./email');
  const result = await sendNotificationEmail(to, subject, text, link, typedContext);
  if (!result?.sent && !result?.blocked) {
    const error = new Error(result?.error || 'Email delivery failed');
    error.code = 'EMAIL_DELIVERY_FAILED';
    throw error;
  }
  return result;
};

/**
 * Enqueue bulk notifications in the background.
 * Falls back to direct bulk insert if queue is unavailable.
 * @param {string[]} recipientIds
 * @param {string} title
 * @param {string} message
 * @param {string} [type]
 * @param {object} [data]
 * @param {string} [deliveryKey]
 */
const enqueueBulkNotifications = async (recipientIds, title, message, type, data, deliveryKey) => {
  const stableDeliveryKey = createHash('sha256')
    .update(String(deliveryKey || randomUUID()))
    .digest('hex');
  if (_enqueueBulkNotifications) {
    try {
      await _enqueueBulkNotifications(recipientIds, title, message, type, data, stableDeliveryKey);
      return { queued: true, deliveryKey: stableDeliveryKey };
    } catch (error) {
      log.warn('Bulk notification queue unavailable; using synchronous delivery', {
        error: String(error),
        count: Array.isArray(recipientIds) ? recipientIds.length : 0,
        deliveryKey: stableDeliveryKey.slice(0, 16)
      });
      // Fall through to synchronous canonical delivery.
    }
  }

  // Fallback: use the canonical producer so push durability and preferences
  // are identical whether Redis is available or not.
  const { createAndEmitNotification } = require('./notificationEmitter');
  const ids = Array.from(new Set((recipientIds || []).map(String).filter(Boolean)));
  const customData = data?.customData && typeof data.customData === 'object' && !Array.isArray(data.customData)
    ? data.customData
    : {};
  const failures = [];
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    const results = await Promise.allSettled(slice.map(recipient => createAndEmitNotification({
      recipient,
      type: type || 'system',
      title,
      message,
      data: {
        ...(data || {}),
        customData: {
          ...customData,
          notificationDedupeKey: stableDeliveryKey,
          pushRequestId: stableDeliveryKey,
          pushSource: 'bulk'
        }
      }
    })));
    results.forEach((result, index) => {
      if (result.status === 'rejected') failures.push({ recipient: slice[index], error: result.reason });
    });
  }
  if (failures.length > 0) {
    log.error('Synchronous bulk notification delivery failed', {
      failures: failures.length,
      count: ids.length,
      recipients: failures.slice(0, 20).map((entry) => entry.recipient),
      deliveryKey: stableDeliveryKey.slice(0, 16)
    });
    throw new AggregateError(
      failures.map((entry) => new Error(`${entry.recipient}: ${String(entry.error)}`)),
      `${failures.length} bulk notification deliveries failed`
    );
  }
  return { queued: false, deliveryKey: stableDeliveryKey };
};

module.exports = {
  setQueueFunctions,
  enqueueEmail,
  enqueueBulkNotifications,
  enqueuePushReceipts,
  enqueuePushSend,
  enqueueBroadcast,
  enqueueBroadcastReceipts,
  removeBroadcastJobs
};
