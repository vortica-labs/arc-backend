const mongoose = require('mongoose');

const audienceSchema = new mongoose.Schema({
  allUsers: { type: Boolean, default: false },
  userTypes: [{ type: String, enum: ['player', 'team', 'creator'] }],
  premium: { type: String, enum: ['all', 'premium', 'non_premium'], default: 'all' },
  verifiedHost: { type: String, enum: ['all', 'verified', 'unverified'], default: 'all' },
  creatorMonetizationStatuses: [{
    type: String,
    enum: ['not_eligible', 'eligible', 'pending', 'approved', 'rejected', 'suspended', 'disabled', 'withdrawn']
  }],
  countries: [{ type: String, trim: true, maxlength: 100 }],
  states: [{ type: String, trim: true, maxlength: 100 }],
  cities: [{ type: String, trim: true, maxlength: 100 }],
  platforms: [{ type: String, enum: ['android', 'ios', 'web'] }],
  appVersions: [{ type: String, trim: true, maxlength: 40 }],
  lastActiveFrom: { type: Date, default: null },
  lastActiveTo: { type: Date, default: null },
  joinedFrom: { type: Date, default: null },
  joinedTo: { type: Date, default: null },
  followersMin: { type: Number, min: 0, default: null },
  followersMax: { type: Number, min: 0, default: null },
  premiumPlans: [{
    type: String,
    enum: ['free', 'player_pro', 'player_pro_plus', 'team_pro', 'team_org']
  }],
  userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  usernames: [{ type: String, trim: true, maxlength: 20 }],
  emails: [{ type: String, trim: true, lowercase: true, maxlength: 254 }]
}, { _id: false });

const broadcastSchema = new mongoose.Schema({
  // Drafts are intentionally allowed to be incomplete. The send boundary
  // performs strict normalized validation before any work is queued.
  title: { type: String, default: '', trim: true, maxlength: 100 },
  message: { type: String, default: '', trim: true, maxlength: 1000 },
  subtitle: { type: String, default: '', trim: true, maxlength: 160 },
  bannerImage: { type: String, default: '', trim: true, maxlength: 2048 },
  thumbnail: { type: String, default: '', trim: true, maxlength: 2048 },
  cta: {
    text: { type: String, default: '', trim: true, maxlength: 60 },
    url: { type: String, default: '', trim: true, maxlength: 2048 },
    deepLink: { type: String, default: '', trim: true, maxlength: 2048 },
    type: {
      type: String,
      enum: ['none', 'home', 'profile', 'tournament', 'recruitment', 'clip', 'post', 'story', 'random_connect', 'premium', 'creator_monetization', 'host_verification', 'custom'],
      default: 'none'
    }
  },
  priority: { type: String, enum: ['normal', 'high', 'critical'], default: 'normal' },
  category: {
    type: String,
    enum: ['announcement', 'update', 'maintenance', 'feature_release', 'tournament', 'recruitment', 'promotion', 'creator', 'premium', 'system', 'custom'],
    default: 'announcement'
  },
  customCategory: {
    type: String,
    default: '',
    trim: true,
    maxlength: 60
  },
  deliveryType: { type: String, enum: ['push', 'in_app', 'both'], default: 'both' },
  push: {
    badge: { type: Number, min: 0, max: 9999, default: null },
    sound: { type: String, default: 'default', trim: true, maxlength: 100 },
    ttl: { type: Number, min: 0, max: 2419200, default: 2419200 },
    collapseKey: { type: String, default: '', trim: true, maxlength: 100 }
  },
  audience: { type: audienceSchema, default: () => ({}) },
  schedule: {
    mode: { type: String, enum: ['draft', 'immediate', 'scheduled'], default: 'draft' },
    scheduledAt: { type: Date, default: null },
    timezone: { type: String, default: 'UTC', trim: true, maxlength: 100 },
    recurrence: { type: String, enum: ['once', 'daily', 'weekly', 'monthly', 'yearly'], default: 'once' },
    recurrenceInterval: { type: Number, min: 1, max: 365, default: 1 },
    recurrenceEndAt: { type: Date, default: null },
    nextRunAt: { type: Date, default: null }
  },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'queued', 'processing', 'sent', 'cancelled', 'failed'],
    default: 'draft',
    index: true
  },
  execution: {
    occurrenceKey: { type: String, default: '' },
    workerJobId: { type: String, default: '', maxlength: 250 },
    totalChunks: { type: Number, default: 0, min: 0 },
    completedChunks: { type: Number, default: 0, min: 0 },
    lockedAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    audienceSnapshotComplete: { type: Boolean, default: false },
    audienceSnapshotRecipients: { type: Number, default: 0, min: 0 },
    audienceSnapshotAt: { type: Date, default: null },
    lastError: { type: String, default: '', maxlength: 1000 }
  },
  metrics: {
    recipients: { type: Number, default: 0, min: 0 },
    delivered: { type: Number, default: 0, min: 0 },
    failed: { type: Number, default: 0, min: 0 },
    skipped: { type: Number, default: 0, min: 0 },
    opened: { type: Number, default: 0, min: 0 },
    clicked: { type: Number, default: 0, min: 0 },
    pushDelivered: { type: Number, default: 0, min: 0 },
    pushAttempted: { type: Number, default: 0, min: 0 },
    inAppDelivered: { type: Number, default: 0, min: 0 },
    retryableFailures: { type: Number, default: 0, min: 0 }
  },
  metricsSourceUpdatedAt: { type: Date, default: null },
  metricsRefresh: {
    requestedRevision: { type: Number, default: 0, min: 0 },
    appliedRevision: { type: Number, default: 0, min: 0 },
    lockKey: { type: String, default: '', maxlength: 100 },
    lockExpiresAt: { type: Date, default: null }
  },
  createdBy: {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: 'admin', trim: true },
    role: { type: String, default: 'admin', trim: true }
  },
  updatedBy: {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: 'admin', trim: true }
  },
  sentAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  creationIdempotencyKeyHash: { type: String, default: undefined, maxlength: 64 },
  creationPayloadHash: { type: String, default: undefined, maxlength: 64 }
}, {
  timestamps: true,
  optimisticConcurrency: true
});

broadcastSchema.index({ status: 1, 'schedule.nextRunAt': 1 });
broadcastSchema.index({ status: 1, createdAt: -1 });
broadcastSchema.index({ status: 1, sentAt: -1 });
broadcastSchema.index({ createdAt: -1 });
broadcastSchema.index({ sentAt: -1 });
broadcastSchema.index({ category: 1, status: 1, createdAt: -1 });
broadcastSchema.index({ 'createdBy.username': 1, createdAt: -1 });
broadcastSchema.index({ creationIdempotencyKeyHash: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.Broadcast || mongoose.model('Broadcast', broadcastSchema);
