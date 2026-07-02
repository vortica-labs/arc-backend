const EMAIL_INTENTS = Object.freeze({
  ACCOUNT_LIFECYCLE: 'account_lifecycle',
  SECURITY: 'security',
  PREMIUM_LIFECYCLE: 'premium_lifecycle',
  PAYMENT_TRANSACTIONAL: 'payment_transactional',
  CREATOR_STATUS: 'creator_status',
  HOST_STATUS: 'host_status',
  TOURNAMENT_REGISTRATION_PRIZE: 'tournament_registration_prize',
  RECRUITMENT_STATUS: 'recruitment_status',
  BROADCAST_EXPLICIT: 'broadcast_explicit',
  PLATFORM_CRITICAL: 'platform_critical',
  LEGAL_POLICY: 'legal_policy'
});

const ALLOWED_EMAIL_INTENTS = new Set(Object.values(EMAIL_INTENTS));

// These are product engagement signals. They may produce inbox rows, realtime
// events, and push alerts, but they never implicitly authorize email.
const ROUTINE_ENGAGEMENT_EVENTS = new Set([
  'like',
  'comment',
  'follow',
  'share',
  'mention',
  'tag',
  'reaction',
  'save',
  'profile_visit',
  'achievement',
  'tournament',
  'recruitment',
  'message',
  'story',
  'clip',
  'call'
]);

const normalizeValue = (value) => typeof value === 'string'
  ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  : '';

const normalizeRoutineEvent = (value) => {
  const normalized = normalizeValue(value);
  const aliases = {
    likes: 'like',
    post_like: 'like',
    clip_like: 'like',
    story_like: 'like',
    achievement_like: 'like',
    tournament_like: 'like',
    recruitment_like: 'like',
    liked_post: 'like',
    liked_clip: 'like',
    liked_story: 'like',
    liked_achievement: 'like',
    comments: 'comment',
    comment_reply: 'comment',
    reply_comment: 'comment',
    post_comment_reply: 'comment',
    achievement_comment: 'comment',
    follows: 'follow',
    new_follower: 'follow',
    follow_request: 'follow',
    follow_accepted: 'follow',
    follow_acceptance: 'follow',
    shares: 'share',
    post_share: 'share',
    clip_share: 'share',
    shared_post: 'share',
    shared_clip: 'share',
    mentions: 'mention',
    post_mention: 'mention',
    comment_mention: 'mention',
    mentioned_in_post: 'mention',
    mentioned_in_comment: 'mention',
    tagged: 'tag',
    tags: 'tag',
    post_tag: 'tag',
    comment_tag: 'tag',
    tagged_in_post: 'tag',
    reactions: 'reaction',
    post_reaction: 'reaction',
    comment_reaction: 'reaction',
    message_reaction: 'reaction',
    saves: 'save',
    post_save: 'save',
    saved_post: 'save',
    clip_save: 'save',
    saved_clip: 'save',
    profile_view: 'profile_visit',
    profile_views: 'profile_visit',
    profile_visited: 'profile_visit',
    visited_profile: 'profile_visit',
    achievements: 'achievement',
    tournaments: 'tournament',
    tournament_registration: 'tournament',
    tournament_prize: 'tournament',
    recruitment_application: 'recruitment',
    recruitment_update: 'recruitment'
  };
  return aliases[normalized] || normalized;
};

const getRoutineEngagementEvent = (input = {}) => {
  const notification = input.notification || input;
  const data = notification?.data || {};
  const customData = data.customData || {};
  const candidates = [
    input.eventType,
    input.notificationType,
    notification.emailEventType,
    notification.engagementType,
    notification.type,
    data.eventType,
    data.engagementType,
    customData.eventType,
    customData.engagementType
  ];
  for (const candidate of candidates) {
    const eventType = normalizeRoutineEvent(candidate);
    if (ROUTINE_ENGAGEMENT_EVENTS.has(eventType)) return eventType;
  }
  if (data.recruitmentId || customData.recruitmentId) {
    return 'recruitment';
  }
  if (data.tournamentId || customData.tournamentId || customData.scrimId || customData.scrimCode) {
    return 'tournament';
  }
  return null;
};

const getEmailIntent = (input = {}) => normalizeValue(
  input.intent ||
  input.emailIntent ||
  input.email?.intent ||
  input.notification?.emailIntent ||
  input.notification?.email?.intent ||
  input.notification?.data?.customData?.emailIntent
);

const evaluateEmailPolicy = (input = {}) => {
  const intent = getEmailIntent(input);
  const routineEventType = getRoutineEngagementEvent(input);

  // Broadcast Center does not yet own a durable email outbox/terminal
  // reconciliation path. Keep the intent reserved but fail closed until the
  // worker can revalidate recipient identity and cancellation from MongoDB.
  if (intent === EMAIL_INTENTS.BROADCAST_EXPLICIT) {
    return { allowed: false, intent, routineEventType, reason: 'broadcast_email_transport_not_configured' };
  }

  if (routineEventType) {
    // Recruitment application decisions are explicitly transactional; general
    // recruitment discovery/activity remains routine engagement.
    if (routineEventType === 'recruitment' && intent === EMAIL_INTENTS.RECRUITMENT_STATUS) {
      return { allowed: true, intent, routineEventType, reason: 'explicit_recruitment_status' };
    }
    // Tournament registration and prize outcomes are transactional, while
    // tournament activity/updates remain push + in-app only.
    if (routineEventType === 'tournament' && intent === EMAIL_INTENTS.TOURNAMENT_REGISTRATION_PRIZE) {
      return { allowed: true, intent, routineEventType, reason: 'explicit_tournament_transaction' };
    }
    return { allowed: false, intent, routineEventType, reason: 'routine_engagement_email_blocked' };
  }

  if (!ALLOWED_EMAIL_INTENTS.has(intent)) {
    return { allowed: false, intent, routineEventType: null, reason: 'missing_or_invalid_email_intent' };
  }
  return { allowed: true, intent, routineEventType: null, reason: 'explicit_transactional_intent' };
};

const evaluateNotificationEmailPolicy = (notification, context = {}) => evaluateEmailPolicy({
  ...context,
  notification,
  intent: context.intent || notification?.email?.intent || notification?.emailIntent,
  eventType: context.eventType || notification?.email?.eventType || notification?.emailEventType
});

module.exports = {
  EMAIL_INTENTS,
  ROUTINE_ENGAGEMENT_EVENTS,
  normalizeRoutineEvent,
  getRoutineEngagementEvent,
  getEmailIntent,
  evaluateEmailPolicy,
  evaluateNotificationEmailPolicy
};
