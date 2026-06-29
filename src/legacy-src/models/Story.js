const mongoose = require('mongoose');

const storySchema = new mongoose.Schema({
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  media: {
    type: {
      type: String,
      enum: ['image', 'video'],
      required: true
    },
    url: { type: String, required: true, trim: true },
    publicId: { type: String, required: true, trim: true }
  },
  clientUploadId: {
    type: String,
    trim: true,
    select: false
  },
  duration: {
    type: Number,
    default: 30,
    min: 1,
    max: 30
  },
  views: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    viewedAt: { type: Date, default: Date.now }
  }],
  music: {
    url: { type: String },
    publicId: { type: String }
  }
}, { timestamps: true });

storySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 }); // TTL: delete after 24 hours
storySchema.index({ author: 1, createdAt: -1 });
storySchema.index(
  { author: 1, clientUploadId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { clientUploadId: { $type: 'string' } } }
);

module.exports = mongoose.model('Story', storySchema);
