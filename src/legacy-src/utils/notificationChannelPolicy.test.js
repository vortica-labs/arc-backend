const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  EMAIL_INTENTS,
  evaluateEmailPolicy,
  evaluateNotificationEmailPolicy
} = require('./notificationChannelPolicy');

const routineMatrix = {
  like: ['like', 'post_like', 'post.like', 'post/like', 'clip_like', 'story_like', 'achievement_like', 'tournament_like', 'recruitment_like'],
  comment: ['comment', 'comment_reply', 'achievement_comment'],
  share: ['share', 'post_share', 'clip_share'],
  follow: ['follow', 'new_follower', 'follow_request', 'follow_acceptance'],
  mention: ['mention', 'post_mention', 'comment_mention'],
  tag: ['tag', 'tagged_in_post'],
  save: ['save', 'saved_post', 'saved_clip'],
  reaction: ['reaction', 'post_reaction', 'comment_reaction', 'message_reaction'],
  profile_visit: ['profile_visit', 'profile_view', 'visited_profile'],
  achievement: ['achievement'],
  tournament: ['tournament'],
  recruitment: ['recruitment']
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
  evaluateEmailPolicy({ intent: EMAIL_INTENTS.RECRUITMENT_STATUS, eventType: 'recruitment' }).allowed,
  true,
  'an explicitly typed recruitment decision is transactional'
);
assert.equal(
  evaluateEmailPolicy({ intent: EMAIL_INTENTS.TOURNAMENT_REGISTRATION_PRIZE, eventType: 'tournament_registration' }).allowed,
  true,
  'registration and prize outcomes are explicit tournament transactions'
);
assert.equal(
  evaluateNotificationEmailPolicy({
    type: 'system',
    data: { applicationId: 'creator-application-id' },
    email: { intent: EMAIL_INTENTS.CREATOR_STATUS, eventType: 'creator_application_approved' }
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
  evaluateEmailPolicy({ intent: EMAIL_INTENTS.BROADCAST_EXPLICIT, eventType: 'tournament' }).allowed,
  false,
  'broadcast intent cannot bypass an engagement guard without a configured durable transport'
);
assert.equal(
  evaluateEmailPolicy({
    intent: EMAIL_INTENTS.BROADCAST_EXPLICIT,
    eventType: 'tournament',
    broadcastId: 'broadcast-id',
    broadcastRecipientId: 'recipient-id'
  }).allowed,
  false,
  'caller-supplied IDs are not a substitute for worker-side identity revalidation'
);

for (const intent of Object.values(EMAIL_INTENTS).filter((value) => value !== EMAIL_INTENTS.BROADCAST_EXPLICIT)) {
  const eventType = intent === EMAIL_INTENTS.RECRUITMENT_STATUS
    ? 'recruitment_status_changed'
    : intent === EMAIL_INTENTS.TOURNAMENT_REGISTRATION_PRIZE
      ? 'tournament_registration'
      : `${intent}_event`;
  assert.equal(evaluateEmailPolicy({ intent, eventType }).allowed, true, `${intent} should allow its explicit transactional family`);
}
assert.equal(evaluateEmailPolicy({}).allowed, false);
assert.equal(evaluateEmailPolicy({ intent: 'transactional' }).allowed, false, 'there is no generic transactional bypass');

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
  assert.equal((await email.sendMail({ to: 'user@example.com', subject: 'Untyped', text: 'Blocked' })).blocked, true);
  assert.equal((await email.sendTransactionalEmail({
    to: 'user@example.com',
    subject: 'Badly typed social event',
    text: 'Blocked',
    intent: EMAIL_INTENTS.SECURITY,
    eventType: 'post_like'
  })).blocked, true);
  assert.equal(deliveries.length, 0);

  assert.equal((await email.sendTransactionalEmail({
    to: 'user@example.com',
    subject: 'Password changed',
    text: 'Your password changed.',
    intent: EMAIL_INTENTS.SECURITY,
    eventType: 'password_changed'
  })).sent, true);
  assert.equal((await email.sendOTPEmail('user@example.com', '123456', 'login')).sent, true);
  assert.equal((await email.sendTransactionalEmail({
    to: 'user@example.com',
    subject: 'Application accepted',
    text: 'Your application was accepted.',
    intent: EMAIL_INTENTS.RECRUITMENT_STATUS,
    eventType: 'recruitment'
  })).sent, true);

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
    { intent: EMAIL_INTENTS.BROADCAST_EXPLICIT, eventType: 'tournament' }
  )).blocked, true, 'broadcast transport must revalidate durable broadcast identity');
  assert.equal((await email.sendNotificationEmail(
    'user@example.com',
    'Tournament broadcast',
    'Explicit admin broadcast',
    'https://arc.example/tournament/1',
    {
      intent: EMAIL_INTENTS.BROADCAST_EXPLICIT,
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
    { intent: EMAIL_INTENTS.PREMIUM_LIFECYCLE, eventType: 'premium_activated' }
  )).queued, true);
  assert.equal(queued, 1);
  assert.equal(lastContext.intent, EMAIL_INTENTS.PREMIUM_LIFECYCLE);

  const queueSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'infrastructure', 'jobs', 'queue.ts'), 'utf8');
  assert(queueSource.includes('sendNotificationEmail(to, subject, text, link, context || {})'));
  assert(queueSource.includes('if (result?.blocked)'));
  assert(queueSource.includes('Email job suppressed by channel policy'));
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
