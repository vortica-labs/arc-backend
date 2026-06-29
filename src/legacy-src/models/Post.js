const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Post author is required']
  },
  content: {
    text: {
      type: String,
      default: '',
      validate: {
        validator: function (v) {
          const content = this.content;
          const hasMedia = content && content.media && content.media.length > 0;
          const hasText = v != null && String(v).trim().length > 0;
          return hasMedia || hasText;
        },
        message: 'Post must have some text or at least one image/video'
      },
      maxlength: [2000, 'Post content cannot exceed 2000 characters']
    },
    media: [{
      type: {
        type: String,
        enum: ['image', 'video'],
        required: true
      },
      url: {
        type: String,
        required: true
      },
      publicId: {
        type: String,
        required: true
      },
      coverUrl: {
        type: String,
        default: ''
      },
      coverPublicId: {
        type: String,
        default: ''
      }
    }]
  },
  postType: {
    type: String,
    enum: ['general', 'recruitment', 'achievement', 'looking-for-team'],
    default: 'general'
  },
  // Recruitment specific fields
  recruitmentInfo: {
    gameTitle: String,
    positions: [String],
    requirements: String,
    contactInfo: String,
    deadline: Date,
    isActive: {
      type: Boolean,
      default: true
    }
  },
  // Achievement specific fields
  achievementInfo: {
    gameTitle: String,
    achievementType: String,
    description: String,
    date: Date
  },
  tags: [String],
  mentions: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  likes: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    likedAt: {
      type: Date,
      default: Date.now
    }
  }],
  comments: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    text: {
      type: String,
      required: true,
      maxlength: [500, 'Comment cannot exceed 500 characters']
    },
    likes: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  shares: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    sharedAt: {
      type: Date,
      default: Date.now
    }
  }],
  reports: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    reason: {
      type: String,
      default: 'Inappropriate content'
    },
    reportedAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Instagram-style attached music (for posts/reels)
  attachedMusic: {
    trackId: String,
    title: { type: String, default: '' },
    artist: { type: String, default: '' },
    url: { type: String, default: '' },      // audio playback URL
    coverUrl: { type: String, default: '' }, // cover/album art
    startTime: { type: Number, default: 0 }, // start offset in seconds
    endTime: Number                            // end offset (optional)
  },
  visibility: {
    type: String,
    enum: ['public', 'followers', 'private'],
    default: 'public'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  hiddenByAdmin: {
    type: Boolean,
    default: false
  },
  boostedAt: {
    type: Date
  },
  boostExpiresAt: {
    type: Date
  },
  boostMeta: {
    activeCampaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BoostCampaign'
    },
    status: {
      type: String,
      enum: ['pending', 'scheduled', 'running', 'paused', 'stopped', 'completed', 'cancelled', 'rejected'],
      default: undefined
    },
    budget: { type: Number, default: 0 },
    estimatedReach: { type: Number, default: 0 },
    purchasedReach: { type: Number, default: 0 },
    remainingReach: { type: Number, default: 0 },
    dailySpend: { type: Number, default: 0 },
    totalSpend: { type: Number, default: 0 },
    startTime: Date,
    endTime: Date,
    targetAudience: {
      players: { type: Boolean, default: true },
      teams: { type: Boolean, default: true },
      tags: [{ type: String, trim: true, lowercase: true }],
      regions: [{ type: String, trim: true }]
    }
  },
  metrics: {
    organicViews: { type: Number, default: 0 },
    boostViews: { type: Number, default: 0 },
    organicReach: { type: Number, default: 0 },
    boostReach: { type: Number, default: 0 },
    organicWatchTimeMs: { type: Number, default: 0 },
    boostWatchTimeMs: { type: Number, default: 0 },
    organicLikes: { type: Number, default: 0 },
    boostLikes: { type: Number, default: 0 },
    organicComments: { type: Number, default: 0 },
    boostComments: { type: Number, default: 0 },
    organicShares: { type: Number, default: 0 },
    boostShares: { type: Number, default: 0 },
    organicSaves: { type: Number, default: 0 },
    boostSaves: { type: Number, default: 0 },
    organicCtr: { type: Number, default: 0 },
    boostCtr: { type: Number, default: 0 }
  },
  views: {
    type: Number,
    default: 0
  },
  // Unique views: 1 user = 1 view per post (no manipulation)
  viewedBy: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    viewedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

// Indexes for better performance
postSchema.index({ author: 1, createdAt: -1 });
postSchema.index({ postType: 1, createdAt: -1 });
postSchema.index({ tags: 1 });
postSchema.index({ 'recruitmentInfo.gameTitle': 1, 'recruitmentInfo.isActive': 1 });
// Compound index for profile-page post queries
postSchema.index({ author: 1, isActive: 1, visibility: 1, createdAt: -1 });
postSchema.index({ isActive: 1, hiddenByAdmin: 1, visibility: 1, createdAt: -1, _id: -1 });
postSchema.index({ isActive: 1, hiddenByAdmin: 1, 'content.media.type': 1, createdAt: -1, _id: -1 });
postSchema.index({ 'viewedBy.user': 1, createdAt: -1 });
postSchema.index({ 'likes.user': 1, createdAt: -1 });
postSchema.index({ 'comments.user': 1, createdAt: -1 });
postSchema.index({ 'boostMeta.status': 1, 'boostMeta.endTime': 1, 'boostMeta.remainingReach': 1 });
postSchema.index({ 'metrics.organicViews': -1, createdAt: -1 });

// Virtual for like count
postSchema.virtual('likeCount').get(function() {
  return this.likes ? this.likes.length : 0;
});

// Virtual for comment count
postSchema.virtual('commentCount').get(function() {
  return this.comments ? this.comments.length : 0;
});

// Virtual for share count
postSchema.virtual('shareCount').get(function() {
  return this.shares ? this.shares.length : 0;
});

// Unique view count (viewedBy.length; fallback to views for old posts)
postSchema.virtual('viewCount').get(function() {
  const uniqueViews = this.viewedBy && this.viewedBy.length > 0 ? this.viewedBy.length : 0;
  return Math.max(this.views || 0, uniqueViews);
});

// Ensure virtual fields are included in JSON
postSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Post', postSchema);
