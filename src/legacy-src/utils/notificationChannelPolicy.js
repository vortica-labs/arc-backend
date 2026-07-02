const EMAIL_INTENTS = Object.freeze({
  ACCOUNT_LIFECYCLE: 'account_lifecycle',
  SECURITY: 'security',
  PREMIUM_LIFECYCLE: 'premium_lifecycle',
  PAYMENT_TRANSACTIONAL: 'payment_transactional',
  PLATFORM_CRITICAL: 'platform_critical',
  LEGAL_POLICY: 'legal_policy'
});

const ALLOWED_EMAIL_INTENTS = new Set(Object.values(EMAIL_INTENTS));

// Email approval is deliberately two-dimensional: a broad intent is never
// sufficient on its own. Every delivery must also name an exact transactional
// event from the corresponding allowlist. This closes the historical bypass
// where a social producer could attach `platform_critical` (or omit its event
// name) and reach SMTP because the event was not recognized as engagement.
const ALLOWED_EMAIL_EVENTS = Object.freeze({
  [EMAIL_INTENTS.SECURITY]: Object.freeze([
    'otp_login',
    'otp_register',
    'otp_forgot_password',
    'email_verification',
    'verify_email',
    'password_reset',
    'password_changed',
    'email_changed',
    'change_email_confirmation',
    'suspicious_login',
    'new_device_login',
    'security_alert',
    'account_recovery',
    'admin_password_reset'
  ]),
  [EMAIL_INTENTS.ACCOUNT_LIFECYCLE]: Object.freeze([
    'welcome',
    'welcome_email',
    'account_created',
    'account_deletion',
    'account_deleted',
    'account_reactivation',
    'account_restored',
    'account_suspended',
    'report_account_suspended',
    'account_banned'
  ]),
  [EMAIL_INTENTS.PREMIUM_LIFECYCLE]: Object.freeze([
    'purchase',
    'activation',
    'renewal',
    'plan_change',
    'cancellation',
    'access_removal',
    'resume',
    'auto_renew_change',
    'refund',
    'expiration',
    'activated',
    'charged',
    'cancelled',
    'paused',
    'resumed',
    'pending',
    'halted',
    'completed',
    'expired',
    'payment_failed',
    'subscription_failed',
    'expiry_reminder'
  ]),
  [EMAIL_INTENTS.PAYMENT_TRANSACTIONAL]: Object.freeze([
    'payment_success',
    'payment_failed',
    'payment_receipt',
    'invoice',
    'refund',
    'refund_processed',
    'refund_failed',
    'payout_held',
    'withdrawal_approved',
    'withdrawal_rejected',
    'creator_payout_approved',
    'creator_payout_processing',
    'creator_payout_paid',
    'creator_payout_completed',
    'creator_payout_failed',
    'creator_payout_held',
    'creator_payout_cancelled',
    'creator_payout_rejected'
  ]),
  [EMAIL_INTENTS.PLATFORM_CRITICAL]: Object.freeze([
    'critical_platform_announcement',
    'critical_maintenance',
    'critical_service_disruption',
    'service_incident',
    'service_outage',
    'emergency_announcement'
  ]),
  [EMAIL_INTENTS.LEGAL_POLICY]: Object.freeze([
    'privacy_policy_update',
    'terms_update',
    'terms_of_service_update',
    'compliance_notice'
  ])
});

// These intents existed before email was restricted to account, security,
// billing, legal and critical platform events. Keep their serialized values
// blocked explicitly so jobs already waiting in Redis are acknowledged without
// being delivered or retried after a deployment.
const DISABLED_EMAIL_INTENTS = new Set([
  'creator_status',
  'host_status',
  'tournament_registration_prize',
  'recruitment_status',
  'broadcast_explicit'
]);

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
  'call',
  'random_connect',
  'presence',
  'recommendation',
  'feed_activity',
  'friend_suggestion'
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
    tournament_update: 'tournament',
    tournament_match_update: 'tournament',
    tournament_activity: 'tournament',
    match_update: 'tournament',
    match_result: 'tournament',
    recruitment_application: 'recruitment',
    recruitment_invitation: 'recruitment',
    recruitment_application_status: 'recruitment',
    recruitment_application_accepted: 'recruitment',
    recruitment_application_rejected: 'recruitment',
    recruitment_accepted: 'recruitment',
    recruitment_rejected: 'recruitment',
    recruitment_update: 'recruitment',
    messages: 'message',
    new_message: 'message',
    direct_message: 'message',
    voice_message: 'message',
    audio_message: 'message',
    media_message: 'message',
    image_message: 'message',
    video_message: 'message',
    group_message: 'message',
    shared_post_message: 'message',
    shared_clip_message: 'message',
    story_view: 'story',
    story_views: 'story',
    story_reaction: 'story',
    story_reply: 'story',
    clip_comment: 'clip',
    clip_view: 'clip',
    clip_views: 'clip',
    random_connect_match: 'random_connect',
    random_connect_match_found: 'random_connect',
    random_connect_session_update: 'random_connect',
    random_connect_session_started: 'random_connect',
    random_connect_session_ended: 'random_connect',
    presence_update: 'presence',
    presence_updates: 'presence',
    recommendations: 'recommendation',
    user_recommendation: 'recommendation',
    friend_suggestions: 'friend_suggestion',
    engagement: 'feed_activity',
    general_engagement: 'feed_activity'
  };
  if (aliases[normalized]) return aliases[normalized];

  // Event names evolve (for example `post_comment_created` or
  // `recruitment_application_withdrawn`). Recognize engagement families by
  // complete underscore-delimited tokens so new variants fail closed without
  // substring-matching unrelated transactional names.
  const familyByToken = {
    like: 'like',
    likes: 'like',
    liked: 'like',
    comment: 'comment',
    comments: 'comment',
    reply: 'comment',
    replies: 'comment',
    follow: 'follow',
    follows: 'follow',
    follower: 'follow',
    followers: 'follow',
    share: 'share',
    shares: 'share',
    shared: 'share',
    mention: 'mention',
    mentions: 'mention',
    tag: 'tag',
    tags: 'tag',
    tagged: 'tag',
    reaction: 'reaction',
    reactions: 'reaction',
    save: 'save',
    saves: 'save',
    saved: 'save',
    message: 'message',
    messages: 'message',
    story: 'story',
    stories: 'story',
    clip: 'clip',
    clips: 'clip',
    tournament: 'tournament',
    tournaments: 'tournament',
    recruitment: 'recruitment',
    call: 'call',
    calls: 'call'
  };
  for (const token of normalized.split('_')) {
    if (familyByToken[token]) return familyByToken[token];
  }
  if (normalized.startsWith('random_connect_') || normalized === 'random_connect') return 'random_connect';
  return normalized;
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

const getEmailEventType = (input = {}) => normalizeValue(
  input.eventType ||
  input.emailEventType ||
  input.email?.eventType ||
  input.notification?.emailEventType ||
  input.notification?.email?.eventType ||
  input.notification?.data?.customData?.emailEventType
);

const evaluateEmailPolicy = (input = {}) => {
  const intent = getEmailIntent(input);
  const eventType = getEmailEventType(input);
  const routineEventType = getRoutineEngagementEvent(input);

  if (routineEventType) {
    return { allowed: false, intent, eventType, routineEventType, reason: 'routine_engagement_email_blocked' };
  }

  if (DISABLED_EMAIL_INTENTS.has(intent)) {
    return { allowed: false, intent, eventType, routineEventType: null, reason: 'email_intent_disabled_by_policy' };
  }

  if (!ALLOWED_EMAIL_INTENTS.has(intent)) {
    return { allowed: false, intent, eventType, routineEventType: null, reason: 'missing_or_invalid_email_intent' };
  }

  if (!eventType) {
    return { allowed: false, intent, eventType, routineEventType: null, reason: 'missing_or_invalid_email_event' };
  }

  const allowedEvents = ALLOWED_EMAIL_EVENTS[intent];
  if (!allowedEvents?.includes(eventType)) {
    return { allowed: false, intent, eventType, routineEventType: null, reason: 'email_event_not_allowed_for_intent' };
  }

  return { allowed: true, intent, eventType, routineEventType: null, reason: 'explicit_transactional_event' };
};

const evaluateNotificationEmailPolicy = (notification, context = {}) => evaluateEmailPolicy({
  ...context,
  notification,
  intent: context.intent || notification?.email?.intent || notification?.emailIntent,
  eventType: context.eventType || notification?.email?.eventType || notification?.emailEventType
});

module.exports = {
  EMAIL_INTENTS,
  ALLOWED_EMAIL_EVENTS,
  DISABLED_EMAIL_INTENTS,
  ROUTINE_ENGAGEMENT_EVENTS,
  normalizeRoutineEvent,
  getRoutineEngagementEvent,
  getEmailIntent,
  getEmailEventType,
  evaluateEmailPolicy,
  evaluateNotificationEmailPolicy
};
