const mongoose = require('mongoose');

const broadcastTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  description: { type: String, default: '', trim: true, maxlength: 300 },
  content: {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    subtitle: { type: String, default: '', trim: true, maxlength: 160 },
    bannerImage: { type: String, default: '', trim: true, maxlength: 2048 },
    thumbnail: { type: String, default: '', trim: true, maxlength: 2048 },
    cta: {
      text: { type: String, default: '', trim: true, maxlength: 60 },
      url: { type: String, default: '', trim: true, maxlength: 2048 },
      deepLink: { type: String, default: '', trim: true, maxlength: 2048 },
      type: { type: String, default: 'none', trim: true, maxlength: 40 }
    },
    priority: { type: String, enum: ['normal', 'high', 'critical'], default: 'normal' },
    category: { type: String, default: 'announcement', trim: true, maxlength: 40 },
    customCategory: { type: String, default: '', trim: true, maxlength: 60 },
    deliveryType: { type: String, enum: ['push', 'in_app', 'both'], default: 'both' },
    push: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  isActive: { type: Boolean, default: true, index: true },
  usageCount: { type: Number, default: 0, min: 0 },
  createdBy: {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: 'admin' }
  },
  updatedBy: {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: { type: String, default: 'admin' }
  }
}, { timestamps: true, optimisticConcurrency: true });

broadcastTemplateSchema.index({ name: 1 }, { unique: true });
broadcastTemplateSchema.index({ isActive: 1, updatedAt: -1 });
broadcastTemplateSchema.index({ isActive: 1, 'content.category': 1, updatedAt: -1 });

module.exports = mongoose.models.BroadcastTemplate || mongoose.model('BroadcastTemplate', broadcastTemplateSchema);
