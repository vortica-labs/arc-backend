const mongoose = require('mongoose');

const randomConnectAdmissionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  leaseToken: { type: String, default: '', maxlength: 100 },
  operation: { type: String, enum: ['join', 'next', 'leave', 'disconnect', 'cleanup'], default: 'join' },
  acquiredAt: { type: Date, default: null },
  leaseExpiresAt: { type: Date, default: null, index: true },
  lastCompletedAt: { type: Date, default: null },
  lastOperation: { type: String, enum: ['', 'join', 'next', 'leave', 'disconnect', 'cleanup'], default: '' }
}, { timestamps: true });

randomConnectAdmissionSchema.index(
  { user: 1 },
  { unique: true, name: 'one_random_connect_admission_per_user' }
);
randomConnectAdmissionSchema.index({ leaseExpiresAt: 1, leaseToken: 1 });

module.exports = mongoose.models.RandomConnectAdmission ||
  mongoose.model('RandomConnectAdmission', randomConnectAdmissionSchema);
