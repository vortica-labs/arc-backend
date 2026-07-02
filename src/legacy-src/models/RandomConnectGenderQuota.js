const mongoose = require('mongoose');

const randomConnectGenderQuotaSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  dayKey: { type: String, required: true, maxlength: 10 },
  slotCount: { type: Number, min: 0, default: 0 },
  reservationKeys: [{ type: String, maxlength: 100 }],
  expiresAt: { type: Date, required: true }
}, { timestamps: true });

randomConnectGenderQuotaSchema.index(
  { user: 1, dayKey: 1 },
  { unique: true, name: 'one_random_connect_gender_quota_per_user_day' }
);
randomConnectGenderQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.RandomConnectGenderQuota ||
  mongoose.model('RandomConnectGenderQuota', randomConnectGenderQuotaSchema);
