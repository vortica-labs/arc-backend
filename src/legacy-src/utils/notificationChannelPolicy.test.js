const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  EMAIL_INTENTS,
  ALLOWED_EMAIL_EVENTS,
  evaluateEmailPolicy,
  evaluateNotificationEmailPolicy
} = require('./notificationChannelPolicy');
const { maskEmailRecipient, buildEmailAuditContext } = require('./emailAudit');

const routineMatrix = {
  like: ['like', 'post_like', 'post.like', 'post/like', 'clip_like', 'story_like', 'achievement_like', 'tournament_like', 'recruitment_like'],
  comment: ['comment', 'reply', 'replies', 'comment_reply', 'post_comment_reply', 'achievement_comment', 'post_comment_created'],
  share: ['share', 'post_share', 'clip_share', 'shared_post', 'shared_clip'],
  follow: ['follow', 'new_follower', 'follow_request', 'follow_accepted', 'follow_acceptance'],
  mention: ['mention', 'post_mention', 'comment_mention'],
  tag: ['tag', 'tagged_in_post'],
  save: ['save', 'saved_post', 'saved_clip'],
  reaction: ['reaction', 'post_reaction', 'comment_reaction', 'message_reaction'],
  profile_visit: ['profile_visit', 'profile_view', 'visited_profile'],
  achievement: ['achievement'],
  tournament: ['tournament', 'tournament_registration', 'tournament_update', 'tournament_match_update', 'tournament_invitation', 'match_update'],
  recruitment: ['recruitment', 'recruitment_application', 'recruitment_invitation', 'recruitment_application_accepted', 'recruitment_application_rejected', 'recruitment_accept', 'recruitment_reject'],
  message: ['message', 'new_message', 'direct_message', 'voice_message', 'audio_message', 'image_message', 'video_message', 'media_message', 'group_message', 'shared_post_message', 'shared_clip_message'],
  story: ['story', 'story_view', 'story_reaction', 'story_reply'],
  clip: ['clip', 'clip_comment', 'clip_view'],
  call: ['call', 'voice_call', 'video_call', 'incoming_call', 'incoming_voice_call', 'incoming_video_call', 'missed_call'],
  random_connect: ['random_connect', 'random_connect_match_found', 'random_connect_session_update'],
  presence: ['presence', 'presence_update'],
  recommendation: ['recommendation', 'recommendations'],
  feed_activity: ['feed_activity', 'engagement'],
  friend_suggestion: ['friend_suggestion', 'friend_suggestions']
};

for (const [expectedType, variants] of Object.entries(routineMatrix)) {
  for (const eventType of variants) {
    const untyped = evaluateEmailPolicy({ eventType });
    assert.equal(untyped.allowed, false, `${eventType} must not email by default`);
    assert.equal(untyped.routineEventType, expectedType);
    const mistyped = evaluateEmailPolicy({ intent: EMAIL_INTENTS.SECURITY, eventType });
    assert.equal(mistyped.allowed, false, `${eventType} must stay blocked under a non-matching transactional intent`);
    assert.equal(mistyped.reason, 'routine_engagement_email_blocked');
  }
}

assert.equal(
  evaluateNotificationEmailPolicy({
    type: 'system',
    data: { applicationId: 'creator-application-id' },
    email: { intent: EMAIL_INTENTS.ACCOUNT_LIFECYCLE, eventType: 'account_reactivation' }
  }).allowed,
  true,
  'a generic applicationId must not be misclassified as recruitment'
);
assert.equal(
  evaluateNotificationEmailPolicy({ type: 'like', email: { intent: EMAIL_INTENTS.PLATFORM_CRITICAL } }).allowed,
  false,
  'notification type itself is a final engagement guard'
);
assert.equal(
  evaluateEmailPolicy({ intent: 'broadcast_explicit', eventType: 'tournament' }).allowed,
  false,
  'a legacy broadcast intent cannot bypass an engagement guard'
);
assert.equal(
  evaluateEmailPolicy({
    intent: 'broadcast_explicit',
    eventType: 'tournament',
    broadcastId: 'broadcast-id',
    broadcastRecipientId: 'recipient-id'
  }).allowed,
  false,
  'caller-supplied IDs cannot bypass the policy'
);

for (const [intent, eventTypes] of Object.entries(ALLOWED_EMAIL_EVENTS)) {
  assert(eventTypes.length > 0, `${intent} must have at least one explicit event`);
  for (const eventType of eventTypes) {
    assert.equal(evaluateEmailPolicy({ intent, eventType }).allowed, true, `${intent}/${eventType} should be allowed`);
    for (const otherIntent of Object.values(EMAIL_INTENTS)) {
      if (otherIntent === intent || ALLOWED_EMAIL_EVENTS[otherIntent].includes(eventType)) continue;
      assert.equal(
        evaluateEmailPolicy({ intent: otherIntent, eventType }).allowed,
        false,
        `${eventType} must not cross from ${intent} into ${otherIntent}`
      );
    }
  }
}
for (const intent of ['creator_status', 'host_status', 'tournament_registration_prize', 'recruitment_status', 'broadcast_explicit']) {
  const result = evaluateEmailPolicy({ intent, eventType: 'legacy_queued_email' });
  assert.equal(result.allowed, false, `${intent} must remain disabled for queued legacy jobs`);
  assert.equal(result.reason, 'email_intent_disabled_by_policy');
}
assert.equal(evaluateEmailPolicy({}).allowed, false);
assert.equal(evaluateEmailPolicy({ intent: 'transactional' }).allowed, false, 'there is no generic transactional bypass');
for (const intent of Object.values(EMAIL_INTENTS)) {
  assert.equal(evaluateEmailPolicy({ intent }).reason, 'missing_or_invalid_email_event');
  assert.equal(evaluateEmailPolicy({ intent, eventType: `${intent}_event` }).allowed, false, 'unknown events must fail closed');
}
assert.equal(evaluateEmailPolicy({
  intent: EMAIL_INTENTS.PLATFORM_CRITICAL,
  eventType: 'service_incident',
  notificationType: 'message'
}).allowed, false, 'a valid event pair cannot override a social notification type');
assert.equal(evaluateEmailPolicy({
  intent: EMAIL_INTENTS.SECURITY,
  eventType: 'password_changed',
  notification: { data: { customData: { engagementType: 'story_reply' } } }
}).allowed, false, 'nested social metadata must block an otherwise valid pair');

assert.equal(maskEmailRecipient('person@example.com'), 'p***@example.com');
const auditContext = buildEmailAuditContext({
  to: 'person@example.com',
  intent: EMAIL_INTENTS.SECURITY,
  eventType: 'password_changed',
  templateKey: 'security_password_changed',
  triggerSource: 'test.security',
  producerStack: 'at test (policy.test.js:1:1)'
});
assert.equal(auditContext.recipient, 'p***@example.com');
assert(!JSON.stringify(auditContext).includes('person@example.com'), 'email audit logs must not expose raw recipients');
assert.equal(auditContext.template, 'security_password_changed');
assert.equal(auditContext.triggerSource, 'test.security');

const previousSmtpUser = process.env.SMTP_USER;
const previousSmtpPass = process.env.SMTP_PASS;
process.env.SMTP_USER = 'policy-test@example.com';
process.env.SMTP_PASS = 'test-password';

const nodemailer = require('nodemailer');
const originalCreateTransport = nodemailer.createTransport;
const deliveries = [];
nodemailer.createTransport = () => ({
  sendMail: async (payload) => {
    deliveries.push(payload);
    return { messageId: `message-${deliveries.length}` };
  }
});

const emailPath = require.resolve('./email');
delete require.cache[emailPath];
const email = require('./email');
const jobQueue = require('./jobQueue');

const run = async () => {
  assert.equal(email.sendMail, undefined, 'raw SMTP helper must not be exported');
  assert.equal(email.sendTransactionalEmail, undefined, 'raw transactional helper must not be exported');
  assert.equal(email.getTransporter, undefined, 'Nodemailer transporter must remain private');
  assert.equal((await email.sendNotificationEmail('user@example.com', 'Untyped', 'Blocked', '')).blocked, true);
  assert.equal((await email.sendNotificationEmail(
    'user@example.com',
    'Badly typed social event',
    'Blocked',
    '',
    { intent: EMAIL_INTENTS.SECURITY, eventType: 'post_like' }
  )).blocked, true);
  assert.equal((await email.sendNotificationEmail(
    'user@example.com',
    'Unknown event',
    'Blocked',
    '',
    { intent: EMAIL_INTENTS.SECURITY, eventType: 'friend_request' }
  )).blocked, true);
  assert.equal((await email.sendNotificationEmail(
    'user@example.com',
    'Cross-intent event',
    'Blocked',
    '',
    { intent: EMAIL_INTENTS.ACCOUNT_LIFECYCLE, eventType: 'password_changed' }
  )).blocked, true);
  assert.equal(deliveries.length, 0);

  assert.equal((await email.sendNotificationEmail(
    'user@example.com',
    'Password changed',
    'Your password changed.',
    '',
    { intent: EMAIL_INTENTS.SECURITY, eventType: 'password_changed' }
  )).sent, true);
  assert.equal((await email.sendOTPEmail('user@example.com', '123456', 'login')).sent, true);
  assert.equal((await email.sendNotificationEmail(
    'user@example.com',
    'Application accepted',
    'Your application was accepted.',
    '',
    { intent: 'recruitment_status', eventType: 'recruitment' }
  )).blocked, true);

  const escaped = await email.sendNotificationEmail(
    'user@example.com',
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    'javascript:alert(1)',
    { intent: EMAIL_INTENTS.PLATFORM_CRITICAL, eventType: 'service_incident' }
  );
  assert.equal(escaped.sent, true);
  assert(!deliveries.at(-1).html.includes('<script>'));
  assert(!deliveries.at(-1).html.includes('<img'));
  assert(!deliveries.at(-1).html.includes('javascript:'));

  assert.equal((await email.sendNotificationEmail(
    'user@example.com',
    'Tournament broadcast',
    'Explicit admin broadcast',
    'https://arc.example/tournament/1',
    { intent: 'broadcast_explicit', eventType: 'tournament' }
  )).blocked, true, 'broadcast transport must revalidate durable broadcast identity');
  assert.equal((await email.sendNotificationEmail(
    'user@example.com',
    'Tournament broadcast',
    'Explicit admin broadcast',
    'https://arc.example/tournament/1',
    {
      intent: 'broadcast_explicit',
      eventType: 'tournament',
      broadcastId: 'broadcast-id',
      broadcastRecipientId: 'recipient-id'
    }
  )).blocked, true, 'caller-supplied IDs must not bypass the missing durable broadcast transport');

  let queued = 0;
  let lastContext = null;
  jobQueue.setQueueFunctions({
    enqueueEmail: async (to, subject, text, link, context) => {
      queued += 1;
      lastContext = context;
    }
  });
  assert.equal((await jobQueue.enqueueEmail('user@example.com', 'Legacy social', 'No', '')).blocked, true);
  assert.equal((await jobQueue.enqueueEmail(
    'user@example.com',
    'Mistagged social',
    'No',
    '',
    { intent: EMAIL_INTENTS.ACCOUNT_LIFECYCLE, eventType: 'follow_request' }
  )).blocked, true);
  assert.equal(queued, 0);
  assert.equal((await jobQueue.enqueueEmail(
    'user@example.com',
    'Premium activated',
    'Active',
    'https://arc.example/premium',
    { intent: EMAIL_INTENTS.PREMIUM_LIFECYCLE, eventType: 'activation' }
  )).queued, true);
  assert.equal(queued, 1);
  assert.equal(lastContext.intent, EMAIL_INTENTS.PREMIUM_LIFECYCLE);
  assert.equal(lastContext.eventType, 'activation');
  assert(lastContext.producerStack, 'queue boundary must preserve the producer stack for audit');

  jobQueue.setQueueFunctions({
    enqueueEmail: async () => {
      throw new Error('ambiguous queue acknowledgement');
    }
  });
  await assert.rejects(
    jobQueue.enqueueEmail(
      'user@example.com',
      'Premium activated',
      'Active',
      '',
      { intent: EMAIL_INTENTS.PREMIUM_LIFECYCLE, eventType: 'activation' }
    ),
    /ambiguous queue acknowledgement/
  );
  assert.equal(deliveries.length, 3, 'queue errors must never fall through to a duplicate synchronous SMTP path');

  const queueSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'infrastructure', 'jobs', 'queue.ts'), 'utf8');
  assert(queueSource.includes('sendNotificationEmail(to, subject, text, link, workerContext)'));
  assert(queueSource.includes('if (result?.blocked)'));
  assert(queueSource.includes('Email job suppressed by channel policy'));
  assert(queueSource.includes('emailPolicy.evaluateEmailPolicy(typedContext)'), 'TypeScript producer must gate jobs before Redis');
  assert(queueSource.includes('emailPolicy.evaluateEmailPolicy(context || {})'), 'worker must gate old Redis jobs before transport');
  assert(queueSource.includes('backendRootPath'), 'worker and HTTP runtime must use the same canonical legacy source');
  assert(!queueSource.includes('path.resolve(__dirname, "..", "..", "legacy-src")'));
  assert(!queueSource.includes('logger.info("Email sent via worker", { to, subject })'), 'worker logs must not expose recipient email');
  assert(!queueSource.includes('emailUtil.sendNotificationEmail(to, subject, text, link);'));

  console.log('Notification channel and email policy tests passed');
};

run()
  .finally(() => {
    nodemailer.createTransport = originalCreateTransport;
    if (previousSmtpUser === undefined) delete process.env.SMTP_USER;
    else process.env.SMTP_USER = previousSmtpUser;
    if (previousSmtpPass === undefined) delete process.env.SMTP_PASS;
    else process.env.SMTP_PASS = previousSmtpPass;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
