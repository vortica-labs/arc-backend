const mongoose = require('mongoose');

const paymentTransactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['subscription', 'tournament', 'boost', 'scrim', 'other'],
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'INR',
    uppercase: true
  },
  status: {
    type: String,
    enum: ['completed', 'pending', 'failed', 'refunded'],
    default: 'completed',
    index: true
  },
  description: {
    type: String,
    default: ''
  },
  orderId: {
    type: String,
    index: true
  },
  paymentId: {
    type: String,
    unique: true,
    sparse: true
  },
  referenceId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true
  },
  referenceType: {
    type: String,
    enum: ['membership', 'tournament', 'post', 'scrim', 'other'],
    default: 'other'
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

paymentTransactionSchema.index({ user: 1, createdAt: -1 });
paymentTransactionSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentTransaction', paymentTransactionSchema);
