const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const Broadcast = require('../models/Broadcast');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const BroadcastEvent = require('../models/BroadcastEvent');
const BroadcastChunk = require('../models/BroadcastChunk');
const BroadcastPushReceipt = require('../models/BroadcastPushReceipt');
const BroadcastOccurrence = require('../models/BroadcastOccurrence');
const NotificationFailure = require('../models/NotificationFailure');
const Notification = require('../models/Notification');
const User = require('../models/User');
const log = require('../utils/logger');

const DELIVERY_TYPES = new Set(['push', 'in_app', 'both']);
const PRIORITIES = new Set(['normal', 'high', 'critical']);
const CATEGORIES = new Set([
  'announcement', 'update', 'maintenance', 'feature_release', 'tournament',
  'recruitment', 'promotion', 'creator', 'premium', 'system', 'custom'
]);
const CTA_TYPES = new Set([
  'none', 'home', 'profile', 'tournament', 'recruitment', 'clip', 'post', 'story',
  'random_connect', 'premium', 'creator_monetization', 'host_verification', 'custom'
]);
const SCHEDULE_MODES = new Set(['draft', 'immediate', 'scheduled']);
const RECURRENCES = new Set(['once', 'daily', 'weekly', 'monthly', 'yearly']);
const USER_TYPES = new Set(['player', 'team', 'creator']);
const PLATFORMS = new Set(['android', 'ios', 'web']);
const MONETIZATION_STATUSES = new Set([
  'not_eligible', 'eligible', 'pending', 'approved', 'rejected', 'suspended', 'disabled', 'withdrawn'
]);
const PREMIUM_PLANS = new Set(['free', 'player_pro', 'player_pro_plus', 'team_pro', 'team_org']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RECIPIENT_CHUNK_SIZE = Math.max(25, Math.min(500, Number(process.env.BROADCAST_CHUNK_SIZE || 100)));
const DELIVERY_CONCURRENCY = Math.max(1, Math.min(25, Number(process.env.BROADCAST_DELIVERY_CONCURRENCY || 10)));
const PROCESSING_LEASE_MS = 15 * 60 * 1000;
const METRICS_REFRESH_LOCK_MS = Math.max(10000, Number(process.env.BROADCAST_METRICS_LOCK_MS || 60000));
const METRICS_REFRESH_MAX_ROUNDS = Math.max(
  1,
  Math.min(10, Number(process.env.BROADCAST_METRICS_MAX_ROUNDS || 3))
);
const BROADCAST_DISPATCH_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(100, Number(process.env.BROADCAST_DISPATCH_MAX_ATTEMPTS || 12))
);
const WEB_PUSH_ACK_TIMEOUT_MS = Math.max(
  30000,
  Math.min(24 * 60 * 60 * 1000, Number(process.env.BROADCAST_WEB_PUSH_ACK_TIMEOUT_MS || 10 * 60 * 1000))
);
const CLIENT_CONTEXT_MAX_AGE_DAYS = Math.max(
  1,
  Math.min(3650, Number(process.env.BROADCAST_CLIENT_CONTEXT_MAX_AGE_DAYS || 90))
);

const fail = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const safeString = (value, maxLength, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength);
};

const assertStringLength = (value, maxLength, fieldName) => {
  if (typeof value === 'string' && value.trim().length > maxLength) {
    throw fail(`${fieldName} cannot exceed ${maxLength} characters`);
  }
};

const uniqueStrings = (value, maxLength = 100) => {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return Array.from(new Set(values
    .map((entry) => safeString(entry, maxLength))
    .filter(Boolean)));
};

const getClientContextCutoff = (now = new Date()) => new Date(
  new Date(now).getTime() - (CLIENT_CONTEXT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
);

const isRecentClientDate = (value, cutoff = getClientContextCutoff()) => {
  const date = value ? new Date(value) : null;
  return Boolean(date && !Number.isNaN(date.getTime()) && date >= cutoff);
};

const getMatchedNotificationClients = (user, audience = {}, now = new Date()) => {
  const platforms = new Set(Array.isArray(audience.platforms) ? audience.platforms : []);
  const appVersions = new Set(Array.isArray(audience.appVersions) ? audience.appVersions : []);
  const cutoff = getClientContextCutoff(now);
  return (user?.notificationClients || []).filter((client) =>
    isRecentClientDate(client?.lastSeenAt, cutoff) &&
    (platforms.size === 0 || platforms.has(client.platform)) &&
    (appVersions.size === 0 || appVersions.has(client.appVersion))
  );
};

const getMatchedRecipientPlatforms = (user, audience = {}, now = new Date()) => {
  const platforms = new Set(Array.isArray(audience.platforms) ? audience.platforms : []);
  const appVersions = new Set(Array.isArray(audience.appVersions) ? audience.appVersions : []);
  const cutoff = getClientContextCutoff(now);
  const tokenPlatforms = (user?.pushTokens || [])
    .filter((token) =>
      isRecentClientDate(token?.lastUsedAt || token?.createdAt, cutoff) &&
      (platforms.size === 0 || platforms.has(token.platform)) &&
      (appVersions.size === 0 || appVersions.has(token.appVersion))
    )
    .map((token) => token.platform);
  return Array.from(new Set([
    ...tokenPlatforms,
    ...getMatchedNotificationClients(user, audience, now).map((client) => client.platform)
  ].filter(Boolean)));
};

const deriveCountry = (profile = {}) => {
  const structured = safeString(profile.country, 100);
  if (structured) return structured;
  const location = safeString(profile.location, 300);
  if (!location) return '';
  const parts = location.split(',').map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] || location;
};

const createOccurrenceSnapshot = (broadcast) => ({
  title: broadcast.title,
  message: broadcast.message,
  subtitle: broadcast.subtitle || '',
  bannerImage: broadcast.bannerImage || '',
  thumbnail: broadcast.thumbnail || '',
  cta: broadcast.cta?.toObject ? broadcast.cta.toObject() : (broadcast.cta || {}),
  priority: broadcast.priority,
  category: broadcast.category,
  customCategory: broadcast.customCategory || '',
  deliveryType: broadcast.deliveryType,
  push: broadcast.push?.toObject ? broadcast.push.toObject() : (broadcast.push || {}),
  audience: broadcast.audience?.toObject ? broadcast.audience.toObject() : (broadcast.audience || {})
});

const enumStrings = (value, allowed, fieldName) => {
  const values = uniqueStrings(value, 100);
  const invalid = values.find((entry) => !allowed.has(entry));
  if (invalid) throw fail(`${fieldName} contains an unsupported value: ${invalid}`);
  return values;
};

const enumValue = (value, allowed, fieldName, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw fail(`${fieldName} must be one of: ${Array.from(allowed).join(', ')}`);
  }
  return value;
};

const normalizeEmails = (value) => {
  const emails = Array.from(new Set(uniqueStrings(value, 254).map((email) => email.toLowerCase())));
  for (const email of emails) {
    if (!EMAIL_PATTERN.test(email)) throw fail(`Invalid audience email: ${email}`);
  }
  return emails;
};

const isBroadcastCategoryAllowed = (settings = {}, category = 'announcement') => {
  if (category === 'system' && settings.systemAlerts === false) return false;
  if (Array.isArray(settings.mutedBroadcastCategories) && settings.mutedBroadcastCategories.includes(category)) {
    return false;
  }
  if (['announcement', 'update', 'feature_release'].includes(category) && settings.announcementsEnabled === false) {
    return false;
  }
  if (category === 'promotion' && settings.promotionsEnabled === false) return false;
  if (['promotion', 'premium'].includes(category) && settings.marketingEnabled === false) return false;
  return true;
};

const optionalDate = (value, fieldName) => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw fail(`${fieldName} must be a valid date`);
  return date;
};

const optionalDateBound = (value, fieldName, endOfDay = false) => {
  const date = optionalDate(value, fieldName);
  if (date && endOfDay && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return date;
};

const optionalNumber = (value, fieldName) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    throw fail(`${fieldName} must be a non-negative integer`);
  }
  return parsed;
};

const isSafeNavigationUrl = (value) => {
  if (!value) return true;
  if (/[\u0000-\u001f\u007f\\]/.test(value) || /%(?:2f|5c)/i.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    const parsed = new URL(value);
    const allowedProtocols = new Set(['https:', 'squadhunt:', 'arc:', 'arcmobile:', 'com.arcsquadhunt:']);
    return allowedProtocols.has(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      (parsed.protocol !== 'https:' || Boolean(parsed.hostname));
  } catch {
    return false;
  }
};

const isSafeHttpsUrl = (value) => {
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && Boolean(parsed.hostname) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
};

const assertTimezone = (value, fieldName = 'schedule.timezone') => {
  const timezone = safeString(value, 100, 'UTC') || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw fail(`${fieldName} must be a valid IANA timezone`);
  }
  return timezone;
};

const normalizeAudience = (raw = {}, { allowIncomplete = false } = {}) => {
  const input = raw && typeof raw === 'object' ? raw : {};
  if (input.allUsers === true) {
    return {
      allUsers: true,
      userTypes: [],
      premium: 'all',
      verifiedHost: 'all',
      creatorMonetizationStatuses: [],
      countries: [],
      states: [],
      cities: [],
      platforms: [],
      appVersions: [],
      lastActiveFrom: null,
      lastActiveTo: null,
      joinedFrom: null,
      joinedTo: null,
      followersMin: null,
      followersMax: null,
      premiumPlans: [],
      userIds: [],
      usernames: [],
      emails: []
    };
  }
  const accountTypes = uniqueStrings(input.userTypes || input.accountTypes, 40).map((type) => {
    if (type === 'individual' || type === 'user' || type === 'individual_user') return 'player';
    if (type === 'teams' || type === 'team_account') return 'team';
    return type;
  });
  let userTypes = enumStrings(accountTypes, USER_TYPES, 'audience.accountTypes');
  if (input.individualUsers === true && !userTypes.includes('player')) userTypes.push('player');
  if (input.teamAccounts === true && !userTypes.includes('team')) userTypes.push('team');
  // Creator accounts are individual profiles in product semantics.
  if (userTypes.includes('player') && !userTypes.includes('creator')) userTypes.push('creator');

  let premium = enumValue(
    input.premium,
    new Set(['all', 'premium', 'non_premium']),
    'audience.premium',
    'all'
  );
  if (input.premiumUsers === true && input.nonPremiumUsers !== true) premium = 'premium';
  if (input.nonPremiumUsers === true && input.premiumUsers !== true) premium = 'non_premium';

  let verifiedHost = enumValue(
    input.verifiedHost,
    new Set(['all', 'verified', 'unverified']),
    'audience.verifiedHost',
    'all'
  );
  if (input.hostVerification !== undefined && input.hostVerification !== null && input.hostVerification !== '') {
    verifiedHost = enumValue(
      input.hostVerification,
      new Set(['all', 'verified', 'unverified']),
      'audience.hostVerification',
      'all'
    );
  }
  if (input.verifiedHosts === true && input.nonVerifiedHosts !== true) verifiedHost = 'verified';
  if (input.nonVerifiedHosts === true && input.verifiedHosts !== true) verifiedHost = 'unverified';

  let creatorMonetizationStatuses = enumStrings(
    input.creatorMonetizationStatuses || input.creatorStatuses,
    MONETIZATION_STATUSES,
    'audience.creatorMonetizationStatuses'
  );
  const creatorMonetization = enumValue(
    input.creatorMonetization,
    new Set(['all', 'enabled', 'pending']),
    'audience.creatorMonetization',
    'all'
  );
  if (input.creatorMonetizationEnabled === true && !creatorMonetizationStatuses.includes('approved')) {
    creatorMonetizationStatuses.push('approved');
  }
  if (input.creatorMonetizationPending === true && !creatorMonetizationStatuses.includes('pending')) {
    creatorMonetizationStatuses.push('pending');
  }
  if (creatorMonetization === 'enabled' && !creatorMonetizationStatuses.includes('approved')) {
    creatorMonetizationStatuses.push('approved');
  }
  if (creatorMonetization === 'pending' && !creatorMonetizationStatuses.includes('pending')) {
    creatorMonetizationStatuses.push('pending');
  }

  const rawIds = Array.isArray(input.userIds) ? input.userIds : (input.customUserIds || []);
  const userIds = Array.from(new Set((Array.isArray(rawIds) ? rawIds : [rawIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean))).map((id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) throw fail(`Invalid custom user ID: ${id}`);
    return new mongoose.Types.ObjectId(id);
  });

  const lastActive = input.lastActive && typeof input.lastActive === 'object' ? input.lastActive : {};
  const joinedBetween = input.joinedBetween && typeof input.joinedBetween === 'object' ? input.joinedBetween : {};
  const followers = input.followersRange && typeof input.followersRange === 'object' ? input.followersRange : {};

  const result = {
    allUsers: input.allUsers === true,
    userTypes,
    premium,
    verifiedHost,
    creatorMonetizationStatuses,
    countries: uniqueStrings(input.countries || input.country, 100),
    states: uniqueStrings(input.states || input.state, 100),
    cities: uniqueStrings(input.cities || input.city, 100),
    platforms: enumStrings(input.platforms || input.platform, PLATFORMS, 'audience.platforms'),
    appVersions: uniqueStrings(input.appVersions || input.appVersion, 40),
    lastActiveFrom: optionalDateBound(input.lastActiveFrom ?? lastActive.from ?? input.lastActiveDate, 'lastActiveFrom'),
    lastActiveTo: optionalDateBound(input.lastActiveTo ?? lastActive.to, 'lastActiveTo', true),
    joinedFrom: optionalDateBound(input.joinedFrom ?? joinedBetween.from ?? joinedBetween.start, 'joinedFrom'),
    joinedTo: optionalDateBound(input.joinedTo ?? joinedBetween.to ?? joinedBetween.end, 'joinedTo', true),
    followersMin: optionalNumber(input.followersMin ?? followers.min, 'followersMin'),
    followersMax: optionalNumber(input.followersMax ?? followers.max, 'followersMax'),
    premiumPlans: enumStrings(input.premiumPlans || input.premiumPlan, PREMIUM_PLANS, 'audience.premiumPlans'),
    userIds,
    usernames: uniqueStrings(input.usernames || input.customUsernames, 20),
    emails: normalizeEmails(input.emails || input.customEmails)
  };

  if (result.lastActiveFrom && result.lastActiveTo && result.lastActiveFrom > result.lastActiveTo) {
    throw fail('lastActiveFrom cannot be after lastActiveTo');
  }
  if (result.joinedFrom && result.joinedTo && result.joinedFrom > result.joinedTo) {
    throw fail('joinedFrom cannot be after joinedTo');
  }
  if (result.followersMin !== null && result.followersMax !== null && result.followersMin > result.followersMax) {
    throw fail('followersMin cannot be greater than followersMax');
  }
  const hasFilter = result.userTypes.length > 0 || result.premium !== 'all' ||
    result.verifiedHost !== 'all' || result.creatorMonetizationStatuses.length > 0 ||
    result.countries.length > 0 || result.states.length > 0 || result.cities.length > 0 ||
    result.platforms.length > 0 || result.appVersions.length > 0 ||
    Boolean(result.lastActiveFrom || result.lastActiveTo || result.joinedFrom || result.joinedTo) ||
    result.followersMin !== null || result.followersMax !== null || result.premiumPlans.length > 0 ||
    result.userIds.length > 0 || result.usernames.length > 0 || result.emails.length > 0;
  if (!allowIncomplete && !result.allUsers && !hasFilter) {
    throw fail('Audience must explicitly select allUsers or include at least one targeting filter');
  }
  return result;
};

const normalizeSchedule = (raw = {}, { allowIncomplete = false } = {}) => {
  const input = raw && typeof raw === 'object' ? raw : {};
  const mode = enumValue(input.mode, SCHEDULE_MODES, 'schedule.mode', 'draft');
  if (input.recurrence !== undefined && input.recurrence !== null &&
      typeof input.recurrence !== 'string' &&
      (typeof input.recurrence !== 'object' || Array.isArray(input.recurrence))) {
    throw fail('schedule.recurrence must be a recurrence name or object');
  }
  const recurrenceInput = input.recurrence && typeof input.recurrence === 'object' ? input.recurrence : {};
  const recurrenceValue = typeof input.recurrence === 'string'
    ? input.recurrence
    : (recurrenceInput.frequency || 'once');
  const recurrence = enumValue(recurrenceValue, RECURRENCES, 'schedule.recurrence.frequency', 'once');
  const rawRecurrenceInterval = optionalNumber(
    input.recurrenceInterval ?? recurrenceInput.interval,
    'schedule.recurrence.interval'
  );
  const recurrenceInterval = rawRecurrenceInterval ?? 1;
  if (recurrenceInterval < 1 || recurrenceInterval > 365) {
    throw fail('schedule.recurrence.interval must be between 1 and 365');
  }
  const scheduledAt = optionalDate(input.scheduledAt ?? input.sendAt, 'schedule.scheduledAt');
  const recurrenceEndAt = optionalDate(
    input.recurrenceEndAt ?? recurrenceInput.endAt,
    'schedule.recurrenceEndAt'
  );
  if (!allowIncomplete && mode === 'scheduled' && !scheduledAt) {
    throw fail('schedule.scheduledAt is required for scheduled broadcasts');
  }
  if (recurrence === 'once' && recurrenceEndAt) {
    throw fail('schedule.recurrence.endAt is only valid for recurring broadcasts');
  }
  if (recurrenceEndAt && scheduledAt && recurrenceEndAt <= scheduledAt) {
    throw fail('schedule.recurrenceEndAt must be after schedule.scheduledAt');
  }
  return {
    mode,
    scheduledAt,
    timezone: assertTimezone(input.timezone),
    recurrence,
    recurrenceInterval,
    recurrenceEndAt,
    nextRunAt: mode === 'scheduled' ? scheduledAt : null
  };
};

const normalizeBroadcastPayload = (raw = {}, { partial = false, allowIncomplete = false } = {}) => {
  const input = raw && typeof raw === 'object' ? raw : {};
  const result = {};

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'title')) {
    assertStringLength(input.title, 100, 'Title');
    result.title = safeString(input.title, 100);
    if (!allowIncomplete && !result.title) throw fail('Title is required');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'message')) {
    assertStringLength(input.message, 1000, 'Message');
    result.message = safeString(input.message, 1000);
    if (!allowIncomplete && !result.message) throw fail('Message is required');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'subtitle')) {
    assertStringLength(input.subtitle, 160, 'Subtitle');
    result.subtitle = safeString(input.subtitle, 160);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'bannerImage')) {
    assertStringLength(input.bannerImage, 2048, 'Banner image URL');
    result.bannerImage = safeString(input.bannerImage, 2048);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'thumbnail')) {
    assertStringLength(input.thumbnail, 2048, 'Thumbnail URL');
    result.thumbnail = safeString(input.thumbnail, 2048);
  }
  if (result.bannerImage && !isSafeHttpsUrl(result.bannerImage)) throw fail('Banner image must use a valid HTTPS URL');
  if (result.thumbnail && !isSafeHttpsUrl(result.thumbnail)) throw fail('Thumbnail must use a valid HTTPS URL');

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'cta')) {
    const cta = input.cta && typeof input.cta === 'object' ? input.cta : {};
    assertStringLength(cta.url, 2048, 'CTA URL');
    assertStringLength(cta.deepLink, 2048, 'CTA deep link');
    assertStringLength(cta.text, 60, 'CTA text');
    assertStringLength(cta.buttonText, 60, 'CTA button text');
    const explicitUrl = safeString(cta.url, 2048);
    const explicitDeepLink = safeString(cta.deepLink, 2048);
    if (!isSafeNavigationUrl(explicitUrl)) throw fail('CTA URL is invalid');
    if (!isSafeNavigationUrl(explicitDeepLink)) throw fail('CTA deep link is invalid');
    // Keep the legacy single-destination contract working while allowing Web
    // and native clients to receive purpose-built destinations.
    const url = explicitUrl || explicitDeepLink;
    const deepLink = explicitDeepLink || explicitUrl;
    const ctaType = enumValue(cta.type, CTA_TYPES, 'cta.type', (url || deepLink) ? 'custom' : 'none');
    result.cta = {
      text: safeString(cta.text, 60) || safeString(cta.buttonText, 60),
      url,
      deepLink,
      type: ctaType
    };
    const urlRequiredTypes = new Set(['profile', 'tournament', 'recruitment', 'clip', 'post', 'story', 'custom']);
    if (!allowIncomplete && (
      (result.cta.type === 'none' && result.cta.text) ||
      (urlRequiredTypes.has(result.cta.type) && !url && !deepLink)
    )) {
      throw fail('CTA destination is required for the selected deep-link type');
    }
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'priority')) {
    result.priority = enumValue(input.priority, PRIORITIES, 'priority', 'normal');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'category')) {
    result.category = enumValue(input.category, CATEGORIES, 'category', 'announcement');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'customCategory')) {
    assertStringLength(input.customCategory, 60, 'Custom category');
    result.customCategory = safeString(input.customCategory, 60);
  }
  if (!allowIncomplete && result.category === 'custom' && !result.customCategory &&
      (!partial || Object.prototype.hasOwnProperty.call(input, 'customCategory'))) {
    throw fail('Custom category is required when category is custom');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'deliveryType')) {
    result.deliveryType = enumValue(input.deliveryType, DELIVERY_TYPES, 'deliveryType', 'both');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'push')) {
    const push = input.push && typeof input.push === 'object' ? input.push : {};
    assertStringLength(push.sound, 100, 'Push sound');
    assertStringLength(push.collapseKey, 100, 'Push collapse key');
    const badge = optionalNumber(push.badge ?? push.badgeCount, 'push.badge');
    const ttl = optionalNumber(push.ttl, 'push.ttl') ?? 2419200;
    if (badge !== null && badge > 9999) throw fail('push.badge cannot exceed 9999');
    if (ttl > 2419200) throw fail('push.ttl cannot exceed 2419200 seconds');
    result.push = {
      badge,
      sound: safeString(push.sound, 100, 'default') || 'default',
      ttl,
      collapseKey: safeString(push.collapseKey, 100)
    };
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'audience')) {
    result.audience = normalizeAudience(input.audience, { allowIncomplete });
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'schedule')) {
    result.schedule = normalizeSchedule(input.schedule, { allowIncomplete });
  }
  return result;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildAudienceQuery = (rawAudience = {}) => {
  // Always re-normalize at the query boundary. This prevents a malformed or
  // legacy persisted audience from silently broadening to every active user.
  const audience = normalizeAudience(rawAudience);
  const query = {
    isActive: true,
    userType: { $ne: 'admin' },
    needsProfileCompletion: { $ne: true },
    moderationStatus: { $nin: ['banned', 'soft_deleted'] }
  };
  const clauses = [];

  if (audience.userTypes?.length) query.userType = { $in: audience.userTypes };
  if (audience.premium === 'premium') query.isPremium = true;
  if (audience.premium === 'non_premium') query.isPremium = { $ne: true };
  if (audience.verifiedHost === 'verified') query.isVerifiedHost = true;
  if (audience.verifiedHost === 'unverified') query.isVerifiedHost = { $ne: true };
  if (audience.creatorMonetizationStatuses?.length) {
    query.creatorMonetizationStatus = { $in: audience.creatorMonetizationStatuses };
  }
  if (audience.premiumPlans?.length) query['membership.tier'] = { $in: audience.premiumPlans };

  const customSelectors = [];
  if (audience.userIds?.length) customSelectors.push({ _id: { $in: audience.userIds } });
  if (audience.usernames?.length) {
    customSelectors.push({
      username: {
        $in: audience.usernames.map((username) => new RegExp(`^${escapeRegex(username)}$`, 'i'))
      }
    });
  }
  if (audience.emails?.length) {
    // User.email is normalized to lowercase and uniquely indexed by the User
    // schema, so exact matching stays case-insensitive without regex scans.
    customSelectors.push({ email: { $in: audience.emails } });
  }
  if (customSelectors.length === 1) clauses.push(customSelectors[0]);
  if (customSelectors.length > 1) clauses.push({ $or: customSelectors });

  for (const values of [audience.countries, audience.states, audience.cities]) {
    if (values?.length) {
      clauses.push({
        $or: values.map((value) => ({
          'profile.location': {
            $regex: `(?:^|[\\s,])${escapeRegex(value)}(?=$|[\\s,])`,
            $options: 'i'
          }
        }))
      });
    }
  }

  if (audience.lastActiveFrom || audience.lastActiveTo) {
    query.lastSeen = {};
    if (audience.lastActiveFrom) query.lastSeen.$gte = audience.lastActiveFrom;
    if (audience.lastActiveTo) query.lastSeen.$lte = audience.lastActiveTo;
  }
  if (audience.joinedFrom || audience.joinedTo) {
    query.createdAt = {};
    if (audience.joinedFrom) query.createdAt.$gte = audience.joinedFrom;
    if (audience.joinedTo) query.createdAt.$lte = audience.joinedTo;
  }

  if (audience.followersMin !== null || audience.followersMax !== null) {
    const comparisons = [];
    const followerCount = { $size: { $ifNull: ['$followers', []] } };
    if (audience.followersMin !== null) comparisons.push({ $gte: [followerCount, audience.followersMin] });
    if (audience.followersMax !== null) comparisons.push({ $lte: [followerCount, audience.followersMax] });
    clauses.push({ $expr: comparisons.length === 1 ? comparisons[0] : { $and: comparisons } });
  }

  if (audience.platforms?.length || audience.appVersions?.length) {
    const cutoff = getClientContextCutoff();
    const tokenMatch = { lastUsedAt: { $gte: cutoff } };
    const clientMatch = { lastSeenAt: { $gte: cutoff } };
    if (audience.platforms?.length) {
      tokenMatch.platform = { $in: audience.platforms };
      clientMatch.platform = { $in: audience.platforms };
    }
    if (audience.appVersions?.length) {
      tokenMatch.appVersion = { $in: audience.appVersions };
      clientMatch.appVersion = { $in: audience.appVersions };
    }
    clauses.push({
      $or: [
        { pushTokens: { $elemMatch: tokenMatch } },
        { notificationClients: { $elemMatch: clientMatch } }
      ]
    });
  }
  if (clauses.length) query.$and = clauses;
  return query;
};

const getActor = (user) => ({
  user: user?._id || null,
  username: safeString(user?.username, 100, 'admin') || 'admin',
  role: safeString(user?.adminRole, 100, user?.isSuperUser ? 'super_admin' : 'admin')
});

const getZonedParts = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
};

const wallTimeValue = (parts) => Date.UTC(
  parts.year,
  parts.month - 1,
  parts.day,
  parts.hour || 0,
  parts.minute || 0,
  parts.second || 0,
  parts.millisecond || 0
);

const sameWallTime = (left, right) => (
  left.year === right.year &&
  left.month === right.month &&
  left.day === right.day &&
  (left.hour || 0) === (right.hour || 0) &&
  (left.minute || 0) === (right.minute || 0) &&
  (left.second || 0) === (right.second || 0)
);

const zonedPartsToDate = (parts, timezone) => {
  const desiredWallTime = wallTimeValue(parts);
  // Timezone offsets around the requested wall date are sufficient to derive
  // every exact instant, including both sides of a DST transition.
  const offsets = new Set();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = new Date(desiredWallTime + (hours * 60 * 60 * 1000));
    offsets.add(wallTimeValue(getZonedParts(sample, timezone)) - sample.getTime());
  }
  const candidates = Array.from(offsets).map((offset) => {
    const candidate = new Date(desiredWallTime - offset);
    return { candidate, actual: getZonedParts(candidate, timezone) };
  });
  const exact = candidates
    .filter(({ actual }) => sameWallTime(actual, parts))
    .sort((left, right) => left.candidate - right.candidate);
  // During a repeated wall time, consistently choose its first occurrence.
  if (exact.length) return exact[0].candidate;

  // A nonexistent DST-gap wall time is moved forward by the size of the gap
  // (for example 02:30 -> 03:30), matching "later" disambiguation semantics.
  const later = candidates
    .map((entry) => ({ ...entry, wallDelta: wallTimeValue(entry.actual) - desiredWallTime }))
    .filter((entry) => entry.wallDelta > 0)
    .sort((left, right) => left.wallDelta - right.wallDelta || left.candidate - right.candidate);
  if (later.length) return later[0].candidate;
  throw fail(`Unable to resolve wall time in timezone ${timezone}`);
};

const nextRecurrenceDate = (currentValue, recurrence, interval = 1, timezone = 'UTC') => {
  const current = new Date(currentValue);
  const safeInterval = Math.max(1, Math.floor(Number(interval) || 1));
  const zoned = getZonedParts(current, timezone);
  const wallCalendar = new Date(Date.UTC(
    zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second
  ));
  if (recurrence === 'daily') wallCalendar.setUTCDate(wallCalendar.getUTCDate() + safeInterval);
  if (recurrence === 'weekly') wallCalendar.setUTCDate(wallCalendar.getUTCDate() + (7 * safeInterval));
  if (recurrence === 'monthly') {
    const targetMonthIndex = zoned.year * 12 + (zoned.month - 1) + safeInterval;
    const targetYear = Math.floor(targetMonthIndex / 12);
    const targetMonth = targetMonthIndex % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    wallCalendar.setUTCFullYear(targetYear, targetMonth, Math.min(zoned.day, lastDay));
  }
  if (recurrence === 'yearly') {
    const targetYear = zoned.year + safeInterval;
    const lastDay = new Date(Date.UTC(targetYear, zoned.month, 0)).getUTCDate();
    wallCalendar.setUTCFullYear(targetYear, zoned.month - 1, Math.min(zoned.day, lastDay));
  }
  return zonedPartsToDate({
    year: wallCalendar.getUTCFullYear(),
    month: wallCalendar.getUTCMonth() + 1,
    day: wallCalendar.getUTCDate(),
    hour: wallCalendar.getUTCHours(),
    minute: wallCalendar.getUTCMinutes(),
    second: wallCalendar.getUTCSeconds()
  }, timezone);
};

const getTimezoneDayBounds = (timezoneValue = 'UTC', nowValue = new Date()) => {
  const timezone = assertTimezone(timezoneValue, 'timezone');
  const now = new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw fail('now must be a valid date');
  const zoned = getZonedParts(now, timezone);
  const start = zonedPartsToDate({
    year: zoned.year, month: zoned.month, day: zoned.day,
    hour: 0, minute: 0, second: 0, millisecond: 0
  }, timezone);
  const nextWallDay = new Date(Date.UTC(zoned.year, zoned.month - 1, zoned.day + 1));
  const end = zonedPartsToDate({
    year: nextWallDay.getUTCFullYear(),
    month: nextWallDay.getUTCMonth() + 1,
    day: nextWallDay.getUTCDate(),
    hour: 0, minute: 0, second: 0, millisecond: 0
  }, timezone);
  return { timezone, start, end };
};

const createOccurrenceKey = (date = new Date()) => new Date(date).toISOString().replace(/[:.]/g, '-');

const mapWithConcurrency = async (items, concurrency, handler) => {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await handler(items[index], index);
    }
  });
  await Promise.all(workers);
};

const resolveOverallStatus = (pushStatus, inAppStatus) => {
  const statuses = [pushStatus, inAppStatus].filter((status) => status && status !== 'pending');
  const delivered = statuses.filter((status) => status === 'delivered').length;
  const failed = statuses.filter((status) => status === 'failed').length;
  const processing = statuses.some((status) => status === 'processing');
  if (delivered && (failed || processing || statuses.some((status) => status === 'skipped'))) return 'partial';
  if (delivered) return 'delivered';
  if (processing) return 'processing';
  if (failed) return 'failed';
  return 'skipped';
};

const resolveEffectiveDeliveryType = ({ push, inApp }) => {
  if (push && inApp) return 'both';
  if (push) return 'push';
  return 'in_app';
};

const resolvePushDeliveryStatus = (result = {}) => {
  if ((result.sent || 0) === 0) return 'skipped';
  if ((result.receiptOk || 0) > 0) return 'delivered';
  if ((result.receiptFailed || 0) > 0) return 'failed';
  if ((result.accepted || 0) > 0) return 'delivered';
  return 'failed';
};

const resolveBroadcastDeepLink = (cta = {}) => {
  if (cta.deepLink) return cta.deepLink;
  if (cta.url) return cta.url;
  const destinations = {
    home: '/',
    random_connect: '/random-connect',
    premium: '/premium',
    creator_monetization: '/profile/creator-monetization',
    host_verification: '/host-verification'
  };
  return destinations[cta.type] || '/notifications';
};

const resolveBroadcastWebUrl = (cta = {}) => cta.url || cta.deepLink || resolveBroadcastDeepLink(cta);

const buildNotificationData = (broadcast, recipientLog, effectiveDeliveryType = broadcast.deliveryType) => ({
  broadcastId: broadcast._id,
  deliveryLogId: recipientLog._id,
  deepLink: resolveBroadcastDeepLink(broadcast.cta),
  deliveryType: effectiveDeliveryType,
  channels: {
    push: effectiveDeliveryType === 'push' || effectiveDeliveryType === 'both',
    inApp: effectiveDeliveryType === 'in_app' || effectiveDeliveryType === 'both'
  },
  targetPlatforms: Array.from(broadcast.audience?.platforms || []),
  targetAppVersions: Array.from(broadcast.audience?.appVersions || []),
  bannerImage: broadcast.bannerImage || '',
  thumbnail: broadcast.thumbnail || '',
  cta: {
    text: broadcast.cta?.text || '',
    url: broadcast.cta?.url || '',
    deepLink: broadcast.cta?.deepLink || broadcast.cta?.url || '',
    type: broadcast.cta?.type || 'none'
  },
  customData: {
    broadcastId: String(broadcast._id),
    deliveryLogId: String(recipientLog._id),
    deepLink: resolveBroadcastDeepLink(broadcast.cta),
    url: resolveBroadcastWebUrl(broadcast.cta),
    subtitle: broadcast.subtitle || '',
    bannerImage: broadcast.bannerImage || '',
    thumbnail: broadcast.thumbnail || '',
    cta: broadcast.cta || {},
    category: broadcast.category,
    priority: broadcast.priority,
    deliveryType: effectiveDeliveryType,
    channels: {
      push: effectiveDeliveryType === 'push' || effectiveDeliveryType === 'both',
      inApp: effectiveDeliveryType === 'in_app' || effectiveDeliveryType === 'both'
    },
    targetPlatforms: Array.from(broadcast.audience?.platforms || []),
    targetAppVersions: Array.from(broadcast.audience?.appVersions || []),
    clientContextMaxAgeDays: CLIENT_CONTEXT_MAX_AGE_DAYS,
    pushOptions: {
      badge: broadcast.push?.badge,
      sound: broadcast.push?.sound || 'default',
      ttl: broadcast.push?.ttl ?? 2419200,
      collapseKey: broadcast.push?.collapseKey || '',
      image: broadcast.bannerImage || broadcast.thumbnail || ''
    }
  }
});

const assertBroadcastPushPayloadSize = (broadcast) => {
  if (broadcast?.deliveryType === 'in_app') return 0;
  const { buildExpoMessages, getExpoMessageByteLength } = require('../utils/pushNotificationService');
  const syntheticBroadcast = {
    ...broadcast,
    _id: broadcast?._id || '000000000000000000000000'
  };
  const recipientLog = { _id: '000000000000000000000001' };
  const notification = {
    _id: '000000000000000000000002',
    type: 'system',
    title: syntheticBroadcast.title,
    message: syntheticBroadcast.message,
    data: buildNotificationData(syntheticBroadcast, recipientLog, syntheticBroadcast.deliveryType)
  };
  const tokenPrefix = 'ExponentPushToken[';
  const maxAcceptedToken = `${tokenPrefix}${'x'.repeat(512 - tokenPrefix.length - 1)}]`;
  const [message] = buildExpoMessages([
    { token: maxAcceptedToken }
  ], notification, 9999);
  return getExpoMessageByteLength(message);
};

const deliverToRecipient = async (broadcast, occurrenceKey, user, processingKey) => {
  const audience = broadcast.audience?.toObject ? broadcast.audience.toObject() : broadcast.audience;
  const uniqueKey = { broadcast: broadcast._id, recipient: user._id, occurrenceKey };
  let recipientLog = await BroadcastRecipient.findOneAndUpdate(
    uniqueKey,
    {
      $setOnInsert: {
        ...uniqueKey,
        recipientSnapshot: {
          username: user.username || '',
          displayName: user.profile?.displayName || '',
          userType: user.userType || '',
          isPremium: user.isPremium === true,
          premiumPlan: user.membership?.tier || 'free',
          location: user.profile?.location || '',
          country: deriveCountry(user.profile),
          platforms: getMatchedRecipientPlatforms(user, audience)
        },
        requestedDeliveryType: broadcast.deliveryType,
        overallStatus: 'pending'
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (['delivered', 'skipped'].includes(recipientLog.overallStatus)) return recipientLog;
  const leaseCutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
  recipientLog = await BroadcastRecipient.findOneAndUpdate(
    {
      _id: recipientLog._id,
      webPushAcknowledgedAt: null,
      $or: [
        { overallStatus: { $in: ['pending', 'partial', 'failed'] } },
        { overallStatus: 'processing', processingKey },
        { overallStatus: 'processing', processingLeaseAt: null },
        { overallStatus: 'processing', processingLeaseAt: { $lt: leaseCutoff } }
      ]
    },
    {
      $set: { overallStatus: 'processing', processingLeaseAt: new Date(), processingKey },
      $inc: { attempts: 1 }
    },
    { new: true }
  );
  if (!recipientLog) return null;

  const ensureOccurrenceActive = async () => {
    const active = await Broadcast.exists({
      _id: broadcast._id,
      status: 'processing',
      cancelledAt: null,
      'execution.occurrenceKey': occurrenceKey
    });
    if (active) return true;
    const latest = await BroadcastRecipient.findById(recipientLog._id).select('inApp').lean();
    const finalInAppStatus = ['delivered', 'failed'].includes(latest?.inApp?.status)
      ? latest.inApp.status
      : 'skipped';
    await BroadcastRecipient.updateOne(
      {
        _id: recipientLog._id,
        webPushAcknowledgedAt: null,
        overallStatus: { $in: ['pending', 'processing', 'partial', 'failed'] }
      },
      {
        $set: {
          overallStatus: resolveOverallStatus('skipped', finalInAppStatus),
          'push.status': 'skipped',
          'inApp.status': finalInAppStatus,
          processingLeaseAt: null,
          processingKey: '',
          lastError: 'Broadcast was cancelled before channel delivery'
        }
      }
    );
    return false;
  };
  if (!await ensureOccurrenceActive()) {
    return { ...recipientLog.toObject(), overallStatus: 'skipped', push: { status: 'skipped' }, inApp: { status: 'skipped' } };
  }

  const settings = user.notificationSettings || {};
  const categoryAllowed = isBroadcastCategoryAllowed(settings, broadcast.category);
  const pushAllowed = settings.pushEnabled !== false && categoryAllowed;
  const inAppAllowed = settings.inAppEnabled !== false && categoryAllowed;
  const pushRequested = broadcast.deliveryType === 'push' || broadcast.deliveryType === 'both';
  const { filterBroadcastTokens } = require('../utils/pushNotificationService');
  const eligiblePushTokens = pushRequested && pushAllowed
    ? filterBroadcastTokens(user, audience)
    : [];
  const matchedNotificationClients = pushRequested && pushAllowed
    ? getMatchedNotificationClients(user, audience)
    : [];
  const webPushAvailable = matchedNotificationClients.some((client) =>
    client.platform === 'web' &&
    client.notificationPermission === 'granted' &&
    client.browserNotificationsSupported === true
  );
  const nativePushAvailable = eligiblePushTokens.length > 0;
  const pushAvailable = pushAllowed && (nativePushAvailable || webPushAvailable);
  // Delivery type is an operator contract: an explicit push-only broadcast
  // must never materialize an inbox notification as an implicit fallback.
  const inAppRequested = broadcast.deliveryType === 'in_app' || broadcast.deliveryType === 'both';
  const effectiveDeliveryType = resolveEffectiveDeliveryType({
    push: pushRequested && pushAvailable,
    inApp: inAppRequested && inAppAllowed
  });

  let inAppStatus = inAppRequested ? (recipientLog.inApp?.status || 'pending') : 'skipped';
  let pushStatus = pushRequested ? (recipientLog.push?.status || 'pending') : 'skipped';
  let notification = recipientLog.notification
    ? await Notification.findById(recipientLog.notification)
    : null;
  const errors = [];

  if (inAppRequested) {
    if (inAppStatus === 'delivered') {
      // Preserve the successful channel while a failed peer channel retries.
    } else if (inAppAllowed) {
      try {
      if (!await ensureOccurrenceActive()) {
        return { ...recipientLog.toObject(), overallStatus: 'skipped', push: { status: 'skipped' }, inApp: { status: 'skipped' } };
      }
      notification = await Notification.findOneAndUpdate(
        { broadcastRecipient: recipientLog._id },
        {
          $setOnInsert: {
            recipient: user._id,
            type: 'system',
            title: broadcast.title,
            message: broadcast.message,
            data: buildNotificationData(broadcast, recipientLog, effectiveDeliveryType),
            broadcastRecipient: recipientLog._id,
            isRead: false
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      inAppStatus = 'delivered';
      const { emitNotification } = require('../utils/notificationEmitter');
      emitNotification(user._id, notification);
      } catch (error) {
        inAppStatus = 'failed';
        errors.push(`In-app: ${error.message}`);
      }
    } else {
      inAppStatus = 'skipped';
    }
  } else {
    inAppStatus = 'skipped';
  }

  let pushWork = null;
  let webPushDelivered = false;
  if (pushRequested && webPushAvailable && pushStatus !== 'delivered') {
    if (!await ensureOccurrenceActive()) {
      return { ...recipientLog.toObject(), overallStatus: 'skipped', push: { status: 'skipped' }, inApp: { status: 'skipped' } };
    }
    const webClaim = await BroadcastRecipient.findOneAndUpdate(
      { _id: recipientLog._id, webPushEmittedAt: null },
      { $set: { webPushEmittedAt: new Date(), webPushAckDeadlineAt: new Date(Date.now() + WEB_PUSH_ACK_TIMEOUT_MS) } },
      { new: true }
    );
    if (webClaim) {
      const { emitBroadcastPushNotification } = require('../utils/notificationEmitter');
      webPushDelivered = emitBroadcastPushNotification(user._id, {
        id: String(recipientLog._id),
        type: 'system',
        title: broadcast.title,
        message: broadcast.message,
        subtitle: broadcast.subtitle || '',
        bannerImage: broadcast.bannerImage || '',
        thumbnail: broadcast.thumbnail || '',
        data: buildNotificationData(broadcast, recipientLog, effectiveDeliveryType)
      });
      if (!webPushDelivered) {
        await BroadcastRecipient.updateOne(
          { _id: recipientLog._id, webPushEmittedAt: { $ne: null } },
          { $set: { webPushEmittedAt: null, webPushAckDeadlineAt: null } }
        );
      }
    } else {
      webPushDelivered = Boolean(recipientLog.webPushEmittedAt);
    }
  }
  if (pushRequested) {
    if (pushStatus === 'delivered') {
      // Preserve the successful channel while a failed peer channel retries.
    } else if (nativePushAvailable) {
      if (!await ensureOccurrenceActive()) {
        return { ...recipientLog.toObject(), overallStatus: 'skipped', push: { status: 'skipped' }, inApp: { status: 'skipped' } };
      }
      const pushNotification = notification || {
        _id: recipientLog._id,
        recipient: user._id,
        type: 'system',
        title: broadcast.title,
        message: broadcast.message,
        data: buildNotificationData(broadcast, recipientLog, effectiveDeliveryType)
      };
      // The chunk worker submits all recipients together. Ticket acceptance is
      // not delivery: the channel remains processing until a delayed receipt
      // worker reconciles Expo's final status.
      pushStatus = 'processing';
      pushWork = {
        broadcastId: broadcast._id,
        occurrenceKey,
        recipientLogId: recipientLog._id,
        recipientId: user._id,
        user,
        notificationId: notification?._id || null,
        notification: pushNotification
      };
    } else if (webPushDelivered) {
      // Socket emission is only a submission signal. Delivery becomes known
      // when the Web client explicitly acknowledges with /open or /click.
      pushStatus = 'processing';
    } else {
      pushStatus = 'skipped';
    }
  } else {
    pushStatus = 'skipped';
  }

  const now = new Date();
  const overallStatus = resolveOverallStatus(pushStatus, inAppStatus);
  const finalStatusUpdate = await BroadcastRecipient.updateOne(
    { _id: recipientLog._id, webPushAcknowledgedAt: null },
    {
      $set: {
        notification: notification?._id || null,
        overallStatus,
        processingLeaseAt: null,
        processingKey: '',
        lastError: errors.join('; ').slice(0, 1000),
        'push.status': pushStatus,
        'push.attemptedAt': pushRequested ? now : null,
        'push.deliveredAt': pushStatus === 'delivered' ? now : null,
        'push.failureReason': pushStatus === 'failed' ? errors.filter((item) => item.startsWith('Push:')).join('; ') : '',
        'inApp.status': inAppStatus,
        'inApp.attemptedAt': inAppRequested ? now : null,
        'inApp.deliveredAt': inAppStatus === 'delivered' ? now : null,
        'inApp.failureReason': inAppStatus === 'failed' ? errors.filter((item) => item.startsWith('In-app:')).join('; ') : ''
      }
    }
  );
  if (!finalStatusUpdate.matchedCount) {
    // A fast Web client can acknowledge between socket emission and this
    // worker write. ACK is authoritative and must never be downgraded back to
    // processing by the originating chunk.
    await BroadcastRecipient.updateOne(
      { _id: recipientLog._id, webPushAcknowledgedAt: { $ne: null } },
      {
        $set: {
          notification: notification?._id || null,
          overallStatus: resolveOverallStatus('delivered', inAppStatus),
          processingLeaseAt: null,
          processingKey: '',
          'push.status': 'delivered',
          'push.failureReason': '',
          'inApp.status': inAppStatus,
          'inApp.attemptedAt': inAppRequested ? now : null,
          'inApp.deliveredAt': inAppStatus === 'delivered' ? now : null,
          'inApp.failureReason': inAppStatus === 'failed' ? errors.filter((item) => item.startsWith('In-app:')).join('; ') : ''
        }
      }
    );
  }
  return {
    ...recipientLog.toObject(),
    overallStatus,
    push: { status: pushStatus },
    inApp: { status: inAppStatus },
    pushWork
  };
};

const aggregateBroadcastMetrics = async (broadcastId) => {
  const [summary] = await BroadcastRecipient.aggregate([
    { $match: { broadcast: new mongoose.Types.ObjectId(String(broadcastId)) } },
    { $group: {
      _id: null,
      sourceUpdatedAt: { $max: '$updatedAt' },
      recipients: { $sum: 1 },
      delivered: { $sum: { $cond: [{ $in: ['$overallStatus', ['delivered', 'partial']] }, 1, 0] } },
      failed: { $sum: { $cond: [{ $eq: ['$overallStatus', 'failed'] }, 1, 0] } },
      skipped: { $sum: { $cond: [{ $eq: ['$overallStatus', 'skipped'] }, 1, 0] } },
      opened: { $sum: { $cond: [{ $ne: ['$openedAt', null] }, 1, 0] } },
      clicked: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } },
      pushDelivered: { $sum: { $cond: [{ $eq: ['$push.status', 'delivered'] }, 1, 0] } },
      pushAttempted: { $sum: { $cond: [{ $in: ['$push.status', ['processing', 'delivered', 'failed']] }, 1, 0] } },
      inAppDelivered: { $sum: { $cond: [{ $eq: ['$inApp.status', 'delivered'] }, 1, 0] } },
      retryableFailures: { $sum: { $cond: [{ $or: [
        { $eq: ['$push.status', 'failed'] },
        { $eq: ['$inApp.status', 'failed'] }
      ] }, 1, 0] } }
    } }
  ]);
  const value = summary || {
    sourceUpdatedAt: new Date(0), recipients: 0, delivered: 0, failed: 0, skipped: 0,
    opened: 0, clicked: 0, pushDelivered: 0, pushAttempted: 0,
    inAppDelivered: 0, retryableFailures: 0
  };
  const sourceUpdatedAt = value.sourceUpdatedAt || new Date(0);
  delete value._id;
  delete value.sourceUpdatedAt;
  return { metrics: value, sourceUpdatedAt };
};

const requestBroadcastMetricsRefresh = async (broadcastId) => {
  await Broadcast.updateOne(
    { _id: broadcastId },
    { $inc: { 'metricsRefresh.requestedRevision': 1 } }
  );
};

const refreshBroadcastMetrics = async (broadcastId) => {
  const id = String(broadcastId);
  const requested = await Broadcast.findOneAndUpdate(
    { _id: id },
    { $inc: { 'metricsRefresh.requestedRevision': 1 } },
    { new: true }
  ).select('metrics metricsRefresh').lean();
  if (!requested) return null;

  const lockKey = `metrics-${randomUUID()}`;
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const now = new Date();
    const locked = await Broadcast.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { 'metricsRefresh.lockKey': '' },
          { 'metricsRefresh.lockKey': null },
          { 'metricsRefresh.lockKey': { $exists: false } },
          { 'metricsRefresh.lockExpiresAt': { $lte: now } }
        ]
      },
      {
        $set: {
          'metricsRefresh.lockKey': lockKey,
          'metricsRefresh.lockExpiresAt': new Date(now.getTime() + METRICS_REFRESH_LOCK_MS)
        }
      },
      { new: true }
    ).select('metrics metricsRefresh').lean();
    if (!locked) {
      // This request already advanced requestedRevision. The current lock
      // holder must observe it before conditional release; stale-lock recovery
      // handles a crashed holder without making user requests wait.
      return requested.metrics || {};
    }

    let latestMetrics = locked.metrics || {};
    try {
      for (let round = 0; round < METRICS_REFRESH_MAX_ROUNDS; round += 1) {
        const state = await Broadcast.findOne({ _id: id, 'metricsRefresh.lockKey': lockKey })
          .select('metricsRefresh.requestedRevision')
          .lean();
        if (!state) break;
        const targetRevision = Number(state.metricsRefresh?.requestedRevision || 0);
        const aggregate = await aggregateBroadcastMetrics(id);
        const sourceUpdatedAt = aggregate.sourceUpdatedAt;
        const applied = await Broadcast.findOneAndUpdate(
          {
            _id: id,
            'metricsRefresh.lockKey': lockKey,
            $or: [
              { metricsSourceUpdatedAt: null },
              { metricsSourceUpdatedAt: { $exists: false } },
              { metricsSourceUpdatedAt: { $lte: sourceUpdatedAt } }
            ]
          },
          {
            $set: {
              metrics: aggregate.metrics,
              metricsSourceUpdatedAt: sourceUpdatedAt,
              'metricsRefresh.appliedRevision': targetRevision,
              'metricsRefresh.lockExpiresAt': new Date(Date.now() + METRICS_REFRESH_LOCK_MS)
            }
          },
          { new: true }
        ).select('metricsRefresh').lean();
        if (!applied) {
          const current = await Broadcast.findById(id).select('metrics').lean();
          latestMetrics = current?.metrics || latestMetrics;
          break;
        }
        latestMetrics = aggregate.metrics;
        const requestedRevision = Number(applied.metricsRefresh?.requestedRevision || 0);
        if (requestedRevision !== targetRevision) continue;

        const released = await Broadcast.updateOne(
          {
            _id: id,
            'metricsRefresh.lockKey': lockKey,
            'metricsRefresh.requestedRevision': targetRevision,
            'metricsRefresh.appliedRevision': targetRevision
          },
          {
            $set: { 'metricsRefresh.lockKey': '', 'metricsRefresh.lockExpiresAt': null }
          }
        );
        if (released.modifiedCount) return latestMetrics;
        // A refresh request landed between the equality check and release.
      }
    } finally {
      await Broadcast.updateOne(
        { _id: id, 'metricsRefresh.lockKey': lockKey },
        { $set: { 'metricsRefresh.lockKey': '', 'metricsRefresh.lockExpiresAt': null } }
      );
    }
    return latestMetrics;
  }
  // The requested revision remains greater than appliedRevision. The recovery
  // scanner will retry after the active holder releases or its lease expires.
  return requested.metrics || {};
};

const reconcileDirtyBroadcastMetrics = async (limit = 100) => {
  const dirty = await Broadcast.find({
    $expr: {
      $gt: [
        { $ifNull: ['$metricsRefresh.requestedRevision', 0] },
        { $ifNull: ['$metricsRefresh.appliedRevision', 0] }
      ]
    }
  }).select('_id').limit(Math.max(1, Math.min(1000, limit))).lean();
  await mapWithConcurrency(dirty, 5, (broadcast) => refreshBroadcastMetrics(broadcast._id));
  return { reconciled: dirty.length };
};

const deliveryMetricContribution = (overallStatus, pushStatus, inAppStatus) => ({
  delivered: ['delivered', 'partial'].includes(overallStatus) ? 1 : 0,
  failed: overallStatus === 'failed' ? 1 : 0,
  skipped: overallStatus === 'skipped' ? 1 : 0,
  pushDelivered: pushStatus === 'delivered' ? 1 : 0,
  pushAttempted: ['processing', 'delivered', 'failed'].includes(pushStatus) ? 1 : 0,
  retryableFailures: pushStatus === 'failed' || inAppStatus === 'failed' ? 1 : 0
});

const addMetricTransition = (deltas, broadcastId, before, after) => {
  const key = String(broadcastId);
  if (!deltas.has(key)) deltas.set(key, {});
  const target = deltas.get(key);
  for (const metric of Object.keys(after)) {
    const delta = Number(after[metric] || 0) - Number(before[metric] || 0);
    if (delta) target[metric] = Number(target[metric] || 0) + delta;
  }
};

const applyMetricTransitions = async (deltas) => {
  // Recipient rows are authoritative. Never mix aggregate-and-$set refreshes
  // with independent metric $inc writes. refreshBroadcastMetrics serializes
  // replacement through a Mongo revision lease and loops until every revision
  // requested while the aggregate was running has been applied.
  await Promise.all(Array.from(deltas.keys()).map((broadcastId) =>
    refreshBroadcastMetrics(broadcastId)
  ));
};

const recordNotificationFailure = async ({
  broadcast,
  broadcastRecipient = null,
  recipient = null,
  occurrenceKey,
  channel,
  stage,
  code = '',
  reason,
  attempts = 0
}) => {
  if (channel === 'push' && broadcastRecipient) {
    const stillFailed = await BroadcastRecipient.exists({
      _id: broadcastRecipient,
      webPushAcknowledgedAt: null,
      'push.status': { $ne: 'delivered' }
    });
    if (!stillFailed) return null;
  }
  const failure = await NotificationFailure.findOneAndUpdate(
    { broadcast, occurrenceKey, broadcastRecipient, channel, stage },
    {
      $setOnInsert: { broadcast, occurrenceKey, broadcastRecipient, recipient, channel, stage, firstFailedAt: new Date() },
      $set: {
        recipient,
        code: safeString(code, 200),
        reason: safeString(reason, 1000, 'Broadcast delivery failed'),
        attempts: Math.max(0, Number(attempts || 0)),
        status: 'open',
        lastFailedAt: new Date(),
        resolvedAt: null
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  if (channel === 'push' && broadcastRecipient) {
    const acknowledged = await BroadcastRecipient.exists({
      _id: broadcastRecipient,
      $or: [
        { webPushAcknowledgedAt: { $ne: null } },
        { 'push.status': 'delivered' }
      ]
    });
    if (acknowledged) {
      await NotificationFailure.updateOne(
        { _id: failure._id, status: { $in: ['open', 'retrying'] } },
        { $set: { status: 'resolved', resolvedAt: new Date() } }
      );
    }
  }
  return failure;
};

const expireUnacknowledgedWebPushes = async (limit = 1000) => {
  const now = new Date();
  const rows = await BroadcastRecipient.find({
    webPushEmittedAt: { $ne: null },
    webPushAcknowledgedAt: null,
    webPushAckDeadlineAt: { $ne: null, $lte: now },
    'push.status': 'processing'
  }).select('_id broadcast recipient occurrenceKey overallStatus push inApp attempts').limit(Math.max(1, Math.min(5000, limit))).lean();
  if (!rows.length) return { expired: 0, broadcastIds: [] };
  const reason = 'Connected Web notification was not acknowledged before its delivery deadline';
  const expiredRows = [];
  await mapWithConcurrency(rows, 25, async (row) => {
    const changed = await BroadcastRecipient.findOneAndUpdate(
      { _id: row._id, webPushAcknowledgedAt: null, 'push.status': 'processing' },
      { $set: {
        'push.status': 'failed',
        'push.failureReason': reason,
        overallStatus: resolveOverallStatus('failed', row.inApp?.status),
        webPushAckDeadlineAt: null,
        lastError: `Push: ${reason}`
      } },
      { new: true }
    );
    if (changed) expiredRows.push({ before: row, after: changed });
  });
  if (!expiredRows.length) return { expired: 0, broadcastIds: [] };
  await Promise.allSettled(expiredRows.map(({ before: row }) => recordNotificationFailure({
    broadcast: row.broadcast,
    broadcastRecipient: row._id,
    recipient: row.recipient,
    occurrenceKey: row.occurrenceKey,
    channel: 'push',
    stage: 'web_delivery_ack',
    code: 'WebDeliveryAckTimeout',
    reason,
    attempts: row.attempts
  })));
  const metricDeltas = new Map();
  expiredRows.forEach(({ before, after }) => addMetricTransition(
    metricDeltas,
    before.broadcast,
    deliveryMetricContribution(before.overallStatus, before.push?.status, before.inApp?.status),
    deliveryMetricContribution(after.overallStatus, after.push?.status, after.inApp?.status)
  ));
  await applyMetricTransitions(metricDeltas);
  const broadcastIds = Array.from(new Set(expiredRows.map(({ before }) => String(before.broadcast))));
  return { expired: expiredRows.length, broadcastIds };
};

const reconcileAcknowledgedNotificationFailures = async (limit = 1000) => {
  const rows = await NotificationFailure.aggregate([
    { $match: {
      channel: 'push',
      status: { $in: ['open', 'retrying'] },
      broadcastRecipient: { $ne: null }
    } },
    { $lookup: {
      from: BroadcastRecipient.collection.name,
      localField: 'broadcastRecipient',
      foreignField: '_id',
      as: 'recipientLog'
    } },
    { $unwind: '$recipientLog' },
    { $match: { $or: [
      { 'recipientLog.webPushAcknowledgedAt': { $ne: null } },
      { 'recipientLog.push.status': 'delivered' }
    ] } },
    { $sort: { lastFailedAt: 1, _id: 1 } },
    { $limit: Math.max(1, Math.min(5000, limit)) },
    { $project: { _id: 1 } }
  ]);
  const failureIds = rows.map((row) => row._id);
  if (!failureIds.length) return { resolved: 0 };
  const result = await NotificationFailure.updateMany(
    { _id: { $in: failureIds }, status: { $in: ['open', 'retrying'] } },
    { $set: { status: 'resolved', resolvedAt: new Date() } }
  );
  return { resolved: Number(result.modifiedCount || 0) };
};

const refreshRecipientPushStatuses = async (recipientLogIds) => {
  const ids = Array.from(new Set((recipientLogIds || []).map(String).filter(Boolean)));
  if (!ids.length) return { broadcastIds: [] };
  const { classifyBroadcastPushRecords } = require('../utils/pushNotificationService');
  const [receiptRecords, recipientLogs] = await Promise.all([
    BroadcastPushReceipt.find({ broadcastRecipient: { $in: ids } }).lean(),
    BroadcastRecipient.find({ _id: { $in: ids } }).select('broadcast push inApp overallStatus webPushAcknowledgedAt').lean()
  ]);
  const recordsByRecipient = new Map();
  for (const record of receiptRecords) {
    const key = String(record.broadcastRecipient);
    if (!recordsByRecipient.has(key)) recordsByRecipient.set(key, []);
    recordsByRecipient.get(key).push(record);
  }
  const now = new Date();
  const resolvedFailureIds = [];
  const metricDeltas = new Map();
  const operations = recipientLogs.map((recipientLog) => {
    const providerResult = classifyBroadcastPushRecords(recordsByRecipient.get(String(recipientLog._id)) || []);
    const result = recipientLog.webPushAcknowledgedAt
      ? { ...providerResult, status: 'delivered', failureReason: '' }
      : providerResult;
    if (['delivered', 'skipped'].includes(result.status)) resolvedFailureIds.push(recipientLog._id);
    const overallStatus = resolveOverallStatus(result.status, recipientLog.inApp?.status);
    addMetricTransition(
      metricDeltas,
      recipientLog.broadcast,
      deliveryMetricContribution(recipientLog.overallStatus, recipientLog.push?.status, recipientLog.inApp?.status),
      deliveryMetricContribution(overallStatus, result.status, recipientLog.inApp?.status)
    );
    return {
      updateOne: {
        filter: recipientLog.webPushAcknowledgedAt
          ? { _id: recipientLog._id }
          : { _id: recipientLog._id, webPushAcknowledgedAt: null },
        update: {
          $set: {
            overallStatus,
            'push.status': result.status,
            'push.providerMessageIds': result.providerMessageIds,
            'push.deliveredAt': result.status === 'delivered' ? now : null,
            'push.failureReason': result.status === 'failed' ? result.failureReason : '',
            lastError: result.status === 'failed' ? `Push: ${result.failureReason}`.slice(0, 1000) : ''
          }
        }
      }
    };
  });
  if (operations.length) await BroadcastRecipient.bulkWrite(operations, { ordered: false });
  await applyMetricTransitions(metricDeltas);
  if (resolvedFailureIds.length) {
    await NotificationFailure.updateMany(
      { broadcastRecipient: { $in: resolvedFailureIds }, channel: 'push', status: 'retrying' },
      { $set: { status: 'resolved', resolvedAt: new Date() } }
    );
  }
  return { broadcastIds: Array.from(new Set(recipientLogs.map((record) => String(record.broadcast)))) };
};

const reconcileTerminalPushReceipts = async (recipientLogIds) => {
  const { broadcastIds } = await refreshRecipientPushStatuses(recipientLogIds);
  const failedRows = await BroadcastRecipient.find({
    _id: { $in: recipientLogIds },
    'push.status': 'failed'
  }).select('_id broadcast recipient occurrenceKey attempts push.failureReason').lean();
  await Promise.allSettled(failedRows.map((row) => recordNotificationFailure({
    broadcast: row.broadcast,
    broadcastRecipient: row._id,
    recipient: row.recipient,
    occurrenceKey: row.occurrenceKey,
    channel: 'push',
    stage: 'provider_delivery',
    code: 'PushDeliveryFailed',
    reason: row.push?.failureReason || 'Push provider delivery failed',
    attempts: row.attempts
  })));
  for (const broadcastId of broadcastIds) {
    const broadcast = await Broadcast.findOne({
      _id: broadcastId,
      status: 'failed',
      cancelledAt: null
    }).select('execution.occurrenceKey').lean();
    if (!broadcast?.execution?.occurrenceKey) continue;
    const failedChunks = await BroadcastChunk.find({
      broadcast: broadcastId,
      occurrenceKey: broadcast.execution.occurrenceKey,
      status: 'failed'
    }).select('_id recipientIds').lean();
    for (const chunk of failedChunks) {
      const terminalRecipients = await BroadcastRecipient.countDocuments({
        broadcast: broadcastId,
        occurrenceKey: broadcast.execution.occurrenceKey,
        recipient: { $in: chunk.recipientIds },
        overallStatus: { $nin: ['pending', 'processing'] }
      });
      if (terminalRecipients === chunk.recipientIds.length) {
        await BroadcastChunk.updateOne(
          { _id: chunk._id, status: 'failed' },
          { $set: { status: 'completed', completedAt: new Date(), processingLeaseAt: null } }
        );
      }
    }
    const [totalChunks, completedChunks] = await Promise.all([
      BroadcastChunk.countDocuments({ broadcast: broadcastId, occurrenceKey: broadcast.execution.occurrenceKey }),
      BroadcastChunk.countDocuments({ broadcast: broadcastId, occurrenceKey: broadcast.execution.occurrenceKey, status: 'completed' })
    ]);
    if (totalChunks > 0 && completedChunks === totalChunks) {
      await Broadcast.updateOne(
        { _id: broadcastId, status: 'failed', cancelledAt: null },
        { $set: { status: 'processing', 'execution.completedChunks': completedChunks } }
      );
      await finalizeBroadcast(broadcastId, broadcast.execution.occurrenceKey);
    }
  }
  return { broadcastIds };
};

const retryBroadcastPushRecipients = async (recipientLogIds, reconciliationKey) => {
  const ids = Array.from(new Set((recipientLogIds || []).map(String).filter(Boolean)));
  if (!ids.length) return { retried: 0 };
  const recipientLogs = await BroadcastRecipient.find({ _id: { $in: ids } }).lean();
  const [broadcasts, occurrences, users, notifications] = await Promise.all([
    Broadcast.find({
      _id: { $in: recipientLogs.map((record) => record.broadcast) },
      status: { $ne: 'cancelled' },
      cancelledAt: null
    }),
    BroadcastOccurrence.find({
      broadcast: { $in: recipientLogs.map((record) => record.broadcast) },
      occurrenceKey: { $in: recipientLogs.map((record) => record.occurrenceKey) }
    }).lean(),
    User.find({ _id: { $in: recipientLogs.map((record) => record.recipient) }, isActive: true })
      .select('pushTokens notificationClients notificationSettings')
      .lean(),
    Notification.find({ _id: { $in: recipientLogs.map((record) => record.notification).filter(Boolean) } })
  ]);
  const broadcastById = new Map(broadcasts.map((broadcast) => [String(broadcast._id), broadcast]));
  const occurrenceByKey = new Map(occurrences.map((occurrence) => [
    `${String(occurrence.broadcast)}:${occurrence.occurrenceKey}`,
    occurrence.snapshot
  ]));
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const notificationById = new Map(notifications.map((notification) => [String(notification._id), notification]));
  const grouped = new Map();
  const skippedOperations = [];
  const terminalReceiptIds = { skipped: [], cancelled: [] };
  for (const recipientLog of recipientLogs) {
    const activeBroadcast = broadcastById.get(String(recipientLog.broadcast));
    const occurrenceSnapshot = occurrenceByKey.get(`${String(recipientLog.broadcast)}:${recipientLog.occurrenceKey}`);
    const broadcast = activeBroadcast && occurrenceSnapshot
      ? { ...occurrenceSnapshot, _id: activeBroadcast._id }
      : activeBroadcast;
    const user = userById.get(String(recipientLog.recipient));
    if (recipientLog.webPushAcknowledgedAt) {
      terminalReceiptIds.skipped.push(recipientLog._id);
      continue;
    }
    const categoryAllowed = broadcast
      ? isBroadcastCategoryAllowed(user?.notificationSettings || {}, broadcast.category)
      : false;
    const pushAllowed = user?.notificationSettings?.pushEnabled !== false && categoryAllowed;
    if (!broadcast || !user) {
      const pushStatus = 'skipped';
      skippedOperations.push({
        updateOne: {
          filter: { _id: recipientLog._id, webPushAcknowledgedAt: null },
          update: {
            $set: {
              'push.status': pushStatus,
              'push.failureReason': '',
              overallStatus: resolveOverallStatus(pushStatus, recipientLog.inApp?.status)
            }
          }
        }
      });
      terminalReceiptIds[activeBroadcast ? 'skipped' : 'cancelled'].push(recipientLog._id);
      continue;
    }
    if (!pushAllowed) {
      const inAppAllowed = user.notificationSettings?.inAppEnabled !== false && categoryAllowed;
      const inAppRequested = broadcast.deliveryType === 'both' || broadcast.deliveryType === 'in_app';
      let inAppStatus = recipientLog.inApp?.status || 'skipped';
      let fallbackNotification = recipientLog.notification
        ? notificationById.get(String(recipientLog.notification))
        : null;
      if (inAppRequested && inAppAllowed && inAppStatus !== 'delivered') {
        fallbackNotification = await Notification.findOneAndUpdate(
          { broadcastRecipient: recipientLog._id },
          {
            $setOnInsert: {
              recipient: user._id,
              type: 'system',
              title: broadcast.title,
              message: broadcast.message,
              data: buildNotificationData(broadcast, recipientLog, 'in_app'),
              broadcastRecipient: recipientLog._id,
              isRead: false
            }
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        inAppStatus = 'delivered';
        const { emitNotification } = require('../utils/notificationEmitter');
        emitNotification(user._id, fallbackNotification);
      } else if (!inAppRequested || !inAppAllowed) {
        inAppStatus = 'skipped';
      }
      skippedOperations.push({
        updateOne: {
          filter: { _id: recipientLog._id, webPushAcknowledgedAt: null },
          update: {
            $set: {
              notification: fallbackNotification?._id || recipientLog.notification || null,
              'push.status': 'skipped',
              'push.failureReason': '',
              'inApp.status': inAppStatus,
              'inApp.deliveredAt': inAppStatus === 'delivered' ? new Date() : recipientLog.inApp?.deliveredAt,
              overallStatus: resolveOverallStatus('skipped', inAppStatus)
            }
          }
        }
      });
      terminalReceiptIds.skipped.push(recipientLog._id);
      continue;
    }
    const notification = recipientLog.notification
      ? notificationById.get(String(recipientLog.notification))
      : null;
    const effectiveDeliveryType = resolveEffectiveDeliveryType({
      push: true,
      inApp: recipientLog.inApp?.status === 'delivered'
    });
    const pushNotification = notification || {
      _id: recipientLog._id,
      recipient: user._id,
      type: 'system',
      title: broadcast.title,
      message: broadcast.message,
      data: buildNotificationData(broadcast, recipientLog, effectiveDeliveryType)
    };
    const key = `${String(broadcast._id)}:${recipientLog.occurrenceKey}`;
    if (!grouped.has(key)) grouped.set(key, { broadcast, entries: [] });
    grouped.get(key).entries.push({
      broadcastId: broadcast._id,
      occurrenceKey: recipientLog.occurrenceKey,
      recipientLogId: recipientLog._id,
      recipientId: user._id,
      user,
      notificationId: notification?._id || null,
      notification: pushNotification,
      inAppStatus: recipientLog.inApp?.status || 'skipped'
    });
  }
  if (skippedOperations.length) await BroadcastRecipient.bulkWrite(skippedOperations, { ordered: false });
  if (terminalReceiptIds.skipped.length) {
    await BroadcastPushReceipt.updateMany(
      { broadcastRecipient: { $in: terminalReceiptIds.skipped }, ticketStatus: 'queued', receiptStatus: 'pending' },
      {
        $set: {
          ticketStatus: 'skipped',
          receiptStatus: 'skipped',
          receiptCheckedAt: new Date(),
          providerErrorCode: 'RetryNoLongerAllowed',
          providerErrorMessage: 'Recipient or push preferences no longer permit this retry'
        },
        $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
      }
    );
  }
  if (terminalReceiptIds.cancelled.length) {
    await BroadcastPushReceipt.updateMany(
      { broadcastRecipient: { $in: terminalReceiptIds.cancelled }, ticketStatus: 'queued', receiptStatus: 'pending' },
      {
        $set: {
          ticketStatus: 'cancelled',
          receiptStatus: 'cancelled',
          receiptCheckedAt: new Date(),
          providerErrorCode: 'BroadcastCancelled',
          providerErrorMessage: 'Broadcast is cancelled or unavailable; retry suppressed'
        },
        $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
      }
    );
  }

  let retried = 0;
  const { sendBroadcastPushBatch } = require('../utils/pushNotificationService');
  for (const { broadcast, entries } of grouped.values()) {
    const batchResult = await sendBroadcastPushBatch(
      entries,
      broadcast.audience?.toObject ? broadcast.audience.toObject() : broadcast.audience
    );
    const now = new Date();
    const noLongerMatched = [];
    const updates = entries.map((entry) => {
      const result = batchResult.recipientResults[String(entry.recipientLogId)] || {
        status: 'skipped', providerMessageIds: [], failureReason: 'No matched registered device token'
      };
      if (result.status === 'skipped') noLongerMatched.push(entry.recipientLogId);
      return {
        updateOne: {
          filter: { _id: entry.recipientLogId, webPushAcknowledgedAt: null },
          update: {
            $set: {
              overallStatus: resolveOverallStatus(result.status, entry.inAppStatus),
              'push.status': result.status,
              'push.providerMessageIds': result.providerMessageIds,
              'push.deliveredAt': result.status === 'delivered' ? now : null,
              'push.failureReason': result.status === 'failed' ? result.failureReason : '',
              lastError: result.status === 'failed' ? `Push: ${result.failureReason}`.slice(0, 1000) : ''
            }
          }
        }
      };
    });
    if (updates.length) await BroadcastRecipient.bulkWrite(updates, { ordered: false });
    if (noLongerMatched.length) {
      await BroadcastPushReceipt.updateMany(
        { broadcastRecipient: { $in: noLongerMatched }, ticketStatus: 'queued', receiptStatus: 'pending' },
        {
          $set: {
            ticketStatus: 'skipped',
            receiptStatus: 'skipped',
            receiptCheckedAt: new Date(),
            providerErrorCode: 'RetryTokenUnavailable',
            providerErrorMessage: 'The originally targeted device token is no longer eligible'
          }
        }
      );
    }
    retried += entries.length;
    if (batchResult.receiptRecordIds.length) {
      const { enqueueBroadcastReceipts } = require('../utils/jobQueue');
      await enqueueBroadcastReceipts(
        batchResult.receiptRecordIds,
        batchResult.receiptRunAt || new Date(Date.now() + 15 * 60 * 1000),
        `provider-retry-${reconciliationKey}-${String(broadcast._id)}`
      );
    }
  }
  return { retried };
};

const processBroadcastPushReceipts = async ({ receiptRecordIds, workerJobId }) => {
  const { reconcileBroadcastPushReceipts } = require('../utils/pushNotificationService');
  const result = await reconcileBroadcastPushReceipts(
    receiptRecordIds,
    workerJobId || `receipt-${createOccurrenceKey()}`
  );
  if (result.retryRecipientLogIds?.length) {
    await retryBroadcastPushRecipients(result.retryRecipientLogIds, workerJobId || createOccurrenceKey());
  }
  await refreshRecipientPushStatuses(result.recipientLogIds);

  if (result.pendingRecordIds.length) {
    const pending = await BroadcastPushReceipt.find({
      _id: { $in: result.pendingRecordIds },
      ticketStatus: 'accepted',
      receiptStatus: 'pending',
      nextReceiptAt: { $ne: null }
    })
      .select('nextReceiptAt')
      .lean();
    const pendingIds = pending.map((record) => String(record._id));
    const runAt = pending.reduce((latest, record) => {
      const next = record.nextReceiptAt ? new Date(record.nextReceiptAt) : new Date(Date.now() + 60000);
      return next > latest ? next : latest;
    }, new Date());
    if (pendingIds.length) {
      const { enqueueBroadcastReceipts } = require('../utils/jobQueue');
      await enqueueBroadcastReceipts(
        pendingIds,
        runAt,
        `retry-${Math.floor(Date.now() / 60000)}-${workerJobId || 'worker'}`
      );
    }
  }
  return result;
};

const finalizeBroadcast = async (broadcastId, occurrenceKey) => {
  const broadcast = await Broadcast.findById(broadcastId);
  if (!broadcast || broadcast.execution?.occurrenceKey !== occurrenceKey) return null;
  if (broadcast.status !== 'processing' || broadcast.cancelledAt) {
    await requestBroadcastMetricsRefresh(broadcastId);
    return null;
  }
  await refreshBroadcastMetrics(broadcastId);
  const now = new Date();
  const recurrence = broadcast.schedule?.recurrence || 'once';
  const currentRun = broadcast.schedule?.nextRunAt || broadcast.schedule?.scheduledAt || now;
  const nextRunAt = recurrence === 'once'
    ? null
    : nextRecurrenceDate(
      currentRun,
      recurrence,
      broadcast.schedule?.recurrenceInterval || 1,
      broadcast.schedule?.timezone || 'UTC'
    );
  const recurrenceEnded = broadcast.schedule?.recurrenceEndAt && nextRunAt > broadcast.schedule.recurrenceEndAt;

  if (nextRunAt && !recurrenceEnded) {
    await Broadcast.updateOne(
      { _id: broadcastId, 'execution.occurrenceKey': occurrenceKey },
      {
        $set: {
          status: 'scheduled',
          sentAt: now,
          'schedule.scheduledAt': nextRunAt,
          'schedule.nextRunAt': nextRunAt,
          'execution.finishedAt': now,
          'execution.lockedAt': null,
          'execution.attempts': 0,
          'execution.audienceSnapshotComplete': false,
          'execution.audienceSnapshotRecipients': 0,
          'execution.audienceSnapshotAt': null
        }
      }
    );
    try {
      const { enqueueBroadcast } = require('../utils/jobQueue');
      await enqueueBroadcast(String(broadcastId), nextRunAt, createOccurrenceKey(nextRunAt));
    } catch (error) {
      log.error('Recurring broadcast enqueue failed', { broadcastId: String(broadcastId), error: String(error) });
    }
  } else {
    await Broadcast.updateOne(
      { _id: broadcastId, 'execution.occurrenceKey': occurrenceKey },
      {
        $set: {
          status: 'sent',
          sentAt: now,
          'schedule.nextRunAt': null,
          'execution.finishedAt': now,
          'execution.lockedAt': null
        }
      }
    );
  }
  return Broadcast.findById(broadcastId);
};

const processBroadcastDispatch = async ({ broadcastId, occurrenceKey, runAt, workerJobId }, enqueueChunk) => {
  const staleLease = new Date(Date.now() - PROCESSING_LEASE_MS);
  const expectedRunAt = new Date(runAt);
  const broadcast = await Broadcast.findOneAndUpdate(
    {
      _id: broadcastId,
      cancelledAt: null,
      $or: [
        { status: 'queued' },
        { status: 'scheduled', 'schedule.nextRunAt': expectedRunAt },
        {
          status: 'processing',
          'execution.occurrenceKey': occurrenceKey,
          $or: [
            { 'execution.workerJobId': workerJobId },
            { 'execution.lockedAt': null },
            { 'execution.lockedAt': { $lt: staleLease } }
          ]
        }
      ]
    },
    {
      $set: {
        status: 'processing',
        'execution.occurrenceKey': occurrenceKey,
        'execution.workerJobId': workerJobId,
        'execution.lockedAt': new Date(),
        'execution.startedAt': new Date(),
        'execution.finishedAt': null,
        'execution.lastError': ''
      },
      $inc: { 'execution.attempts': 1, __v: 1 }
    },
    { new: true }
  );
  if (!broadcast) return { skipped: true };

  await BroadcastOccurrence.findOneAndUpdate(
    { broadcast: broadcast._id, occurrenceKey },
    {
      $setOnInsert: {
        broadcast: broadcast._id,
        occurrenceKey,
        snapshot: createOccurrenceSnapshot(broadcast)
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const existingChunkFilter = { broadcast: broadcast._id, occurrenceKey };
  const [existingChunkCount, hasStartedChunk] = await Promise.all([
    BroadcastChunk.countDocuments(existingChunkFilter),
    BroadcastChunk.exists({ ...existingChunkFilter, status: { $ne: 'pending' } })
  ]);

  // New dispatches materialize the complete audience before queueing any
  // delivery job. A retry then reuses that immutable snapshot even if users,
  // filters, or query ordering have changed.
  const reusableSnapshot = existingChunkCount > 0 && (
    broadcast.execution?.audienceSnapshotComplete === true ||
    Boolean(hasStartedChunk)
  );
  if (!reusableSnapshot) {
    if (existingChunkCount) {
      await BroadcastChunk.deleteMany({ broadcast: broadcast._id, occurrenceKey, status: 'pending' });
    }
    await Broadcast.updateOne(
      { _id: broadcastId, 'execution.occurrenceKey': occurrenceKey },
      { $set: { 'execution.audienceSnapshotComplete': false } }
    );
    const query = buildAudienceQuery(broadcast.audience?.toObject ? broadcast.audience.toObject() : broadcast.audience);
    const cursor = User.find(query).select('_id').sort({ _id: 1 }).lean().cursor();
    let batch = [];
    let chunkIndex = 0;
    for await (const user of cursor) {
      batch.push(String(user._id));
      if (batch.length >= RECIPIENT_CHUNK_SIZE) {
        await BroadcastChunk.findOneAndUpdate(
          { broadcast: broadcast._id, occurrenceKey, chunkIndex },
          { $setOnInsert: { broadcast: broadcast._id, occurrenceKey, chunkIndex, recipientIds: batch, status: 'pending' } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        batch = [];
        chunkIndex += 1;
      }
    }
    if (batch.length) {
      await BroadcastChunk.findOneAndUpdate(
        { broadcast: broadcast._id, occurrenceKey, chunkIndex },
        { $setOnInsert: { broadcast: broadcast._id, occurrenceKey, chunkIndex, recipientIds: batch, status: 'pending' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
  }

  const [snapshotSummary] = await BroadcastChunk.aggregate([
    { $match: { broadcast: broadcast._id, occurrenceKey } },
    { $group: {
      _id: null,
      totalRecipients: { $sum: { $size: '$recipientIds' } },
      totalChunks: { $sum: 1 },
      completedChunks: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } }
    } }
  ]);
  const totalRecipients = Number(snapshotSummary?.totalRecipients || 0);
  const totalChunks = Number(snapshotSummary?.totalChunks || 0);
  const previouslyCompletedChunks = Number(snapshotSummary?.completedChunks || 0);
  await Broadcast.updateOne(
    { _id: broadcastId, 'execution.occurrenceKey': occurrenceKey },
    {
      $set: {
        'execution.totalChunks': totalChunks,
        'execution.completedChunks': previouslyCompletedChunks,
        'execution.audienceSnapshotComplete': true,
        'execution.audienceSnapshotRecipients': totalRecipients,
        'execution.audienceSnapshotAt': reusableSnapshot && broadcast.execution?.audienceSnapshotAt
          ? broadcast.execution.audienceSnapshotAt
          : new Date()
      }
    }
  );
  await NotificationFailure.updateMany(
    {
      broadcast: broadcastId,
      occurrenceKey,
      channel: 'queue',
      stage: 'dispatch:dispatch',
      status: { $in: ['open', 'retrying'] }
    },
    { $set: { status: 'resolved', resolvedAt: new Date() } }
  );

  if (totalChunks === 0) {
    await finalizeBroadcast(broadcastId, occurrenceKey);
    return { recipients: 0, chunks: 0 };
  }

  const chunkCursor = BroadcastChunk.find({
    broadcast: broadcast._id,
    occurrenceKey,
    status: { $ne: 'completed' }
  }).select('chunkIndex recipientIds status').sort({ chunkIndex: 1 }).lean().cursor();
  for await (const chunkRecord of chunkCursor) {
    if (chunkRecord.status !== 'completed') {
      await enqueueChunk(
        String(broadcastId),
        occurrenceKey,
        chunkRecord.chunkIndex,
        chunkRecord.recipientIds.map(String)
      );
    }
  }
  const completedChunks = await BroadcastChunk.countDocuments({
    broadcast: broadcast._id,
    occurrenceKey,
    status: 'completed'
  });
  await Broadcast.updateOne(
    { _id: broadcastId, 'execution.occurrenceKey': occurrenceKey },
    { $set: { 'execution.completedChunks': completedChunks } }
  );
  if (totalChunks === 0 || completedChunks >= totalChunks) {
    await finalizeBroadcast(broadcastId, occurrenceKey);
  }
  return { recipients: totalRecipients, chunks: totalChunks };
};

const processBroadcastChunk = async ({ broadcastId, occurrenceKey, chunkIndex, recipientIds, workerJobId }) => {
  const broadcast = await Broadcast.findOne({
    _id: broadcastId,
    status: 'processing',
    'execution.occurrenceKey': occurrenceKey,
    cancelledAt: null
  });
  if (!broadcast) return { skipped: true };
  const leaseCutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
  const chunk = await BroadcastChunk.findOneAndUpdate(
    {
      broadcast: broadcastId,
      occurrenceKey,
      chunkIndex,
      $or: [
        { status: { $in: ['pending', 'failed'] } },
        { status: 'processing', workerJobId },
        { status: 'processing', processingLeaseAt: { $lt: leaseCutoff } }
      ]
    },
    {
      $set: { status: 'processing', processingLeaseAt: new Date(), workerJobId, lastError: '' },
      $inc: { attempts: 1 }
    },
    { new: true }
  );
  if (!chunk) return { skipped: true, reason: 'already_completed_or_leased' };
  const occurrence = await BroadcastOccurrence.findOne({ broadcast: broadcast._id, occurrenceKey }).lean();
  if (!occurrence?.snapshot) {
    throw new Error(`Immutable broadcast occurrence snapshot is missing for ${occurrenceKey}`);
  }
  const deliveryBroadcast = { ...occurrence.snapshot, _id: broadcast._id };
  const users = await User.find({
    // The durable chunk is the immutable occurrence snapshot. Job payload IDs
    // are advisory only and may be stale after queue recovery.
    _id: { $in: chunk.recipientIds }
  }).select('username userType profile.displayName profile.location profile.country isPremium membership.tier pushTokens notificationClients notificationSettings isActive needsProfileCompletion').lean();

  const usersById = new Map(users.map((user) => [String(user._id), user]));
  const eligibleUsers = users.filter((user) => user.isActive !== false && user.needsProfileCompletion !== true);
  const skippedSnapshotOperations = chunk.recipientIds
    .map((recipientId) => ({ recipientId, user: usersById.get(String(recipientId)) }))
    .filter(({ user }) => !user || user.isActive === false || user.needsProfileCompletion === true)
    .flatMap(({ recipientId, user }) => {
      const reason = !user
        ? 'Recipient account no longer exists'
        : (user.isActive === false ? 'Recipient account is inactive' : 'Recipient profile is incomplete');
      const identity = { broadcast: broadcast._id, recipient: recipientId, occurrenceKey };
      const initialState = {
        ...identity,
        recipientSnapshot: {
          username: user?.username || '',
          displayName: user?.profile?.displayName || '',
          userType: user?.userType || '',
          isPremium: user?.isPremium === true,
          premiumPlan: user?.membership?.tier || 'free',
          location: user?.profile?.location || '',
          country: deriveCountry(user?.profile),
          platforms: user ? getMatchedRecipientPlatforms(user, deliveryBroadcast.audience || {}) : []
        },
        requestedDeliveryType: deliveryBroadcast.deliveryType,
        overallStatus: 'skipped',
        push: { status: 'skipped' },
        inApp: { status: 'skipped' },
        lastError: reason
      };
      return [
        {
          updateOne: {
            filter: identity,
            update: { $setOnInsert: initialState },
            upsert: true
          }
        },
        {
          updateOne: {
            filter: { ...identity, webPushAcknowledgedAt: null },
            update: { $set: {
              overallStatus: 'skipped',
              'push.status': 'skipped',
              'inApp.status': 'skipped',
              processingLeaseAt: null,
              processingKey: '',
              lastError: reason
            } }
          }
        }
      ];
    });
  if (skippedSnapshotOperations.length) {
    await BroadcastRecipient.bulkWrite(skippedSnapshotOperations, { ordered: false });
  }

  const outcomes = [];
  const unexpectedErrors = [];
  await mapWithConcurrency(eligibleUsers, DELIVERY_CONCURRENCY, async (user) => {
    try {
      outcomes.push(await deliverToRecipient(deliveryBroadcast, occurrenceKey, user, workerJobId));
    } catch (error) {
      outcomes.push({ overallStatus: 'failed', error: error.message });
      unexpectedErrors.push(error);
      await BroadcastRecipient.updateOne(
        { broadcast: broadcastId, recipient: user._id, occurrenceKey, webPushAcknowledgedAt: null },
        {
          $set: {
            overallStatus: 'failed',
            processingLeaseAt: null,
            processingKey: '',
            lastError: String(error.message || error).slice(0, 1000)
          }
        }
      ).catch(() => {});
      log.error('Broadcast recipient delivery failed', {
        broadcastId: String(broadcastId),
        recipientId: String(user._id),
        error: String(error)
      });
    }
  });

  const pushOutcomes = outcomes.filter((item) => item?.pushWork);
  if (pushOutcomes.length) {
    const { sendBroadcastPushBatch } = require('../utils/pushNotificationService');
    let batchResult;
    try {
      batchResult = await sendBroadcastPushBatch(
        pushOutcomes.map((item) => item.pushWork),
        deliveryBroadcast.audience
      );
    } catch (error) {
      const failureReason = String(error?.message || error).slice(0, 1000);
      const failedAt = new Date();
      await BroadcastRecipient.bulkWrite(pushOutcomes.map((outcome) => ({
        updateOne: {
          filter: { _id: outcome.pushWork.recipientLogId, webPushAcknowledgedAt: null },
          update: {
            $set: {
              overallStatus: resolveOverallStatus('failed', outcome.inApp?.status),
              'push.status': 'failed',
              'push.attemptedAt': failedAt,
              'push.failureReason': failureReason,
              processingLeaseAt: null,
              processingKey: '',
              lastError: `Push: ${failureReason}`.slice(0, 1000)
            }
          }
        }
      })), { ordered: false });
      await refreshBroadcastMetrics(broadcastId);
      throw error;
    }
    const now = new Date();
    const updates = [];
    for (const outcome of pushOutcomes) {
      const result = batchResult.recipientResults[String(outcome.pushWork.recipientLogId)] || {
        status: 'skipped',
        providerMessageIds: [],
        failureReason: 'No matched registered device token'
      };
      outcome.push = { status: result.status };
      outcome.overallStatus = resolveOverallStatus(result.status, outcome.inApp?.status);
      updates.push({
        updateOne: {
          filter: { _id: outcome.pushWork.recipientLogId, webPushAcknowledgedAt: null },
          update: {
            $set: {
              overallStatus: outcome.overallStatus,
              'push.status': result.status,
              'push.providerMessageIds': result.providerMessageIds,
              'push.deliveredAt': result.status === 'delivered' ? now : null,
              'push.failureReason': result.status === 'failed' ? result.failureReason : '',
              lastError: result.status === 'failed' ? `Push: ${result.failureReason}`.slice(0, 1000) : ''
            }
          }
        }
      });
    }
    if (updates.length) await BroadcastRecipient.bulkWrite(updates, { ordered: false });
    if (batchResult.receiptRecordIds.length) {
      try {
        const { enqueueBroadcastReceipts } = require('../utils/jobQueue');
        await enqueueBroadcastReceipts(
          batchResult.receiptRecordIds,
          batchResult.receiptRunAt || new Date(Date.now() + 15 * 60 * 1000),
          `${broadcastId}-${occurrenceKey}-${chunkIndex}`
        );
      } catch (error) {
        // Tickets are already durable in MongoDB. The scheduler repairs this
        // exact crash window without resubmitting the provider messages.
        log.error('Broadcast receipt enqueue failed; recovery scan will retry', {
          broadcastId: String(broadcastId),
          chunkIndex,
          error: String(error)
        });
      }
    }
  }

  const channelFailures = outcomes.filter((item) =>
    item?.inApp?.status === 'failed'
  );
  if (channelFailures.length) {
    unexpectedErrors.push(new Error(`${channelFailures.length} recipient deliveries require retry`));
  }

  if (unexpectedErrors.length) {
    await BroadcastChunk.updateOne(
      { _id: chunk._id },
      {
        $set: {
          status: 'pending',
          processingLeaseAt: null,
          workerJobId: '',
          lastError: String(unexpectedErrors[0].message || unexpectedErrors[0]).slice(0, 1000)
        }
      }
    );
    throw unexpectedErrors[0];
  }

  await BroadcastChunk.updateOne(
    { _id: chunk._id, status: 'processing' },
    { $set: { status: 'completed', completedAt: new Date(), processingLeaseAt: null, workerJobId: '' } }
  );
  const resolvedRecipientLogIds = outcomes
    .filter((outcome) => outcome?._id && !['failed', 'processing'].includes(outcome.overallStatus))
    .map((outcome) => outcome._id);
  await Promise.all([
    NotificationFailure.updateMany(
      {
        broadcast: broadcastId,
        occurrenceKey,
        broadcastRecipient: { $in: resolvedRecipientLogIds },
        status: 'retrying'
      },
      { $set: { status: 'resolved', resolvedAt: new Date() } }
    ),
    NotificationFailure.updateMany(
      {
        broadcast: broadcastId,
        occurrenceKey,
        channel: 'queue',
        stage: `deliver-chunk:${chunkIndex}`,
        status: 'retrying'
      },
      { $set: { status: 'resolved', resolvedAt: new Date() } }
    )
  ]);
  const [completedChunks, failedChunks] = await Promise.all([
    BroadcastChunk.countDocuments({ broadcast: broadcastId, occurrenceKey, status: 'completed' }),
    BroadcastChunk.countDocuments({ broadcast: broadcastId, occurrenceKey, status: 'failed' })
  ]);
  await requestBroadcastMetricsRefresh(broadcastId);

  const updated = await Broadcast.findOneAndUpdate(
    { _id: broadcastId, status: 'processing', 'execution.occurrenceKey': occurrenceKey },
    { $set: { 'execution.completedChunks': completedChunks, 'execution.lockedAt': new Date() } },
    { new: true }
  );
  if (updated && completedChunks + failedChunks >= updated.execution.totalChunks) {
    if (failedChunks > 0) {
      await refreshBroadcastMetrics(broadcastId);
      await Broadcast.updateOne(
        { _id: broadcastId, status: 'processing', 'execution.occurrenceKey': occurrenceKey },
        {
          $set: {
            status: 'failed',
            'execution.finishedAt': new Date(),
            'execution.lockedAt': null,
            'execution.lastError': `${failedChunks} delivery chunk(s) failed after retries`
          }
        }
      );
    } else {
      await finalizeBroadcast(broadcastId, occurrenceKey);
    }
  }
  return {
    attempted: users.length,
    delivered: outcomes.filter((item) => ['delivered', 'partial'].includes(item?.overallStatus)).length,
    failed: outcomes.filter((item) => item?.overallStatus === 'failed').length,
    skipped: outcomes.filter((item) => item?.overallStatus === 'skipped').length
  };
};

const markBroadcastWorkerFailure = async ({ broadcastId, occurrenceKey, chunkIndex, jobName }, error) => {
  const errorMessage = safeString(String(error?.message || error), 1000);
  await recordNotificationFailure({
    broadcast: broadcastId,
    occurrenceKey,
    channel: 'queue',
    stage: `${jobName || 'dispatch'}:${chunkIndex ?? 'dispatch'}`,
    code: 'QueueRetryExhausted',
    reason: errorMessage
  }).catch(() => {});
  if (jobName !== 'deliver-chunk') {
    const dispatch = await Broadcast.findOne({
      _id: broadcastId,
      'execution.occurrenceKey': occurrenceKey,
      status: 'processing'
    }).select('execution.attempts').lean();
    if (!dispatch) return;
    const terminal = Number(dispatch.execution?.attempts || 0) >= BROADCAST_DISPATCH_MAX_ATTEMPTS;
    await Broadcast.updateOne(
      { _id: broadcastId, 'execution.occurrenceKey': occurrenceKey, status: 'processing' },
      { $set: {
        ...(terminal ? { status: 'failed', 'execution.finishedAt': new Date() } : {}),
        'execution.lastError': errorMessage,
        'execution.lockedAt': null
      } }
    );
    return;
  }

  await BroadcastChunk.updateOne(
    { broadcast: broadcastId, occurrenceKey, chunkIndex, status: { $ne: 'completed' } },
    { $set: { status: 'failed', lastError: errorMessage, processingLeaseAt: null, workerJobId: '' } }
  );
  const broadcast = await Broadcast.findOne({
    _id: broadcastId,
    'execution.occurrenceKey': occurrenceKey,
    status: 'processing'
  }).lean();
  if (!broadcast) return;
  const [completedChunks, failedChunks] = await Promise.all([
    BroadcastChunk.countDocuments({ broadcast: broadcastId, occurrenceKey, status: 'completed' }),
    BroadcastChunk.countDocuments({ broadcast: broadcastId, occurrenceKey, status: 'failed' })
  ]);
  await Broadcast.updateOne(
    { _id: broadcastId, status: 'processing', 'execution.occurrenceKey': occurrenceKey },
    {
      $set: {
        'execution.completedChunks': completedChunks,
        'execution.lastError': errorMessage,
        'execution.lockedAt': new Date()
      }
    }
  );
  if (completedChunks + failedChunks >= Number(broadcast.execution?.totalChunks || 0)) {
    await refreshBroadcastMetrics(broadcastId);
    await Broadcast.updateOne(
      { _id: broadcastId, status: 'processing', 'execution.occurrenceKey': occurrenceKey },
      {
        $set: {
          status: 'failed',
          'execution.finishedAt': new Date(),
          'execution.lockedAt': null
        }
      }
    );
  }
};

const resolveOwnedRecipientLog = async (notification, userId) => {
  const deliveryLogId = notification?.broadcastRecipient || notification?.data?.deliveryLogId || notification?.data?.customData?.deliveryLogId;
  const broadcastId = notification?.data?.broadcastId || notification?.data?.customData?.broadcastId;
  if (!deliveryLogId || !broadcastId) return null;
  const recipientLog = await BroadcastRecipient.findOne({
    _id: deliveryLogId,
    broadcast: broadcastId,
    recipient: userId
  });
  if (!recipientLog) throw fail('Broadcast delivery record not found', 404);
  return recipientLog;
};

const trackDelivery = async ({ notification, userId, platform = 'unknown', metadata = {} }) => {
  const recipientLog = await resolveOwnedRecipientLog(notification, userId);
  if (!recipientLog) return { tracked: false, reason: 'not_broadcast' };
  if (!PLATFORMS.has(platform)) throw fail('Delivery acknowledgement platform is invalid');
  if (!['push', 'both'].includes(recipientLog.requestedDeliveryType)) {
    return { tracked: false, reason: 'push_not_requested' };
  }

  // Native callbacks are useful device-level delivery evidence, but provider
  // receipts remain authoritative for the channel state/retry machine. This
  // prevents a forged client acknowledgement from suppressing a real provider
  // failure while still supporting accurate platform analytics.
  if (platform === 'ios' || platform === 'android') {
    const eventResult = await BroadcastEvent.updateOne(
      { broadcastRecipient: recipientLog._id, eventType: 'delivered' },
      {
        $setOnInsert: {
          broadcast: recipientLog.broadcast,
          broadcastRecipient: recipientLog._id,
          recipient: userId,
          notification: notification?._id || null,
          eventType: 'delivered',
          platform,
          metadata: metadata && typeof metadata === 'object' ? metadata : {}
        }
      },
      { upsert: true }
    );
    const inserted = Boolean(eventResult?.upsertedCount || eventResult?.upsertedId);
    return {
      tracked: true,
      duplicate: !inserted,
      deliveryLogId: String(recipientLog._id),
      authority: 'client_event'
    };
  }

  if (!recipientLog.webPushEmittedAt) {
    return { tracked: false, reason: 'web_push_not_submitted' };
  }
  const now = new Date();
  const changed = await BroadcastRecipient.findOneAndUpdate(
    {
      _id: recipientLog._id,
      webPushAcknowledgedAt: null
    },
    {
      $set: {
        webPushAcknowledgedAt: now,
        webPushAckDeadlineAt: null,
        webPushAcknowledgedPlatform: 'web',
        'push.status': 'delivered',
        'push.deliveredAt': now,
        'push.failureReason': '',
        overallStatus: resolveOverallStatus('delivered', recipientLog.inApp?.status)
      }
    },
    { new: true }
  );
  const eventResult = await BroadcastEvent.updateOne(
    { broadcastRecipient: recipientLog._id, eventType: 'delivered' },
    {
      $setOnInsert: {
        broadcast: recipientLog.broadcast,
        broadcastRecipient: recipientLog._id,
        recipient: userId,
        notification: notification?._id || null,
        eventType: 'delivered',
        platform: 'web',
        metadata: metadata && typeof metadata === 'object' ? metadata : {}
      }
    },
    { upsert: true }
  );
  await NotificationFailure.updateMany(
    { broadcastRecipient: recipientLog._id, channel: 'push', status: { $in: ['open', 'retrying'] } },
    { $set: { status: 'resolved', resolvedAt: now } }
  );
  await refreshBroadcastMetrics(recipientLog.broadcast);
  const inserted = Boolean(eventResult?.upsertedCount || eventResult?.upsertedId);
  return { tracked: true, duplicate: !changed && !inserted, deliveryLogId: String(recipientLog._id), authority: 'client_event' };
};

const trackEvent = async ({ notification, userId, eventType, url = '', platform = 'unknown', metadata = {} }) => {
  const recipientLog = await resolveOwnedRecipientLog(notification, userId);
  if (!recipientLog) return { tracked: false, reason: 'not_broadcast' };
  if (!['open', 'click'].includes(eventType)) throw fail('Broadcast event type is invalid');

  // Opening a browser notification is also conclusive delivery evidence. The
  // explicit /delivered acknowledgement normally arrives first, but this
  // fallback keeps metrics correct if the client is interrupted between them.
  if (eventType === 'open' && platform === 'web' && recipientLog.webPushEmittedAt) {
    await trackDelivery({ notification, userId, platform, metadata: { source: 'open_fallback' } });
  }

  const now = new Date();
  const dateField = eventType === 'click' ? 'clickedAt' : 'openedAt';
  const update = { $set: { [dateField]: now } };
  if (eventType === 'click') update.$set.clickedUrl = safeString(url, 2048);
  const changed = await BroadcastRecipient.findOneAndUpdate(
    { _id: recipientLog._id, [dateField]: null },
    update,
    { new: true }
  );
  // Always upsert the event, even when the recipient timestamp was already
  // written. A process can fail between those two durable writes; a retry must
  // repair that crash window instead of permanently losing platform analytics.
  const eventResult = await BroadcastEvent.updateOne(
    { broadcastRecipient: recipientLog._id, eventType },
    {
      $setOnInsert: {
        broadcast: recipientLog.broadcast,
        broadcastRecipient: recipientLog._id,
        recipient: userId,
        notification: notification._id,
        eventType,
        url: safeString(url, 2048),
        platform: PLATFORMS.has(platform) ? platform : 'unknown',
        metadata: metadata && typeof metadata === 'object' ? metadata : {}
      }
    },
    { upsert: true }
  );
  const inserted = Boolean(eventResult?.upsertedCount || eventResult?.upsertedId);
  if (changed || inserted) await refreshBroadcastMetrics(recipientLog.broadcast);
  return { tracked: true, duplicate: !changed && !inserted, deliveryLogId: String(recipientLog._id) };
};

module.exports = {
  RECIPIENT_CHUNK_SIZE,
  WEB_PUSH_ACK_TIMEOUT_MS,
  normalizeAudience,
  normalizeSchedule,
  normalizeBroadcastPayload,
  buildAudienceQuery,
  assertTimezone,
  getTimezoneDayBounds,
  getMatchedNotificationClients,
  isBroadcastCategoryAllowed,
  getActor,
  createOccurrenceKey,
  nextRecurrenceDate,
  resolveEffectiveDeliveryType,
  resolveOverallStatus,
  resolvePushDeliveryStatus,
  resolveBroadcastDeepLink,
  resolveBroadcastWebUrl,
  buildNotificationData,
  assertBroadcastPushPayloadSize,
  processBroadcastDispatch,
  processBroadcastChunk,
  processBroadcastPushReceipts,
  reconcileTerminalPushReceipts,
  expireUnacknowledgedWebPushes,
  reconcileDirtyBroadcastMetrics,
  reconcileAcknowledgedNotificationFailures,
  refreshBroadcastMetrics,
  markBroadcastWorkerFailure,
  trackDelivery,
  trackEvent,
  fail
};
