const mongoose = require('mongoose');

const razorpayWebhookEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, trim: true, maxlength: 200, unique: true, index: true },
  eventType: { type: String, required: true, trim: true, maxlength: 120, index: true },
  rawBodyHash: { type: String, required: true, maxlength: 64 },
  providerCreatedAt: { type: Date, default: null, index: true },
  status: { type: String, enum: ['received', 'processing', 'processed', 'ignored', 'failed'], default: 'received', index: true },
  attempts: { type: Number, min: 0, default: 0 },
  claimToken: { type: String, maxlength: 100, default: '' },
  claimedAt: { type: Date, default: null },
  processedAt: { type: Date, default: null },
  membership: { type: mongoose.Schema.Types.ObjectId, ref: 'PremiumMembership', default: null, index: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  result: { type: mongoose.Schema.Types.Mixed, default: {} },
  errorCode: { type: String, maxlength: 100, default: '' },
  errorMessage: { type: String, maxlength: 500, default: '' }
}, { timestamps: true });

razorpayWebhookEventSchema.index({ status: 1, claimedAt: 1, createdAt: 1 });
razorpayWebhookEventSchema.index({ eventType: 1, providerCreatedAt: -1 });

module.exports = mongoose.models.RazorpayWebhookEvent || mongoose.model('RazorpayWebhookEvent', razorpayWebhookEventSchema);
