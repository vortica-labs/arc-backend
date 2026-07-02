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
  },
  provider: { type: String, enum: ['razorpay', 'manual', 'migration', 'unknown'], default: 'unknown', index: true },
  membership: { type: mongoose.Schema.Types.ObjectId, ref: 'PremiumMembership', default: null, index: true },
  providerCustomerId: { type: String, trim: true, default: undefined },
  providerSubscriptionId: { type: String, trim: true, default: undefined },
  providerPaymentId: { type: String, trim: true, default: undefined },
  providerOrderId: { type: String, trim: true, default: undefined },
  providerInvoiceId: { type: String, trim: true, default: undefined },
  providerRefundId: { type: String, trim: true, default: undefined },
  platform: { type: String, enum: ['web', 'android', 'ios', 'admin', 'unknown'], default: 'unknown', index: true },
  paymentMethod: { type: String, trim: true, maxlength: 100, default: '' },
  gstAmount: { type: Number, min: 0, default: 0 },
  discountAmount: { type: Number, min: 0, default: 0 },
  couponCode: { type: String, trim: true, maxlength: 100, default: '' },
  invoiceUrl: { type: String, trim: true, maxlength: 2048, default: '' },
  capturedAmount: { type: Number, min: 0, default: 0 },
  refundedAmount: { type: Number, min: 0, default: 0 },
  refundReservedAmount: { type: Number, min: 0, default: 0 },
  refundStateVersion: { type: Number, min: 0, default: 0 },
  refundLockToken: { type: String, default: '' },
  refundLockAt: { type: Date, default: null },
  refundLockAmount: { type: Number, min: 0, default: 0 },
  refundLockReceipt: { type: String, default: '' },
  refundStatus: { type: String, enum: ['none', 'partial', 'full', 'pending', 'failed'], default: 'none', index: true },
  refundHistory: [{
    refundId: { type: String, trim: true, required: true },
    amount: { type: Number, min: 0, required: true },
    status: { type: String, enum: ['pending', 'processed', 'failed'], required: true },
    reservedAmount: { type: Number, min: 0, default: 0 },
    reason: { type: String, maxlength: 1000, default: '' },
    createdAt: { type: Date, default: Date.now }
  }],
  paidAt: { type: Date, default: null, index: true }
}, {
  timestamps: true
});

paymentTransactionSchema.index({ user: 1, createdAt: -1 });
paymentTransactionSchema.index({ type: 1, createdAt: -1 });
paymentTransactionSchema.index({ membership: 1, paidAt: -1, createdAt: -1 });
paymentTransactionSchema.index(
  { providerPaymentId: 1 },
  { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string', $gt: '' } } }
);
paymentTransactionSchema.index(
  { providerSubscriptionId: 1, paidAt: -1 },
  { partialFilterExpression: { providerSubscriptionId: { $type: 'string', $gt: '' } } }
);

module.exports = mongoose.model('PaymentTransaction', paymentTransactionSchema);
