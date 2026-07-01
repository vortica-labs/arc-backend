const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  normalizeAudience,
  normalizeSchedule,
  normalizeBroadcastPayload,
  buildAudienceQuery,
  nextRecurrenceDate,
  getTimezoneDayBounds,
  resolveEffectiveDeliveryType,
  resolveOverallStatus,
  resolvePushDeliveryStatus,
  assertBroadcastPushPayloadSize,
  isBroadcastCategoryAllowed
} = require('./broadcastService');
const {
  serializeBroadcast,
  normalizeSearchTerm,
  applyLogFilters,
  createBroadcastPayloadHash,
  assertIdempotentCreateReplay
} = require('../controllers/broadcastController');
const {
  classifyBroadcastPushRecords,
  filterBroadcastTokens,
  isTransientExpoError,
  buildPushData,
  buildExpoMessages,
  getExpoMessageByteLength,
  assertExpoMessageSize,
  notificationMatchesClientContext,
  getPushProviderCapabilities
} = require('../utils/pushNotificationService');
const Broadcast = require('../models/Broadcast');
const BroadcastOccurrence = require('../models/BroadcastOccurrence');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const BroadcastTemplate = require('../models/BroadcastTemplate');
const Notification = require('../models/Notification');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
};

test('audience compiler refuses an implicit all-user broadcast', () => {
  assert.throws(
    () => normalizeAudience({}),
    /explicitly select allUsers/
  );
  assert.throws(
    () => buildAudienceQuery({ allUsers: false, accountTypes: [] }),
    /explicitly select allUsers/
  );
});

test('allUsers is explicit and clears stale disabled filters', () => {
  const audience = normalizeAudience({
    allUsers: true,
    accountTypes: ['team'],
    premium: 'premium',
    platforms: ['ios'],
    userIds: ['stale-invalid-id-that-must-be-ignored']
  });
  assert.strictEqual(audience.allUsers, true);
  assert.deepStrictEqual(audience.userTypes, []);
  assert.strictEqual(audience.premium, 'all');
  assert.deepStrictEqual(audience.platforms, []);
  const query = buildAudienceQuery(audience);
  assert.deepStrictEqual(query.userType, { $ne: 'admin' });
  assert.strictEqual(query.pushTokens, undefined);
});

test('simultaneous filters compile as an intersection', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const audience = normalizeAudience({
    allUsers: false,
    accountTypes: ['player', 'team'],
    premium: 'premium',
    hostVerification: 'verified',
    creatorMonetization: 'pending',
    countries: ['India'],
    states: ['Punjab'],
    cities: ['Chandigarh'],
    platforms: ['android', 'web'],
    appVersions: ['2.4.0'],
    lastActiveFrom: '2026-01-01T00:00:00.000Z',
    joinedTo: '2026-06-30',
    followersMin: 10,
    followersMax: 5000,
    premiumPlans: ['player_pro'],
    userIds: [userId],
    usernames: ['Example_User'],
    emails: ['USER@Example.com']
  });
  const query = buildAudienceQuery(audience);
  assert.deepStrictEqual(query.userType, { $in: ['player', 'team', 'creator'] });
  assert.strictEqual(query.isPremium, true);
  assert.strictEqual(query.isVerifiedHost, true);
  assert.deepStrictEqual(query.creatorMonetizationStatus, { $in: ['pending'] });
  assert.deepStrictEqual(query['membership.tier'], { $in: ['player_pro'] });
  assert(query.lastSeen.$gte instanceof Date);
  assert(query.createdAt.$lte instanceof Date);
  assert.strictEqual(query.createdAt.$lte.toISOString(), '2026-06-30T23:59:59.999Z');
  assert(Array.isArray(query.$and));
  assert(query.$and.length >= 6);
  const platformClause = query.$and.find((clause) => clause.$or?.some((entry) => entry.notificationClients));
  assert(platformClause, 'platform/app version must match durable clients or push tokens');
  const customClause = query.$and.find((clause) => clause.$or?.some((entry) => entry.username));
  const usernameRegex = customClause.$or.find((entry) => entry.username).username.$in[0];
  assert(usernameRegex.test('EXAMPLE_USER'));
  const emailSelector = customClause.$or.find((entry) => entry.email).email.$in;
  assert.deepStrictEqual(emailSelector, ['user@example.com']);
  const geoClause = query.$and.find((clause) => clause.$or?.some((entry) => entry['profile.location']));
  const geoMatch = geoClause.$or.find((entry) => entry['profile.location'])['profile.location'];
  const geoRegex = new RegExp(geoMatch.$regex, geoMatch.$options);
  assert(geoRegex.test('Chandigarh, Punjab, India'));
  assert(!geoRegex.test('Indiana, USA'));
});

test('invalid custom IDs and inverted ranges fail before MongoDB', () => {
  assert.throws(
    () => normalizeAudience({ userIds: ['not-an-object-id'] }),
    /Invalid custom user ID/
  );
  assert.throws(
    () => normalizeAudience({ followersMin: 20, followersMax: 10 }),
    /cannot be greater/
  );
  assert.throws(
    () => normalizeAudience({ lastActiveFrom: '2026-02-01', lastActiveTo: '2026-01-01' }),
    /cannot be after/
  );
  assert.throws(
    () => normalizeAudience({ emails: ['not-an-email'] }),
    /Invalid audience email/
  );
});

test('explicit contract typos fail closed instead of broadening or immediately sending', () => {
  assert.throws(
    () => normalizeAudience({ premium: 'premium', platforms: ['windows'] }),
    /audience\.platforms/
  );
  assert.throws(
    () => normalizeAudience({ premium: 'gold' }),
    /audience\.premium/
  );
  assert.throws(
    () => normalizeSchedule({ mode: 'scheduld', scheduledAt: '2026-08-01T00:00:00.000Z' }),
    /schedule\.mode/
  );
  assert.throws(
    () => normalizeSchedule({ mode: 'scheduled', scheduledAt: '2026-08-01T00:00:00.000Z', recurrence: { frequency: 'hourly' } }),
    /schedule\.recurrence\.frequency/
  );
  assert.throws(
    () => normalizeSchedule({ mode: 'scheduled', scheduledAt: '2026-08-01T00:00:00.000Z', recurrence: { frequency: 'daily', interval: 0 } }),
    /between 1 and 365/
  );
});

test('email targeting and category preferences are normalized consistently', () => {
  const audience = normalizeAudience({ customEmails: ['USER@Example.com', 'user@example.com'] });
  assert.deepStrictEqual(audience.emails, ['user@example.com']);
  assert.deepStrictEqual(buildAudienceQuery(audience).$and[0].email, { $in: ['user@example.com'] });
  assert.strictEqual(isBroadcastCategoryAllowed({ systemAlerts: false }, 'announcement'), true);
  assert.strictEqual(isBroadcastCategoryAllowed({ systemAlerts: false }, 'system'), false);
  assert.strictEqual(isBroadcastCategoryAllowed({ announcementsEnabled: false }, 'feature_release'), false);
  assert.strictEqual(isBroadcastCategoryAllowed({ marketingEnabled: false }, 'premium'), false);
  assert.strictEqual(isBroadcastCategoryAllowed({ promotionsEnabled: false }, 'promotion'), false);
  assert.strictEqual(isBroadcastCategoryAllowed({ marketingEnabled: false, promotionsEnabled: true }, 'promotion'), false);
  assert.strictEqual(isBroadcastCategoryAllowed({ mutedBroadcastCategories: ['tournament'] }, 'tournament'), false);
});

test('nested recurrence contract preserves interval, end date, and timezone', () => {
  const schedule = normalizeSchedule({
    mode: 'scheduled',
    scheduledAt: '2026-07-10T03:30:00.000Z',
    timezone: 'Asia/Kolkata',
    recurrence: { frequency: 'weekly', interval: 2, endAt: '2027-01-01T00:00:00.000Z' }
  });
  assert.strictEqual(schedule.recurrence, 'weekly');
  assert.strictEqual(schedule.recurrenceInterval, 2);
  assert.strictEqual(schedule.timezone, 'Asia/Kolkata');
  assert(schedule.recurrenceEndAt instanceof Date);
  assert.throws(() => normalizeSchedule({ mode: 'scheduled', timezone: 'Not/A_Zone' }), /scheduledAt is required|IANA/);
});

test('recurrence preserves local wall-clock time across DST', () => {
  // 9am New York: EST on March 7, EDT on March 8.
  const next = nextRecurrenceDate('2026-03-07T14:00:00.000Z', 'daily', 1, 'America/New_York');
  assert.strictEqual(next.toISOString(), '2026-03-08T13:00:00.000Z');
});

test('calendar recurrence clamps month days and moves DST gaps forward', () => {
  assert.strictEqual(
    nextRecurrenceDate('2027-01-31T09:00:00.000Z', 'monthly', 1, 'UTC').toISOString(),
    '2027-02-28T09:00:00.000Z'
  );
  assert.strictEqual(
    nextRecurrenceDate('2024-02-29T09:00:00.000Z', 'yearly', 1, 'UTC').toISOString(),
    '2025-02-28T09:00:00.000Z'
  );
  // 02:30 does not exist on this New York date; later disambiguation yields 03:30.
  assert.strictEqual(
    nextRecurrenceDate('2026-03-07T07:30:00.000Z', 'daily', 1, 'America/New_York').toISOString(),
    '2026-03-08T07:30:00.000Z'
  );
});

test('timezone day bounds validate IANA zones and honor short DST days', () => {
  const bounds = getTimezoneDayBounds('America/New_York', '2026-03-08T12:00:00.000Z');
  assert.strictEqual(bounds.timezone, 'America/New_York');
  assert.strictEqual(bounds.start.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.strictEqual(bounds.end.toISOString(), '2026-03-09T04:00:00.000Z');
  assert.throws(() => getTimezoneDayBounds('Not/A_Zone'), /valid IANA timezone/);
});

const validPayload = {
  title: 'Feature update',
  message: 'A useful announcement',
  cta: { text: 'Open', type: 'home' },
  priority: 'normal',
  category: 'update',
  deliveryType: 'both',
  audience: { allUsers: true },
  schedule: { mode: 'immediate', timezone: 'UTC', recurrence: { frequency: 'once', interval: 1 } },
  push: { badge: 1, sound: 'default', ttl: 3600, collapseKey: 'feature-update' }
};

test('CTA and media validators allow production schemes only', () => {
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, deliveryType: 'email' }),
    /deliveryType/
  );
  for (const url of ['/premium', 'https://squadhunt.in/premium', 'arcmobile://premium', 'com.arcsquadhunt://premium']) {
    assert.strictEqual(normalizeBroadcastPayload({ ...validPayload, cta: { type: 'custom', url } }).cta.url, url);
  }
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, cta: { type: 'custom', url: 'javascript:alert(1)' } }),
    /invalid/
  );
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, cta: { type: 'custom', url: '/%2f%2fevil.example' } }),
    /invalid/
  );
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, bannerImage: 'http://example.com/image.png' }),
    /HTTPS/
  );
  const deepLinkOnly = normalizeBroadcastPayload({
    ...validPayload,
    cta: { text: 'Open', type: 'custom', url: '', deepLink: 'arc://premium' }
  }).cta;
  assert.strictEqual(deepLinkOnly.url, 'arc://premium');
  assert.strictEqual(deepLinkOnly.deepLink, 'arc://premium');
  const splitDestination = normalizeBroadcastPayload({
    ...validPayload,
    cta: { type: 'custom', url: 'https://squadhunt.in/premium', deepLink: 'arc://premium' }
  }).cta;
  assert.strictEqual(splitDestination.url, 'https://squadhunt.in/premium');
  assert.strictEqual(splitDestination.deepLink, 'arc://premium');
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, cta: { type: 'tournament', text: '' } }),
    /destination is required/
  );
});

test('drafts may be incomplete but strict delivery normalization rejects them', () => {
  const draft = normalizeBroadcastPayload({}, { allowIncomplete: true });
  assert.strictEqual(draft.title, '');
  assert.strictEqual(draft.message, '');
  assert.strictEqual(draft.audience.allUsers, false);
  assert.throws(() => normalizeBroadcastPayload(draft), /Title is required/);
  assert.strictEqual(new Broadcast(draft).validateSync(), undefined);
});

test('create idempotency binds a key replay to the normalized payload hash', () => {
  const first = normalizeBroadcastPayload({ ...validPayload, title: '  Feature update  ' });
  const equivalent = normalizeBroadcastPayload({ ...validPayload, title: 'Feature update' });
  const changed = normalizeBroadcastPayload({ ...validPayload, title: 'Different' });
  const reorderedAudience = normalizeBroadcastPayload({
    ...validPayload,
    audience: { platforms: ['web', 'ios'] }
  });
  const equivalentAudience = normalizeBroadcastPayload({
    ...validPayload,
    audience: { platforms: ['ios', 'web'] }
  });
  const firstHash = createBroadcastPayloadHash(first);
  assert.strictEqual(firstHash, createBroadcastPayloadHash(equivalent));
  assert.strictEqual(createBroadcastPayloadHash(reorderedAudience), createBroadcastPayloadHash(equivalentAudience));
  assert.doesNotThrow(() => assertIdempotentCreateReplay({ creationPayloadHash: firstHash }, firstHash));
  let error;
  try {
    assertIdempotentCreateReplay({ creationPayloadHash: firstHash }, createBroadcastPayloadHash(changed));
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /different broadcast payload/);
  assert.strictEqual(error.statusCode, 409);
  assert(Broadcast.schema.path('creationPayloadHash'));
});

test('delivery-log query helpers safely combine filters and bounded regex searches', () => {
  const escapedBoundary = normalizeSearchTerm(`${'a'.repeat(99)}*`);
  assert.doesNotThrow(() => new RegExp(escapedBoundary, 'i'));
  assert(escapedBoundary.endsWith('\\*'));

  const filter = {};
  applyLogFilters(filter, { status: 'queued', platform: 'unknown', deliveryType: 'push' });
  assert.strictEqual(filter.overallStatus, 'pending');
  assert.strictEqual(filter.requestedDeliveryType, 'push');
  assert(filter.$and[0].$or.some((entry) => entry['recipientSnapshot.platforms']?.$size === 0));
  assert.throws(() => applyLogFilters({}, { status: 'made_up' }), /status filter is invalid/);
  assert.throws(
    () => applyLogFilters({}, { from: '2026-08-02', to: '2026-08-01' }),
    /from cannot be after to/
  );

  const recipientIndexes = BroadcastRecipient.schema.indexes().map(([key]) => JSON.stringify(key));
  assert(recipientIndexes.includes(JSON.stringify({ createdAt: -1 })));
  assert(recipientIndexes.includes(JSON.stringify({ overallStatus: 1, createdAt: -1 })));
  assert(recipientIndexes.includes(JSON.stringify({ 'recipientSnapshot.platforms': 1, createdAt: -1 })));
  const templateIndexes = BroadcastTemplate.schema.indexes().map(([key]) => JSON.stringify(key));
  assert(templateIndexes.includes(JSON.stringify({ isActive: 1, 'content.category': 1, updatedAt: -1 })));
});

test('database validators preserve the broadcast content contract', () => {
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, message: 'x'.repeat(1001) }),
    /cannot exceed 1000/
  );
  const incompleteCustomDraft = new Broadcast({
    title: 'Custom',
    category: 'custom',
    customCategory: '',
    audience: {}
  }).validateSync();
  assert.strictEqual(incompleteCustomDraft, undefined);
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, category: 'custom', customCategory: '' }),
    /Custom category is required/
  );
  const longNotification = new Notification({
    recipient: new mongoose.Types.ObjectId(),
    type: 'system',
    title: 'Broadcast',
    message: 'x'.repeat(1000)
  });
  assert.strictEqual(longNotification.validateSync(), undefined);
  const lifecycleNotification = new Notification({
    recipient: new mongoose.Types.ObjectId(),
    type: 'system',
    title: 'Lifecycle',
    message: 'Archived safely',
    archivedAt: new Date(),
    deletedAt: null
  });
  assert.strictEqual(lifecycleNotification.validateSync(), undefined);
});

test('push provider abstraction documents Expo downstream transports', () => {
  const capabilities = getPushProviderCapabilities();
  assert.strictEqual(capabilities.name, 'expo');
  assert.deepStrictEqual(capabilities.downstreamTransports, ['fcm', 'apns']);
  assert.strictEqual(capabilities.maxPayloadBytes, 4096);
});

test('admin serializer matches the Web contract', () => {
  const id = new mongoose.Types.ObjectId();
  const serialized = serializeBroadcast({
    _id: id,
    title: 'Test',
    message: 'Test body',
    status: 'processing',
    audience: { allUsers: false, userTypes: ['player'], creatorMonetizationStatuses: ['approved'] },
    schedule: {
      mode: 'scheduled',
      scheduledAt: new Date('2026-08-01T00:00:00.000Z'),
      timezone: 'UTC',
      recurrence: 'monthly',
      recurrenceInterval: 2,
      recurrenceEndAt: new Date('2027-01-01T00:00:00.000Z')
    },
    metrics: { recipients: 10, delivered: 8, failed: 1, skipped: 1, opened: 4, clicked: 2 }
  });
  assert.strictEqual(serialized.id, id.toString());
  assert.strictEqual(serialized.status, 'sending');
  assert.deepStrictEqual(serialized.audience.accountTypes, ['player']);
  assert.strictEqual(serialized.audience.creatorMonetization, 'enabled');
  assert.strictEqual(serialized.schedule.recurrence.frequency, 'monthly');
  assert.strictEqual(serialized.schedule.recurrence.interval, 2);
  assert.strictEqual(serialized.recipientCount, 10);
  assert.strictEqual(serialized.analytics.recipients, 10);
});

test('preference fallback and provider receipts resolve delivery status safely', () => {
  assert.strictEqual(resolveEffectiveDeliveryType({ push: false, inApp: true }), 'in_app');
  assert.strictEqual(resolveEffectiveDeliveryType({ push: true, inApp: true }), 'both');
  assert.strictEqual(resolvePushDeliveryStatus({ sent: 1, accepted: 1, receiptOk: 0, receiptFailed: 1 }), 'failed');
  assert.strictEqual(resolvePushDeliveryStatus({ sent: 1, accepted: 1, receiptOk: 0, receiptFailed: 0, receiptUnavailable: 1 }), 'delivered');
  assert.strictEqual(resolvePushDeliveryStatus({ sent: 0 }), 'skipped');
  assert.strictEqual(resolveOverallStatus('processing', 'skipped'), 'processing');
  assert.strictEqual(resolveOverallStatus('processing', 'delivered'), 'partial');
});

test('broadcast push targeting filters platform and app version on the same device token', () => {
  const user = {
    pushTokens: [
      { token: 'ExponentPushToken[ios-current]', platform: 'ios', appVersion: '3.2.0', deviceName: 'iPhone', lastUsedAt: new Date() },
      { token: 'ExponentPushToken[ios-stale]', platform: 'ios', appVersion: '3.2.0', deviceName: 'Old iPhone', lastUsedAt: new Date('2020-01-01') },
      { token: 'ExponentPushToken[ios-old-version]', platform: 'ios', appVersion: '3.1.0', deviceName: 'Old version', lastUsedAt: new Date() },
      { token: 'ExponentPushToken[android-current]', platform: 'android', appVersion: '3.2.0', deviceName: 'Pixel', lastUsedAt: new Date() }
    ]
  };
  const matched = filterBroadcastTokens(user, { platforms: ['ios'], appVersions: ['3.2.0'] });
  assert.deepStrictEqual(matched.map((entry) => entry.token), ['ExponentPushToken[ios-current]']);
});

test('durable provider states distinguish tickets, receipts, and transient retries', () => {
  assert.strictEqual(classifyBroadcastPushRecords([]).status, 'skipped');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'accepted', receiptStatus: 'pending' }]).status, 'processing');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'accepted', receiptStatus: 'delivered', providerTicketId: 'ticket-1' }]).status, 'delivered');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'failed', receiptStatus: 'failed', providerErrorCode: 'DeviceNotRegistered' }]).status, 'failed');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'skipped', receiptStatus: 'skipped' }]).status, 'skipped');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'cancelled', receiptStatus: 'cancelled' }]).status, 'skipped');
  assert.strictEqual(isTransientExpoError('MessageRateExceeded'), true);
  assert.strictEqual(isTransientExpoError('DeviceNotRegistered'), false);
});

test('device-scoped inbox visibility requires both platform and app version', () => {
  const targeted = { data: { targetPlatforms: ['ios'], targetAppVersions: ['3.2.0'] } };
  assert.strictEqual(notificationMatchesClientContext(targeted, 'ios', '3.2.0'), true);
  assert.strictEqual(notificationMatchesClientContext(targeted, 'ios', '3.1.0'), false);
  assert.strictEqual(notificationMatchesClientContext(targeted, 'web', '3.2.0'), false);
  assert.strictEqual(notificationMatchesClientContext({ data: {} }, 'web', '1.0.0'), true);
});

test('broadcast push data stays compact and enforces the provider byte ceiling', () => {
  const notification = {
    _id: new mongoose.Types.ObjectId(),
    type: 'system',
    title: 'Compact',
    message: 'Payload',
    data: {
      broadcastId: new mongoose.Types.ObjectId(),
      deliveryLogId: new mongoose.Types.ObjectId(),
      deepLink: '/premium',
      bannerImage: `https://cdn.example/${'x'.repeat(500)}`,
      cta: { text: 'Upgrade', url: '/premium', type: 'premium' },
      customData: {
        category: 'premium',
        priority: 'high',
        targetPlatforms: ['ios'],
        targetAppVersions: ['3.2.0']
      }
    }
  };
  const compact = buildPushData(notification);
  assert.strictEqual(compact.deepLink, '/premium');
  assert.strictEqual(compact.hasCta, true);
  assert.strictEqual(compact.bannerImage, undefined);
  assert.strictEqual(compact.cta, undefined);
  assert(getExpoMessageByteLength({ data: 'x'.repeat(4000) }) < 4096);
  assert.throws(() => assertExpoMessageSize({ data: 'x'.repeat(4096) }), /maximum is/);
  assert(assertBroadcastPushPayloadSize(validPayload) < 4096);
  const [richMessage] = buildExpoMessages(
    ['ExponentPushToken[ios-rich-image]'],
    {
      _id: new mongoose.Types.ObjectId(),
      title: 'Rich broadcast',
      message: 'Image attachment',
      data: { customData: { pushOptions: { image: 'https://cdn.example/banner.jpg' } } }
    },
    1
  );
  assert.deepStrictEqual(richMessage.richContent, { image: 'https://cdn.example/banner.jpg' });
  assert.strictEqual(richMessage.mutableContent, true);
  const [plainMessage] = buildExpoMessages(
    ['ExponentPushToken[ios-plain]'],
    { _id: new mongoose.Types.ObjectId(), title: 'Plain', message: 'No image', data: {} },
    1
  );
  assert.strictEqual(plainMessage.mutableContent, undefined);
  const longUrl = `https://example.com/${'x'.repeat(2028)}`;
  assert.throws(
    () => assertBroadcastPushPayloadSize({ ...validPayload, bannerImage: longUrl, cta: { text: 'Open', type: 'custom', url: longUrl } }),
    /maximum is/
  );
});

test('broadcast Expo alerts opt into iOS background processing without changing generic pushes', () => {
  const [broadcastMessage] = buildExpoMessages(
    ['ExponentPushToken[ios-broadcast-background]'],
    {
      _id: new mongoose.Types.ObjectId(),
      title: 'Visible broadcast',
      message: 'Foreground alert body',
      data: { broadcastId: new mongoose.Types.ObjectId() }
    },
    1
  );
  assert.strictEqual(broadcastMessage._contentAvailable, true);
  assert.strictEqual(broadcastMessage.title, 'Visible broadcast');
  assert.strictEqual(broadcastMessage.body, 'Foreground alert body');
  assert(getExpoMessageByteLength(broadcastMessage) < 4096);

  const [genericMessage] = buildExpoMessages(
    ['ExponentPushToken[ios-generic-alert]'],
    {
      _id: new mongoose.Types.ObjectId(),
      title: 'Generic alert',
      message: 'No background wake',
      data: {}
    },
    1
  );
  assert.strictEqual(genericMessage._contentAvailable, undefined);
});

test('Android broadcast alerts use priority-specific channels while generic system alerts stay default', () => {
  const buildAlert = (data) => buildExpoMessages(
    ['ExponentPushToken[android-channel-contract]'],
    {
      _id: new mongoose.Types.ObjectId(),
      type: 'system',
      title: 'Channel contract',
      message: 'Visible alert',
      data
    },
    1
  )[0];

  assert.strictEqual(
    buildAlert({ broadcastId: new mongoose.Types.ObjectId(), customData: { priority: 'normal' } }).channelId,
    'broadcasts'
  );
  assert.strictEqual(
    buildAlert({ customData: { broadcastId: new mongoose.Types.ObjectId(), priority: 'high' } }).channelId,
    'broadcasts-high'
  );
  assert.strictEqual(
    buildAlert({ broadcastId: new mongoose.Types.ObjectId(), customData: { priority: 'critical' } }).channelId,
    'broadcasts-critical'
  );
  assert.strictEqual(buildAlert({}).channelId, 'default');
});

test('route ordering and tracking endpoints are unambiguous', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const adminRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'admin', 'broadcast.routes.ts'), 'utf8');
  const templateRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'admin', 'broadcast-template.routes.ts'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'controllers', 'broadcastController.js'), 'utf8');
  const notificationRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'notifications', 'notifications.routes.ts'), 'utf8');
  const notificationService = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'services', 'broadcastService.js'), 'utf8');
  const userController = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'controllers', 'userController.js'), 'utf8');
  const storyRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'stories', 'stories.routes.ts'), 'utf8');
  assert(adminRoutes.indexOf('/delivery-logs') < adminRoutes.indexOf('/:id'));
  assert(adminRoutes.indexOf('/preview') < adminRoutes.indexOf('/:id'));
  assert(notificationRoutes.includes('router.post("/:id/open"'));
  assert(notificationRoutes.includes('router.post("/:id/click"'));
  assert(notificationRoutes.includes('router.post("/:id/delivered"'));
  assert(notificationRoutes.includes('router.put("/:id/archive"'));
  assert(notificationRoutes.includes('router.put("/:id/unarchive"'));
  assert(notificationRoutes.includes('notification.deletedAt = new Date()'));
  assert(storyRoutes.indexOf('router.get("/:storyId"') < storyRoutes.indexOf('router.get("/:storyId/views"'));
  assert(controllerSource.includes("!['draft', 'scheduled'].includes(existing.status)"));
  assert(controllerSource.includes("status: 'draft'"), 'create must be side-effect-free and require the send endpoint');
  assert(controllerSource.includes("{ status: { $in: ['queued', 'processing', 'sent', 'failed'] } }"));
  assert(controllerSource.includes("existing.status = 'draft'"), 'scheduled-to-immediate edits must demote before send');
  assert(controllerSource.includes('retryOccurrenceKey'), 'failed sends must resume their immutable occurrence');
  assert(adminRoutes.includes('requireAdminPermission("broadcasts:send")'));
  assert(adminRoutes.includes('router.post("/:id/retry-failed"'));
  assert(notificationRoutes.includes('isRead: false'));
  assert(notificationRoutes.includes('A click implies an open'));
  assert(!notificationRoutes.includes('source: "mark_read"'), 'mark-read must not steal explicit open platform attribution');
  assert(notificationRoutes.includes('buildClientVisibilityFilter'));
  assert(notificationRoutes.includes('notificationClients.clientId": clientId'));
  assert(notificationRoutes.includes('VALID_TRACKING_PLATFORMS'));
  assert(notificationRoutes.includes('VALID_BROADCAST_CATEGORIES'));
  assert(notificationRoutes.includes('recipient: userId'));
  assert(notificationRoutes.includes('alreadyRead'));
  assert(notificationRoutes.includes('totalNotifications'));
  assert(notificationRoutes.includes('totalItems'));
  const nativeDeliverySource = notificationService.slice(
    notificationService.indexOf('const trackDelivery ='),
    notificationService.indexOf('const trackEvent =')
  );
  assert(nativeDeliverySource.includes("platform === 'ios' || platform === 'android'"));
  assert(nativeDeliverySource.includes("authority: 'client_event'"));
  const engagementSource = notificationService.slice(notificationService.indexOf('const trackEvent ='));
  assert(engagementSource.includes('Always upsert the event'));
  assert(!engagementSource.includes('if (!changed) return { tracked: true, duplicate: true }'));
  assert(userController.includes('Unknown notification setting'));
  assert(userController.includes('mutedBroadcastCategories must be an array'));
  assert(controllerSource.includes("creationIdempotencyKeyHash"));
  assert(controllerSource.includes("creationPayloadHash"));
  assert(controllerSource.includes("Idempotency-Key"));
  assert(controllerSource.includes("{ status: 'cancelled' }"), 'History must include every cancelled broadcast');
  assert(controllerSource.includes("BroadcastTemplate.findOne({ name: payload.name, isActive: false })"));
  assert(!templateRoutes.includes('durableMutationAudit("VIEW_BROADCAST_TEMPLATES")'));
  assert(templateRoutes.includes('durableMutationAudit("CREATE_BROADCAST_TEMPLATE")'));
});

test('queue and recipient source contracts include durable idempotency and preference fallback', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const queueSource = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'jobs', 'queue.ts'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(__dirname, 'broadcastService.js'), 'utf8');
  const notificationModel = fs.readFileSync(path.resolve(__dirname, '..', 'models', 'Notification.js'), 'utf8');
  const auditModel = fs.readFileSync(path.resolve(__dirname, '..', 'models', 'AdminAuditLog.js'), 'utf8');
  const pushSource = fs.readFileSync(path.resolve(__dirname, '..', 'utils', 'pushNotificationService.js'), 'utf8');
  const receiptModel = fs.readFileSync(path.resolve(__dirname, '..', 'models', 'BroadcastPushReceipt.js'), 'utf8');
  const failureModel = fs.readFileSync(path.resolve(__dirname, '..', 'models', 'NotificationFailure.js'), 'utf8');
  assert(queueSource.includes('broadcastJobId("broadcast-chunk"'));
  assert(queueSource.includes('status: "processing"'));
  assert(queueSource.includes('recovery-${Math.floor(Date.now() / 60000)}'));
  assert(serviceSource.includes("BroadcastChunk.findOneAndUpdate"));
  assert(serviceSource.includes("status: 'completed'"));
  assert(!serviceSource.includes('if (pushRequested && !pushAllowed && inAppAllowed)'));
  assert(serviceSource.includes("const inAppRequested = broadcast.deliveryType === 'in_app' || broadcast.deliveryType === 'both'"));
  assert(serviceSource.includes("inAppStatus === 'delivered'"));
  assert(notificationModel.includes('broadcastRecipient'));
  assert(auditModel.includes('Admin audit logs are immutable'));
  assert(queueSource.includes('"reconcile-receipts"'));
  assert(queueSource.includes('queuedPushRetries'), 'scheduler must recover transient queued sends');
  assert(pushSource.includes('chunk(claimedRecords, EXPO_MAX_BATCH_SIZE)'));
  assert(pushSource.includes('currentKeys.has(`${record.broadcastRecipient}:${record.tokenHash}`)'));
  assert(pushSource.includes('retryRecipientLogIds'));
  assert(receiptModel.includes('{ broadcastRecipient: 1, tokenHash: 1 }'));
  assert(receiptModel.includes('sendAttempts'));
  assert(queueSource.includes('EXPO_BROADCAST_SEND_MAX_ATTEMPTS'));
  assert(queueSource.includes('SendRetryExhausted'));
  assert(queueSource.includes('reconcileTerminalPushReceipts'));
  assert(queueSource.includes('BROADCAST_SEND_MAX_ATTEMPTS'));
  assert(queueSource.includes('broadcastIds'), 'receipt jobs must identify broadcasts for cancellation');
  assert(serviceSource.includes('chunkRecord.recipientIds.map(String)'), 'recovery must enqueue the persisted audience snapshot');
  assert(serviceSource.includes("_id: { $in: chunk.recipientIds }"), 'workers must ignore stale job recipient arrays');
  assert(serviceSource.includes("status: { $ne: 'cancelled' }"), 'provider retries must reject cancelled broadcasts');
  assert(serviceSource.includes("ticketStatus: 'cancelled'"));
  assert(serviceSource.includes("ticketStatus: 'skipped'"), 'preference opt-outs must not become provider failures');
  assert(serviceSource.includes("const inAppRequested = broadcast.deliveryType === 'both' || broadcast.deliveryType === 'in_app'"));
  assert(serviceSource.includes('emitBroadcastPushNotification'));
  assert(serviceSource.includes('expireUnacknowledgedWebPushes'));
  assert(serviceSource.includes("status: 'resolved'"), 'DLQ entries must resolve after a successful retry');
  assert(failureModel.includes("enum: ['open', 'retrying', 'resolved']"));
  assert(pushSource.includes('tokenPreview: previewPushToken'));
  assert(!pushSource.includes('token: receiptRequest.token'), 'provider logs must not expose raw tokens');
  assert(!receiptModel.includes('token: { type: String'), 'provider logs must not persist raw device tokens');
});

test('multi-instance socket delivery uses dedicated Redis adapter clients', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const socketSource = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'websocket', 'socket.ts'), 'utf8');
  const redisSource = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'cache', 'redis.ts'), 'utf8');
  const serverSource = fs.readFileSync(path.join(backendRoot, 'server.ts'), 'utf8');
  assert(socketSource.includes('createAdapter(socketRedisPubClient, socketRedisSubClient)'));
  assert(redisSource.includes('socketRedisPubClient'));
  assert(redisSource.includes('socketRedisSubClient'));
  assert(redisSource.includes('disconnectRedis'));
  assert(serverSource.includes('attachSocketRedisAdapter(io)'));
  assert(serverSource.includes('await disconnectRedis()'));
});

test('production hardening contracts cover retries, audit, indexes, and provider bounds', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const queueSource = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'jobs', 'queue.ts'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'services', 'broadcastService.js'), 'utf8');
  const pushSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'utils', 'pushNotificationService.js'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'controllers', 'broadcastController.js'), 'utf8');
  const adminAuthSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'middleware', 'adminAuth.js'), 'utf8');
  const adminRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'admin', 'broadcast.routes.ts'), 'utf8');
  const migrationSource = fs.readFileSync(path.join(backendRoot, '..', 'scripts', 'migrate-broadcast-indexes.js'), 'utf8');

  assert.strictEqual(isTransientExpoError('ExpoRequestTimeout'), true);
  assert(pushSource.includes('AbortController'));
  assert(pushSource.includes('req.setTimeout(EXPO_PUSH_REQUEST_TIMEOUT_MS'));
  assert(pushSource.includes('Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}`'));
  assert(pushSource.includes('EXPO_PUSH_TOKEN_MAX_LENGTH'));
  assert(pushSource.includes('messageBuildFailures'), 'one malformed device payload must not fail sibling tokens');
  assert(pushSource.includes("providerErrorCode: 'RetryTokenUnavailable'"));
  assert(pushSource.includes('activeBatchBroadcastIds'), 'every provider batch must re-check cancellation');
  assert(serviceSource.includes("'x'.repeat(512 - tokenPrefix.length - 1)"), 'preflight must use the maximum accepted token size');

  assert(queueSource.includes('(isProcessing || isQueued) && broadcast.execution?.occurrenceKey'));
  assert(queueSource.includes('reconcileDirtyBroadcastMetrics(100)'));
  assert(queueSource.includes('reconcileAcknowledgedNotificationFailures(1000)'));
  assert(queueSource.includes('], 0, 4999, true)'), 'queue cleanup must remain bounded');
  assert(serviceSource.includes('BroadcastOccurrence.findOneAndUpdate'));
  assert(serviceSource.includes('occurrenceByKey'));
  assert(serviceSource.includes('const deliveryBroadcast = { ...occurrence.snapshot, _id: broadcast._id }'));
  assert(serviceSource.includes("$inc: { 'execution.attempts': 1, __v: 1 }"));
  assert.strictEqual(BroadcastOccurrence.schema.options.timestamps.updatedAt, false);
  assert(controllerSource.includes('await removeBroadcastJobs(String(broadcast._id))'));
  assert(controllerSource.includes('`manual-${Date.now()}`'), 'manual retries need a fresh deterministic queue suffix');
  assert(controllerSource.includes('(existing.schedule?.nextRunAt || existing.schedule?.scheduledAt)'));
  assert(controllerSource.includes("error?.name === 'VersionError'"));
  assert(serviceSource.includes("'schedule.scheduledAt': nextRunAt"));

  assert(adminAuthSource.includes('durableMutationAudit'));
  assert(adminAuthSource.includes("`${action}_INTENT`"));
  assert(adminAuthSource.includes("`${action}_OUTCOME`"));
  assert(!adminRoutes.includes('durableMutationAudit("VIEW_BROADCAST_ANALYTICS")'));
  assert(!adminRoutes.includes('durableMutationAudit("PREVIEW_BROADCAST")'));
  assert(adminRoutes.includes('auditLog("VIEW_BROADCAST_ANALYTICS")'));
  assert(adminRoutes.includes('durableMutationAudit("SEND_BROADCAST")'));
  assert(migrationSource.includes("'BroadcastOccurrence'"));
  assert(migrationSource.includes("'AdminAuditLog'"));
  assert(migrationSource.includes('Model.createIndexes()'));

  assert(serviceSource.includes('webPushAcknowledgedAt: null'));
  assert(serviceSource.includes("? { ...providerResult, status: 'delivered'"));
  assert(serviceSource.includes("$inc: { 'metricsRefresh.requestedRevision': 1 }"));
  assert(serviceSource.includes("'metricsRefresh.appliedRevision': targetRevision"));
  assert(serviceSource.includes("'metricsRefresh.requestedRevision': targetRevision"));
  assert(serviceSource.includes('reconcileDirtyBroadcastMetrics'));
  assert(serviceSource.includes('await requestBroadcastMetricsRefresh(broadcastId)'));
  assert(!serviceSource.includes('return Broadcast.updateOne({ _id: broadcastId }, { $inc: increments })'));
  const trackDeliverySource = serviceSource.slice(
    serviceSource.indexOf('const trackDelivery ='),
    serviceSource.indexOf('const trackEvent =')
  );
  assert(!trackDeliverySource.includes("'push.status': { $in:"), 'first valid Web ACK must override a prior native failure');
  assert(trackDeliverySource.includes("status: { $in: ['open', 'retrying'] }"));
  const trackEventSource = serviceSource.slice(serviceSource.indexOf('const trackEvent ='));
  assert(!trackEventSource.includes("update.$set['push.status']"), 'Web open must use the atomic delivery ACK path');
  assert(!trackEventSource.includes('{ $inc: { [`metrics.'), 'engagement metrics must use authoritative refresh');
  assert(serviceSource.includes('const reconcileAcknowledgedNotificationFailures'));
  assert(serviceSource.includes("from: BroadcastRecipient.collection.name"));
  assert(controllerSource.includes('BroadcastPushReceipt.aggregate'));
  assert(controllerSource.includes('BroadcastEvent.aggregate'));
  assert(controllerSource.includes("platformBreakdownBasis: 'provider_device_receipts_and_client_events'"));
  assert(controllerSource.includes('providerRecipients.map'), 'provider retries must only reset rows backed by receipt jobs');
  assert(controllerSource.includes('webPushAckDeadlineAt: ackDeadline'), 'Web retries need a fresh ACK deadline');
  assert(controllerSource.includes("? 'mixed'"), 'native and Web retry paths must coexist in one batch');
});

console.log(`Broadcast backend contracts passed (${passed})`);
