const mongoose = require('mongoose');

const storyViewSchema = new mongoose.Schema({
  story: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Story',
    required: true
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  viewedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

storyViewSchema.index({ story: 1, user: 1 }, { unique: true });
storyViewSchema.index({ story: 1, viewedAt: -1 });
storyViewSchema.index({ author: 1, viewedAt: -1 });
storyViewSchema.index({ viewedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

module.exports = mongoose.model('StoryView', storyViewSchema);
