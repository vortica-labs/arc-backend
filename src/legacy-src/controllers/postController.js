const Post = require('../models/Post');
const User = require('../models/User');
const Notification = require('../models/Notification');
const BoostCampaign = require('../models/BoostCampaign');
const { uploadMultipleFiles } = require('../utils/cloudinary');
const { createLikeNotification, createCommentNotification, createMentionNotification } = require('../utils/notificationService');
const { formatPostDTO } = require('../utils/dto');
const { getRecommendedPosts, recordEngagementEvent } = require('../services/recommendationService');
const { isActiveBoost } = require('../services/boostService');
const log = require('../utils/logger');
const { resolvePostAccess, filterPostsForViewer } = require('../utils/privacyPolicy');

const rejectPrivatePost = (res, decision) => res.status(decision?.reason === 'not_found' ? 404 : 403).json({
  success: false,
  code: decision?.reason === 'not_found' ? 'POST_NOT_FOUND' : 'PRIVACY_RESTRICTED',
  reason: decision?.reason || 'privacy_restricted',
  message: decision?.reason === 'not_found' ? 'Post not found' : 'You do not have permission to access this post',
  ...(decision?.privacyAccess ? { data: { privacyAccess: decision.privacyAccess } } : {})
});

const requireVisiblePost = async (req, res, post) => {
  const decision = await resolvePostAccess({ post, viewer: req.user });
  if (!decision.allowed) {
    rejectPrivatePost(res, decision);
    return null;
  }
  return decision;
};

function getRequestSource(req, post) {
  const requested = req.body?.source || req.query?.source || req.body?.deliverySource || req.query?.deliverySource;
  return requested === 'boost' && isActiveBoost(post) ? 'boost' : 'organic';
}

function getBoostCampaignId(post, source) {
  return source === 'boost' ? (post?.boostMeta?.activeCampaign || null) : null;
}

async function incrementAttributionMetric({ postId, source, campaignId, metric, amount = 1 }) {
  const safeSource = source === 'boost' ? 'boost' : 'organic';
  const safeAmount = Number(amount) || 0;
  if (!postId || !metric || safeAmount === 0) return;

  await Post.updateOne(
    { _id: postId },
    { $inc: { [`metrics.${safeSource}${metric}`]: safeAmount } }
  );

  if (safeSource === 'boost' && campaignId) {
    await BoostCampaign.updateOne(
      { _id: campaignId },
      { $inc: { [`analytics.${safeSource}${metric}`]: safeAmount } }
    );
  }
}

// Create new post
const createPost = async (req, res) => {
  try {
    const { text, postType, tags, visibility, recruitmentInfo, achievementInfo, mentions } = req.body;
    const authorId = req.user._id;

    // Parse nested FormData fields for achievementInfo if sent as flat fields
    let parsedAchievementInfo = achievementInfo;
    if (postType === 'achievement' && !achievementInfo) {
      // Check if achievementInfo fields are sent as flat fields (achievementInfo[gameTitle], etc.)
      parsedAchievementInfo = {};
      if (req.body['achievementInfo[gameTitle]']) {
        parsedAchievementInfo.gameTitle = req.body['achievementInfo[gameTitle]'];
      }
      if (req.body['achievementInfo[achievementType]']) {
        parsedAchievementInfo.achievementType = req.body['achievementInfo[achievementType]'];
      }
      if (req.body['achievementInfo[description]']) {
        parsedAchievementInfo.description = req.body['achievementInfo[description]'];
      }
      if (req.body['achievementInfo[date]']) {
        parsedAchievementInfo.date = req.body['achievementInfo[date]'];
      }
    }

    // Parse nested FormData fields for recruitmentInfo if sent as flat fields
    let parsedRecruitmentInfo = recruitmentInfo;
    if (postType === 'recruitment' && !recruitmentInfo) {
      parsedRecruitmentInfo = {};
      if (req.body['recruitmentInfo[gameTitle]']) {
        parsedRecruitmentInfo.gameTitle = req.body['recruitmentInfo[gameTitle]'];
      }
      if (req.body['recruitmentInfo[positions]']) {
        parsedRecruitmentInfo.positions = req.body['recruitmentInfo[positions]'];
      }
      if (req.body['recruitmentInfo[requirements]']) {
        parsedRecruitmentInfo.requirements = req.body['recruitmentInfo[requirements]'];
      }
      if (req.body['recruitmentInfo[contactInfo]']) {
        parsedRecruitmentInfo.contactInfo = req.body['recruitmentInfo[contactInfo]'];
      }
      if (req.body['recruitmentInfo[deadline]']) {
        parsedRecruitmentInfo.deadline = req.body['recruitmentInfo[deadline]'];
      }
    }

    const mediaFiles = Array.isArray(req.files) ? req.files : (req.files?.media || []);
    const coverFile = Array.isArray(req.files) ? null : req.files?.cover?.[0];

    // Handle media uploads
    let mediaData = [];
    let coverData = null;
    if (mediaFiles.length > 0 || coverFile) {
      try {
        if (!process.env.AWS_S3_BUCKET) {
          return res.status(500).json({
            success: false,
            message: 'Media upload is not configured. Please set AWS_S3_BUCKET in environment.',
            error: 'S3 configuration missing'
          });
        }
        
        const uploadResults = mediaFiles.length > 0
          ? await uploadMultipleFiles(mediaFiles, 'gaming-social/posts')
          : [];
        mediaData = uploadResults.map(result => ({
          type: result.type,
          url: result.url,
          publicId: result.publicId
        }));
        if (coverFile) {
          const [coverUpload] = await uploadMultipleFiles([coverFile], 'gaming-social/post-covers');
          coverData = coverUpload ? {
            url: coverUpload.url,
            publicId: coverUpload.publicId
          } : null;
        }
      } catch (uploadError) {
        return res.status(400).json({
          success: false,
          message: 'Failed to upload media files',
          error: uploadError.message
        });
      }
    }

    if (coverData) {
      const videoMedia = mediaData.find(item => item.type === 'video');
      if (videoMedia) {
        videoMedia.coverUrl = coverData.url;
        videoMedia.coverPublicId = coverData.publicId;
      }
    }

    // Parse mentions if provided
    let mentionedUserIds = [];
    if (mentions) {
      try {
        mentionedUserIds = typeof mentions === 'string' ? JSON.parse(mentions) : mentions;
      } catch (e) {
        // If parsing fails, extract mentions from text using @username pattern
        const mentionRegex = /@(\w+)/g;
        const matches = (text && typeof text === 'string') ? text.match(mentionRegex) : null;
        if (matches) {
          const usernames = matches.map(m => m.substring(1));
          const users = await User.find({ username: { $in: usernames } }).select('_id');
          mentionedUserIds = users.map(u => u._id.toString());
        }
      }
    } else {
      // Extract mentions from text using @username pattern
      const mentionRegex = /@(\w+)/g;
      const matches = (text && typeof text === 'string') ? text.match(mentionRegex) : null;
      if (matches) {
        const usernames = matches.map(m => m.substring(1));
        const users = await User.find({ username: { $in: usernames } }).select('_id');
        mentionedUserIds = users.map(u => u._id.toString());
      }
    }

    // Parse attached music (Instagram-style) if provided
    let attachedMusic = null;
    if (req.body.attachedMusic) {
      try {
        const raw = typeof req.body.attachedMusic === 'string' ? req.body.attachedMusic : JSON.stringify(req.body.attachedMusic);
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.url || parsed.title)) {
          attachedMusic = {
            trackId: parsed.trackId || undefined,
            title: parsed.title || '',
            artist: parsed.artist || '',
            url: parsed.url || '',
            coverUrl: parsed.coverUrl || '',
            startTime: typeof parsed.startTime === 'number' ? parsed.startTime : 0,
            endTime: typeof parsed.endTime === 'number' ? parsed.endTime : undefined
          };
        }
      } catch (e) {
        // ignore invalid attachedMusic
      }
    }

    const rawTags = tags !== undefined ? tags : req.body['tags[]'];
    const parsedTags = Array.isArray(rawTags)
      ? rawTags.map(tag => String(tag).trim()).filter(Boolean)
      : typeof rawTags === 'string'
        ? rawTags.split(',').map(tag => tag.trim()).filter(Boolean)
        : [];

    // Create post data (allow post with only media, no caption)
    const postData = {
      author: authorId,
      content: {
        text: typeof text === 'string' ? text : '',
        media: mediaData
      },
      postType: postType || 'general',
      tags: parsedTags,
      mentions: mentionedUserIds,
      visibility: visibility || 'public'
    };
    if (attachedMusic) postData.attachedMusic = attachedMusic;

    // Add recruitment info if it's a recruitment post
    if (postType === 'recruitment' && parsedRecruitmentInfo && Object.keys(parsedRecruitmentInfo).length > 0) {
      postData.recruitmentInfo = {
        gameTitle: parsedRecruitmentInfo.gameTitle,
        positions: parsedRecruitmentInfo.positions ? (typeof parsedRecruitmentInfo.positions === 'string' ? parsedRecruitmentInfo.positions.split(',').map(pos => pos.trim()) : parsedRecruitmentInfo.positions) : [],
        requirements: parsedRecruitmentInfo.requirements,
        contactInfo: parsedRecruitmentInfo.contactInfo,
        deadline: parsedRecruitmentInfo.deadline ? new Date(parsedRecruitmentInfo.deadline) : null,
        isActive: true
      };
    }

    // Add achievement info if it's an achievement post
    if (postType === 'achievement' && parsedAchievementInfo && Object.keys(parsedAchievementInfo).length > 0) {
      postData.achievementInfo = {
        gameTitle: parsedAchievementInfo.gameTitle,
        achievementType: parsedAchievementInfo.achievementType,
        description: parsedAchievementInfo.description,
        date: parsedAchievementInfo.date ? new Date(parsedAchievementInfo.date) : new Date()
      };
      if (process.env.NODE_ENV === 'development') { console.log('Creating achievement post with info:', postData.achievementInfo);}
    }

    const post = await Post.create(postData);
    
    // Populate author info
    await post.populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType');
    
    // Log the created post to verify postType and achievementInfo
    log.debug('Created post:', {
      _id: post._id,
      postType: post.postType,
      achievementInfo: post.achievementInfo,
      author: post.author?.username
    });

    // Add post to user's posts array
    await User.findByIdAndUpdate(authorId, {
      $push: { posts: post._id }
    });

    // Create mention notifications
    if (mentionedUserIds.length > 0) {
      for (const mentionedUserId of mentionedUserIds) {
        // Don't notify if user mentioned themselves
        if (mentionedUserId.toString() !== authorId.toString()) {
          try {
            await createMentionNotification(mentionedUserId, authorId, post._id);
          } catch (error) {
            console.error(`Error creating mention notification for user ${mentionedUserId}:`, error);
          }
        }
      }
    }

    const isGuest = req.user && req.user.userType === 'guest';
    const isAuthor = true; // The creator is the author

    res.status(201).json({
      success: true,
      message: 'Post created successfully',
      data: {
        post: formatPostDTO(post, isGuest, isAuthor)
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create post',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get clips feed (posts that have at least one video - Reels/Shorts style)
const getClips = async (req, res) => {
  try {
    const result = await getRecommendedPosts({
      user: req.user,
      query: req.query,
      mode: 'clips'
    });

    // Prevent caching/ETag 304 issues for clients
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch clips',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all posts (feed)
const getPosts = async (req, res) => {
  try {
    const result = await getRecommendedPosts({
      user: req.user,
      query: req.query,
      mode: 'feed'
    });

    res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch posts',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Boost post must go through verified payment. Kept only to prevent old clients
// from activating unpaid boosts.
const boostPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select('author');
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only boost your own posts' });
    }
    res.status(402).json({
      success: false,
      message: 'Boosts require verified payment. Use /api/payments/boost/create-order first.'
    });
  } catch (error) {
    log.error('Boost post error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to boost post' });
  }
};

// Record unique view for a clip (1 user = 1 view per post, no manipulation)
const recordClipView = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user._id;
    const context = req.body?.context || req.query?.context || 'clips';
    const durationMs = Math.max(0, parseInt(req.body?.durationMs, 10) || 0);
    const completionRate = Math.min(1, Math.max(0, Number(req.body?.completionRate) || 0));

    const now = new Date();
    const basePost = await Post.findById(postId).select('author visibility isActive hiddenByAdmin boostMeta boostExpiresAt');
    if (!basePost || basePost.isActive === false) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (!await requireVisiblePost(req, res, basePost)) return;
    const source = getRequestSource(req, basePost);
    const campaignId = getBoostCampaignId(basePost, source);
    const metricsInc = {
      views: 1,
      [`metrics.${source}Views`]: 1
    };
    if (durationMs > 0) {
      metricsInc[`metrics.${source}WatchTimeMs`] = durationMs;
    }

    const updatedPost = await Post.findOneAndUpdate(
      {
        _id: postId,
        isActive: true,
        viewedBy: { $not: { $elemMatch: { user: userId } } }
      },
      {
        $push: { viewedBy: { user: userId, viewedAt: now } },
        $inc: metricsInc
      },
      { new: true }
    ).select('author views viewedBy');

    if (updatedPost && source === 'boost' && campaignId) {
      await BoostCampaign.updateOne(
        { _id: campaignId },
        {
          $inc: {
            'analytics.boostViews': 1,
            'analytics.boostWatchTimeMs': durationMs
          }
        }
      );
    }

    const post = updatedPost || await Post.findById(postId).select('author views viewedBy isActive');
    if (!post || post.isActive === false) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }

    await recordEngagementEvent({
      userId,
      postId,
      authorId: post.author,
      eventType: 'view',
      context,
      durationMs,
      completionRate,
      source,
      boostCampaign: campaignId
    });

    res.status(200).json({
      success: true,
      message: updatedPost ? 'View recorded' : 'View already recorded',
      data: {
        viewCount: Math.max(post.views || 0, Array.isArray(post.viewedBy) ? post.viewedBy.length : 0),
        unique: Boolean(updatedPost)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to record view',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single post by ID
const getPost = async (req, res) => {
  try {
    const postId = req.params.id;

    const post = await Post.findById(postId)
      .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType privacySettings blockedUsers isActive')
      .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
      .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar');

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    const postPrivacyDecision = await requireVisiblePost(req, res, post);
    if (!postPrivacyDecision) return;

    const viewerId = req.user?._id;
    const isGuest = req.user && req.user.userType === 'guest';
    if (viewerId && !isGuest) {
      const source = getRequestSource(req, post);
      const campaignId = getBoostCampaignId(post, source);
      const viewUpdate = await Post.updateOne(
        {
          _id: postId,
          viewedBy: { $not: { $elemMatch: { user: viewerId } } }
        },
        {
          $push: { viewedBy: { user: viewerId, viewedAt: new Date() } },
          $inc: {
            views: 1,
            [`metrics.${source}Views`]: 1
          }
        }
      );
      if (viewUpdate.modifiedCount > 0 && source === 'boost' && campaignId) {
        await BoostCampaign.updateOne(
          { _id: campaignId },
          { $inc: { 'analytics.boostViews': 1 } }
        );
      }
      await recordEngagementEvent({
        userId: viewerId,
        postId,
        authorId: post.author?._id || post.author,
        eventType: 'view',
        context: 'post',
        source,
        boostCampaign: campaignId
      });
    }

    const isAuthor = Boolean(req.user && req.user._id && !isGuest && post.author && post.author._id && post.author._id.toString() === req.user._id.toString());

    res.status(200).json({
      success: true,
      data: {
        post: formatPostDTO(post, isGuest, isAuthor)
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch post',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Like/Unlike post
const toggleLike = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user._id;

    const existingPost = await Post.findById(postId).select('author likes visibility isActive hiddenByAdmin boostMeta boostExpiresAt');
    if (!existingPost || existingPost.isActive === false) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }
    if (!await requireVisiblePost(req, res, existingPost)) return;

    const alreadyLiked = existingPost.likes.findIndex((like) => {
      const likeUser = like?.user?._id || like?.user;
      if (!likeUser) return false;
      return likeUser.toString() === userId.toString();
    }) > -1;
    const source = getRequestSource(req, existingPost);
    const campaignId = getBoostCampaignId(existingPost, source);

    if (alreadyLiked) {
      await Post.updateOne(
        { _id: postId, isActive: true },
        { $pull: { likes: { user: userId } } }
      );
    } else {
      await Post.updateOne(
        {
          _id: postId,
          isActive: true,
          likes: { $not: { $elemMatch: { user: userId } } }
        },
        { $push: { likes: { user: userId, likedAt: new Date() } } }
      );
      await incrementAttributionMetric({ postId, source, campaignId, metric: 'Likes' });
    }

    const finalPost = await Post.findById(postId)
      .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType privacySettings blockedUsers isActive')
      .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
      .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar')
      .select('author content postType achievementInfo tags mentions likes comments shares attachedMusic visibility isActive hiddenByAdmin boostedAt boostExpiresAt views viewedBy createdAt updatedAt');
    if (!finalPost || finalPost.isActive === false) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    const authorId = finalPost.author?._id || finalPost.author;
    const finalLikes = Array.isArray(finalPost?.likes) ? finalPost.likes : [];
    const isLiked = finalLikes.some((like) => {
      const likeUser = like?.user?._id || like?.user;
      return likeUser && likeUser.toString() === userId.toString();
    });
    const uniqueLikeCount = new Set(finalLikes.map((like) => {
      const likeUser = like?.user?._id || like?.user;
      return likeUser ? likeUser.toString() : '';
    }).filter(Boolean)).size || finalLikes.length;

    await recordEngagementEvent({
      userId,
      postId,
      authorId,
      eventType: isLiked ? 'like' : 'unlike',
      context: req.body?.context || 'feed',
      source,
      boostCampaign: campaignId
    });

    // Create notification for post author (if not liking own post)
    if (isLiked && authorId && authorId.toString() !== userId.toString()) {
      await createLikeNotification(authorId, userId, finalPost._id);
    }

    res.status(200).json({
      success: true,
      message: isLiked ? 'Post liked' : 'Post unliked',
      data: {
        likeCount: uniqueLikeCount,
        isLiked,
        post: formatPostDTO(finalPost, req.user && req.user.userType === 'guest', authorId?.toString?.() === userId.toString())
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to toggle like',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Add comment to post
const addComment = async (req, res) => {
  try {
    const postId = req.params.id;
    const { text } = req.body;
    const userId = req.user._id;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Comment text is required'
      });
    }

    const visiblePost = await Post.findById(postId)
      .select('author visibility isActive hiddenByAdmin');
    if (!visiblePost) return res.status(404).json({ success: false, message: 'Post not found' });
    if (!await requireVisiblePost(req, res, visiblePost)) return;

    // Add comment
    const comment = {
      user: userId,
      text: text.trim(),
      likes: [],
      createdAt: new Date()
    };

    const post = await Post.findOneAndUpdate(
      { _id: postId, isActive: true },
      { $push: { comments: comment } },
      { new: true }
    )
      .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar')
      .select('author comments boostMeta boostExpiresAt');

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    const source = getRequestSource(req, post);
    const campaignId = getBoostCampaignId(post, source);
    await incrementAttributionMetric({ postId, source, campaignId, metric: 'Comments' });

    // Create notification for post author (if not commenting on own post)
    if (post.author.toString() !== userId.toString()) {
      await createCommentNotification(post.author, userId, post._id, text.trim());
    }

    await recordEngagementEvent({
      userId,
      postId,
      authorId: post.author,
      eventType: 'comment',
      context: req.body?.context || 'feed',
      source,
      boostCampaign: campaignId,
      metadata: { length: text.trim().length }
    });

    const newComment = post.comments[post.comments.length - 1];

    res.status(201).json({
      success: true,
      message: 'Comment added successfully',
      data: {
        post,
        comment: newComment,
        commentCount: post.comments.length
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to add comment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Record a unique share action for ranking and creator analytics
const recordShare = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user._id;

    const visiblePost = await Post.findById(postId)
      .select('author visibility isActive hiddenByAdmin');
    if (!visiblePost) return res.status(404).json({ success: false, message: 'Post not found' });
    if (!await requireVisiblePost(req, res, visiblePost)) return;

    const post = await Post.findOneAndUpdate(
      {
        _id: postId,
        isActive: true,
        'shares.user': { $ne: userId }
      },
      {
        $push: { shares: { user: userId, sharedAt: new Date() } }
      },
      { new: true }
    ).select('author shares');

    const finalPost = post || await Post.findById(postId).select('author shares isActive boostMeta boostExpiresAt');
    if (!finalPost || finalPost.isActive === false) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    const source = getRequestSource(req, finalPost);
    const campaignId = getBoostCampaignId(finalPost, source);
    if (post) {
      await incrementAttributionMetric({ postId, source, campaignId, metric: 'Shares' });
    }

    await recordEngagementEvent({
      userId,
      postId,
      authorId: finalPost.author,
      eventType: 'share',
      context: req.body?.context || 'feed',
      source,
      boostCampaign: campaignId,
      metadata: { channel: req.body?.channel || 'unknown' }
    });

    res.status(200).json({
      success: true,
      message: post ? 'Share recorded' : 'Share already recorded',
      data: {
        shareCount: finalPost.shares?.length || 0,
        unique: Boolean(post)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to record share',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle saved post state. Stored on User so it can feed personalization.
const toggleSave = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user._id;

    const post = await Post.findOne({ _id: postId, isActive: true })
      .select('author visibility isActive hiddenByAdmin boostMeta boostExpiresAt');
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (!await requireVisiblePost(req, res, post)) return;

    const user = await User.findById(userId).select('savedPosts');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const savedIndex = (user.savedPosts || []).findIndex((item) => {
      const savedPostId = item?.post?._id || item?.post;
      return savedPostId && savedPostId.toString() === postId.toString();
    });

    let isSaved;
    if (savedIndex > -1) {
      user.savedPosts.splice(savedIndex, 1);
      isSaved = false;
    } else {
      user.savedPosts.push({ post: postId, savedAt: new Date() });
      isSaved = true;
    }
    await user.save();
    const source = getRequestSource(req, post);
    const campaignId = getBoostCampaignId(post, source);
    if (isSaved) {
      await incrementAttributionMetric({ postId, source, campaignId, metric: 'Saves' });
    }

    await recordEngagementEvent({
      userId,
      postId,
      authorId: post.author,
      eventType: isSaved ? 'save' : 'unsave',
      context: req.body?.context || 'feed',
      source,
      boostCampaign: campaignId
    });

    res.status(200).json({
      success: true,
      message: isSaved ? 'Post saved' : 'Post unsaved',
      data: {
        isSaved,
        savedCount: user.savedPosts.length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to toggle saved post',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const getSavedPosts = async (req, res) => {
  try {
    const userId = req.user._id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const user = await User.findById(userId).select('savedPosts').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const savedEntries = (user.savedPosts || [])
      .filter(item => item?.post)
      .sort((a, b) => new Date(b.savedAt || 0).getTime() - new Date(a.savedAt || 0).getTime());

    const savedIds = savedEntries.map(item => item.post);
    const posts = await Post.find({ _id: { $in: savedIds }, isActive: true })
      .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType privacySettings blockedUsers isActive')
      .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
      .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar');

    const visiblePosts = await filterPostsForViewer(posts, req.user);
    const postsById = new Map(visiblePosts.map(post => [post._id.toString(), post]));
    const orderedPosts = savedEntries
      .map(entry => {
        const post = postsById.get(entry.post.toString());
        return post ? { post, savedAt: entry.savedAt } : null;
      })
      .filter(Boolean);

    const total = orderedPosts.length;
    const pageItems = orderedPosts.slice(skip, skip + limit);

    res.status(200).json({
      success: true,
      data: {
        posts: pageItems.map(({ post, savedAt }) => ({
          ...formatPostDTO(post, false, post.author?._id?.toString() === userId.toString()),
          isSaved: true,
          savedAt
        })),
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: pageItems.length,
          totalPosts: total
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch saved posts',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const getLikedPosts = async (req, res) => {
  try {
    const userId = req.user._id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = (page - 1) * limit;

    const [candidatePosts, user] = await Promise.all([
      Post.find({ isActive: true, 'likes.user': userId })
        .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType privacySettings blockedUsers isActive')
        .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
        .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar')
        .sort({ 'likes.likedAt': -1, createdAt: -1 }),
      User.findById(userId).select('savedPosts').lean()
    ]);

    const visiblePosts = await filterPostsForViewer(candidatePosts, req.user);
    const total = visiblePosts.length;
    const posts = visiblePosts.slice(skip, skip + limit);

    const savedIds = new Set((user?.savedPosts || []).map(item => item?.post?.toString()).filter(Boolean));

    res.status(200).json({
      success: true,
      data: {
        posts: posts.map(post => ({
          ...formatPostDTO(post, false, post.author?._id?.toString() === userId.toString()),
          isLiked: true,
          isSaved: savedIds.has(post._id.toString())
        })),
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: posts.length,
          totalPosts: total
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch liked posts',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update post
const updatePost = async (req, res) => {
  try {
    const postId = req.params.id;
    const { text, tags, visibility, recruitmentInfo } = req.body;
    const userId = req.user._id;

    const post = await Post.findById(postId).select('author boostMeta boostExpiresAt isActive');

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    // Check if user owns the post
    if (post.author.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only update your own posts'
      });
    }

    // Update fields
    if (text !== undefined) post.content.text = text;
    if (tags !== undefined) post.tags = tags.split(',').map(tag => tag.trim());
    if (visibility !== undefined) post.visibility = visibility;

    // Update recruitment info if provided
    if (post.postType === 'recruitment' && recruitmentInfo) {
      post.recruitmentInfo = {
        ...post.recruitmentInfo,
        ...recruitmentInfo,
        positions: recruitmentInfo.positions ? recruitmentInfo.positions.split(',').map(pos => pos.trim()) : post.recruitmentInfo.positions
      };
    }

    await post.save();
    await post.populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType');

    res.status(200).json({
      success: true,
      message: 'Post updated successfully',
      data: {
        post
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update post',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete post
const deletePost = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user._id;

    const post = await Post.findById(postId);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    // Check if user owns the post
    if (post.author.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own posts'
      });
    }

    // Mark as inactive instead of actually deleting
    post.isActive = false;
    await post.save();

    // Remove from user's posts array
    await User.findByIdAndUpdate(userId, {
      $pull: { posts: postId }
    });

    res.status(200).json({
      success: true,
      message: 'Post deleted successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete post',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Report post
const reportPost = async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user._id;

    const post = await Post.findById(postId);

    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }
    if (!await requireVisiblePost(req, res, post)) return;

    // Check if user is trying to report their own post
    if (post.author.toString() === userId.toString()) {
      return res.status(400).json({
        success: false,
        message: 'You cannot report your own post'
      });
    }

    // Check if user has already reported this post
    const existingReport = post.reports?.find(report => report.user.toString() === userId.toString());
    if (existingReport) {
      return res.status(400).json({
        success: false,
        message: 'You have already reported this post'
      });
    }

    // Add report to post
    if (!post.reports) post.reports = [];
    post.reports.push({
      user: userId,
      reason: req.body.reason || 'Inappropriate content',
      reportedAt: new Date()
    });

    await post.save();

    res.status(200).json({
      success: true,
      message: 'Post reported successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to report post',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get personalized feed using recommendation engine
const getPersonalizedFeed = async (req, res) => {
  try {
    const result = await getRecommendedPosts({
      user: req.user,
      query: req.query,
      mode: 'feed'
    });

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch personalized feed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Track user interaction with post
const trackInteraction = async (req, res) => {
  try {
    const { postId, interactionType, dwellTime, clickedElement, context, durationMs, completionRate } = req.body;
    const userId = req.user._id;

    // Validate interaction type
    const validTypes = ['view', 'watch', 'like', 'comment', 'share', 'save', 'click', 'dwell_time', 'skip'];
    if (!validTypes.includes(interactionType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid interaction type'
      });
    }

    // Check if post exists
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }
    if (!await requireVisiblePost(req, res, post)) return;

    const normalizedType = interactionType === 'dwell_time' || interactionType === 'click'
      ? 'dwell'
      : interactionType;
    const source = getRequestSource(req, post);
    const campaignId = getBoostCampaignId(post, source);
    const trackedDuration = Math.max(0, parseInt(durationMs ?? dwellTime, 10) || 0);
    if (['watch', 'dwell'].includes(normalizedType) && trackedDuration > 0) {
      await incrementAttributionMetric({ postId, source, campaignId, metric: 'WatchTimeMs', amount: trackedDuration });
    }
    await recordEngagementEvent({
      userId,
      postId,
      authorId: post.author,
      eventType: normalizedType,
      context: context || 'unknown',
      durationMs: trackedDuration,
      completionRate: Math.min(1, Math.max(0, Number(completionRate) || 0)),
      source,
      boostCampaign: campaignId,
      metadata: { clickedElement }
    });

    res.status(200).json({
      success: true,
      data: {
        message: 'Interaction tracked successfully'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to track interaction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update post analytics
const updatePostAnalytics = async (postId) => {
  try {
    const post = await Post.findById(postId);
    if (!post) return;

    // Simple analytics without UserInteraction model
    const totalViews = post.views || 0;
    const likes = post.likes ? post.likes.length : 0;
    const comments = post.comments ? post.comments.length : 0;
    const engagementScore = (likes * 3) + (comments * 5);

    // Update post analytics
    post.analytics = {
      totalViews,
      engagementScore,
      lastCalculated: new Date()
    };

    // Update content quality
    post.contentQuality = {
      hasMedia: post.content.media && post.content.media.length > 0,
      textLength: post.content.text ? post.content.text.length : 0,
      tagCount: post.tags ? post.tags.length : 0,
      qualityScore: calculateContentQualityScore(post)
    };

    await post.save();
  } catch (error) {
    log.error('Error updating post analytics:', { error: String(error) });
  }
};

// Calculate content quality score
const calculateContentQualityScore = (post) => {
  let score = 0;
  
  // Text length score (optimal range: 50-500 characters)
  const textLength = post.content.text ? post.content.text.length : 0;
  if (textLength >= 50 && textLength <= 500) score += 3;
  else if (textLength > 0) score += 1;
  
  // Media presence bonus
  if (post.content.media && post.content.media.length > 0) score += 2;
  
  // Tag presence bonus
  if (post.tags && post.tags.length > 0) score += 1;
  
  // Post type specific bonuses
  if (post.postType === 'achievement') score += 2;
  if (post.postType === 'recruitment') score += 1;
  
  return Math.min(score, 10); // Cap at 10
};

// Get user analytics
const getUserAnalytics = async (req, res) => {
  try {
    const userId = req.user._id;
    const days = parseInt(req.query.days) || 30;

    // Simple analytics without recommendation engine
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Get user's posts
    const posts = await Post.find({ author: userId, isActive: true });
    
    // Calculate basic analytics
    const totalPosts = posts.length;
    const totalLikes = posts.reduce((sum, post) => sum + (post.likes ? post.likes.length : 0), 0);
    const totalComments = posts.reduce((sum, post) => sum + (post.comments ? post.comments.length : 0), 0);
    const totalViews = posts.reduce((sum, post) => sum + (post.views || 0), 0);

    const analytics = {
      totalPosts,
      totalLikes,
      totalComments,
      totalViews,
      engagementRate: totalPosts > 0 ? (totalLikes + totalComments) / totalPosts : 0
    };

    res.status(200).json({
      success: true,
      data: analytics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user analytics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  createPost,
  getPosts,
  getClips,
  getPost,
  recordClipView,
  getPersonalizedFeed,
  toggleLike,
  addComment,
  recordShare,
  toggleSave,
  getSavedPosts,
  getLikedPosts,
  updatePost,
  deletePost,
  reportPost,
  boostPost,
  trackInteraction,
  getUserAnalytics
};
