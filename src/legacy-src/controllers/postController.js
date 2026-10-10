const Post = require('../models/Post');
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const User = require('../models/User');
const { usernameOwnerIds } = require('../services/usernameLookupService');
const Notification = require('../models/Notification');
const BoostCampaign = require('../models/BoostCampaign');
const BoostDeliveryAttribution = require('../models/BoostDeliveryAttribution');
const UserAudio = require('../models/UserAudio');
const { uploadMultipleFiles } = require('../utils/cloudinary');
const { createLikeNotification, createCommentNotification, createReplyNotification, createMentionNotification, createCommentMentionNotification } = require('../utils/notificationService');
const { resolveCommentMentions, mentionNotificationRecipients } = require('../utils/commentMentions');
const { resolveCommentRelation } = require('../utils/commentThreading');
const { buildCommentDeletion, getCommentPermissions, idString } = require('../utils/commentModeration');
const { formatPostDTO } = require('../utils/dto');
const { resolveClientMediaPayload } = require('../utils/privateMediaDelivery');
const { extractHashtags, mergeTags, MAX_HASHTAGS_PER_POST, HASHTAG_LIMIT_MESSAGE } = require('../utils/hashtags');
const { isMusicAllowedForMedia } = require('../utils/postAudioRules');
const {
  getRecommendedPosts,
  recordEngagementEvent,
  normalizeEngagementContext,
  normalizeEngagementDuration,
  normalizeCompletionRate
} = require('../services/recommendationService');
const { getDiscoverSearchPosts } = require('../services/discoverPostSearchService');
const { normalizeQuerySearch } = require('../utils/searchQuery');
const { isActiveBoost } = require('../services/boostService');
const log = require('../utils/logger');
const { deleteNotificationsForTarget } = require('../services/notificationHistoryService');
const { respondToMediaUploadError } = require('../utils/mediaUploadError');
const { toPostMediaItem } = require('../utils/postMediaDimensions');
const { processPostVideo } = require('../utils/videoProcessing');
const { enqueueClipTranscode } = require('../utils/jobQueue');
const { resolvePostAccess, filterPostsForViewer } = require('../utils/privacyPolicy');
const {
  normalizeAchievementInfoInput,
  validateAchievementPostBody,
  toAchievementInfoForPersistence
} = require('../utils/achievementPostPolicy');

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

async function getRequestAttribution(req, post) {
  const campaignId = post?.boostMeta?.activeCampaign || null;
  const userId = req.user?._id;
  if (!userId || !campaignId || !isActiveBoost(post)) return { source: 'organic', campaignId: null };
  // Context is client-supplied engagement metadata and cannot decide whether
  // paid delivery becomes monetizable. Any unexpired server-authored delivery
  // proof for this viewer/post/campaign keeps the engagement boost-attributed.
  const proof = await BoostDeliveryAttribution.exists({
    user: userId,
    post: post._id,
    campaign: campaignId,
    expiresAt: { $gt: new Date() }
  });
  return proof ? { source: 'boost', campaignId } : { source: 'organic', campaignId: null };
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
    const { text, postType, tags, visibility, recruitmentInfo, mentions } = req.body;
    const authorId = req.user._id;
    const rawTags = tags !== undefined ? tags : req.body['tags[]'];
    const parsedTags = Array.isArray(rawTags)
      ? rawTags.map(tag => String(tag).trim()).filter(Boolean)
      : typeof rawTags === 'string'
        ? rawTags.split(',').map(tag => tag.trim()).filter(Boolean)
        : [];
    const indexedTags = mergeTags(parsedTags, typeof text === 'string' ? text : '');
    // Reject before processing/uploading media or sending notifications. The
    // indexed, case-insensitive set is the same one used for discovery.
    if (indexedTags.length > MAX_HASHTAGS_PER_POST) {
      return res.status(400).json({ success: false, message: HASHTAG_LIMIT_MESSAGE });
    }

    const parsedAchievementInfo = normalizeAchievementInfoInput(req.body);
    if (postType === 'achievement') {
      const achievementValidationError = validateAchievementPostBody(req.body);
      if (achievementValidationError) {
        return res.status(400).json({ success: false, message: achievementValidationError });
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
    const uploadId = randomUUID();

    // Handle media uploads
    let mediaData = [];
    let mediaUploadAudit = [];
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
        
        const startupOptimizedMedia = mediaFiles.length > 0
          ? await Promise.all(mediaFiles.map((file, mediaIndex) => (
              String(file?.mimetype || '').toLowerCase().startsWith('video/')
                ? processPostVideo({
                    ...file,
                    integrityContext: {
                      uploadId,
                      userId: String(authorId),
                      mediaIndex
                    }
                  })
                : file
            )))
          : [];
        const uploadResults = startupOptimizedMedia.length > 0
          ? await uploadMultipleFiles(startupOptimizedMedia, 'gaming-social/posts')
          : [];
        mediaUploadAudit = uploadResults
          .filter(result => result.type === 'video')
          .map(result => ({
            publicId: result.publicId,
            bytes: result.bytes,
            checksumSha256: result.checksumSha256,
            etag: result.etag
          }));
        mediaData = uploadResults.map(toPostMediaItem);
        if (coverFile) {
          const [coverUpload] = await uploadMultipleFiles([coverFile], 'gaming-social/post-covers');
          coverData = coverUpload ? {
            url: coverUpload.url,
            publicId: coverUpload.publicId
          } : null;
        }
      } catch (uploadError) {
        return respondToMediaUploadError(res, uploadError, 'Failed to upload media files');
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
          mentionedUserIds = (await usernameOwnerIds(usernames)).map(String);
        }
      }
    } else {
      // Extract mentions from text using @username pattern
      const mentionRegex = /@(\w+)/g;
      const matches = (text && typeof text === 'string') ? text.match(mentionRegex) : null;
      if (matches) {
        const usernames = matches.map(m => m.substring(1));
        mentionedUserIds = (await usernameOwnerIds(usernames)).map(String);
      }
    }

    // Parse attached music (Instagram-style) if provided.
    // Two sources: 'library' (licensed catalog from search) and 'user_upload'
    // (the caller's own upload). For a user_upload we NEVER trust the client's
    // url/metadata — we resolve the owned UserAudio row and use its server-side
    // values, and we only publish it if copyright was affirmed.
    let attachedMusic = null;
    if (req.body.attachedMusic) {
      try {
        const raw = typeof req.body.attachedMusic === 'string' ? req.body.attachedMusic : JSON.stringify(req.body.attachedMusic);
        const parsed = JSON.parse(raw);
        const sourceType = parsed.sourceType === 'user_upload' ? 'user_upload' : 'library';

        if (sourceType === 'user_upload') {
          // Resolve the owned, non-removed upload; ignore the client's url/title.
          const audioDoc = parsed.audioId
            ? await UserAudio.findOne({ _id: parsed.audioId, owner: req.user._id, removed: { $ne: true } })
            : null;
          // Copyright must be affirmed (on the record already, or in this request).
          const confirmedAt = audioDoc && audioDoc.copyrightConfirmedAt
            ? audioDoc.copyrightConfirmedAt
            : (parsed.copyrightConfirmed ? new Date() : null);
          if (audioDoc && confirmedAt) {
            attachedMusic = {
              audioId: audioDoc._id,
              sourceType: 'user_upload',
              trackId: undefined,
              title: audioDoc.title || parsed.title || '',
              artist: audioDoc.artistName || '',
              url: audioDoc.url,                 // trusted server URL, never the client's
              coverUrl: '',
              startTime: typeof parsed.startTime === 'number' ? parsed.startTime : 0,
              endTime: typeof parsed.endTime === 'number' ? parsed.endTime : undefined,
              copyrightConfirmedAt: confirmedAt
            };
            // Persist confirmation on the record if it wasn't already stored.
            if (!audioDoc.copyrightConfirmedAt) {
              audioDoc.copyrightConfirmedAt = confirmedAt;
              audioDoc.save().catch(() => {});
            }
          }
          // else: unresolved/unconfirmed user upload — drop the attachment
          // rather than publish an unverified reference or fail the whole post.
        } else if (parsed && (parsed.url || parsed.title)) {
          attachedMusic = {
            sourceType: 'library',
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

    // Create post data (allow post with only media, no caption)
    const postData = {
      author: authorId,
      content: {
        text: typeof text === 'string' ? text : '',
        media: mediaData
      },
      postType: postType || 'general',
      // Index hashtags from the caption (source of truth) unioned with any
      // explicit tags, all normalized + deduped for case-insensitive search.
      tags: indexedTags,
      mentions: mentionedUserIds,
      visibility: visibility || 'public'
    };
    // Server-side enforcement: a post with no image has nothing for a music
    // track to play over, so the attachment is dropped rather than stored.
    // Clients hide the option, but an API caller must not be able to create a
    // video-only post carrying music. Mixed carousels are unaffected — their
    // images still need it.
    if (attachedMusic && !isMusicAllowedForMedia(mediaData)) {
      attachedMusic = null;
    }
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
    if (postType === 'achievement') {
      postData.achievementInfo = toAchievementInfoForPersistence(parsedAchievementInfo, { defaultDate: true });
      if (process.env.NODE_ENV === 'development') { console.log('Creating achievement post with info:', postData.achievementInfo);}
    }

    const post = await Post.create(postData);

    if (mediaData.some(media => media.type === 'video')) {
      log.info('Post media published after integrity verification', {
        uploadId,
        postId: String(post._id),
        userId: String(authorId),
        videos: mediaUploadAudit
      });
    }

    // The verified progressive source is already durable and playable at this
    // point. HLS rendition work is handed to BullMQ and never blocks the
    // upload request.
    const clipJobs = post.content.media
      .filter(media => media.type === 'video' && media.playback?.status === 'processing')
      .map(media => ({
        postId: String(post._id),
        mediaId: String(media._id),
        version: String(media.playback.version)
      }));
    const queueResults = await Promise.allSettled(clipJobs.map(job => (
      enqueueClipTranscode(job.postId, job.mediaId, job.version)
    )));
    queueResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error('Clip HLS enqueue failed; recovery scan will retry', {
          postId: clipJobs[index].postId,
          mediaId: clipJobs[index].mediaId,
          error: String(result.reason)
        });
      }
    });
    
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

    const isGuest = !req.user || req.user.userType === 'guest';
    const isAuthor = true; // The creator is the author

    res.status(201).json({
      success: true,
      message: 'Post created successfully',
      data: {
        post: await resolveClientMediaPayload(formatPostDTO(post, isGuest, isAuthor))
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
    const search = normalizeQuerySearch(req.query.search);
    const result = await (search && req.query.context === 'search' ? getDiscoverSearchPosts : getRecommendedPosts)({
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
    const search = normalizeQuerySearch(req.query.search);
    const result = await (search && req.query.context === 'search' ? getDiscoverSearchPosts : getRecommendedPosts)({
      user: req.user,
      query: req.query,
      mode: 'feed'
    });

    // Personalized, session-rotated ranking: never let ETag/304 or any shared
    // cache replay a stale first page.
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
    const context = normalizeEngagementContext(req.body?.context || req.query?.context || 'clips');
    const durationMs = normalizeEngagementDuration(req.body?.durationMs);
    const completionRate = normalizeCompletionRate(req.body?.completionRate);

    const now = new Date();
    const basePost = await Post.findById(postId).select('author visibility isActive hiddenByAdmin boostMeta boostExpiresAt');
    if (!basePost || basePost.isActive === false) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (!await requireVisiblePost(req, res, basePost)) return;
    const { source, campaignId } = await getRequestAttribution(req, basePost);
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
    const isGuest = !req.user || req.user.userType === 'guest';
    if (viewerId && !isGuest) {
      const { source, campaignId } = await getRequestAttribution(req, post);
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
    const postDto = await resolveClientMediaPayload(formatPostDTO(post, isGuest, isAuthor, viewerId));
    if (postDto) {
      postDto.isSaved = Boolean(
        viewerId
        && !isGuest
        && await User.exists({ _id: viewerId, 'savedPosts.post': post._id })
      );
    }

    res.status(200).json({
      success: true,
      data: {
        post: postDto
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

// Public direct-link probe. This intentionally returns no post, author,
// visibility, or moderation data; it only lets logged-out clients distinguish
// a real shared URL from a deleted/malformed one before presenting Login.
const getPostAvailability = async (req, res) => {
  try {
    const exists = await Post.exists({
      _id: req.params.id,
      isActive: { $ne: false },
      hiddenByAdmin: { $ne: true }
    });

    if (!exists) {
      return res.status(404).json({
        success: false,
        code: 'POST_NOT_FOUND',
        message: 'Post not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: { exists: true }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to verify post availability',
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
    const { source, campaignId } = await getRequestAttribution(req, existingPost);
    let likeRelationshipCreated = false;

    if (alreadyLiked) {
      await Post.updateOne(
        { _id: postId, isActive: true },
        { $pull: { likes: { user: userId } } }
      );
    } else {
      const likeResult = await Post.updateOne(
        {
          _id: postId,
          isActive: true,
          likes: { $not: { $elemMatch: { user: userId } } }
        },
        { $push: { likes: { user: userId, likedAt: new Date() } } }
      );
      likeRelationshipCreated = Number(likeResult?.modifiedCount || 0) === 1;
      if (likeRelationshipCreated) {
        await incrementAttributionMetric({ postId, source, campaignId, metric: 'Likes' });
      }
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
    if (isLiked && likeRelationshipCreated && authorId && authorId.toString() !== userId.toString()) {
      await createLikeNotification(authorId, userId, finalPost._id);
    }

    res.status(200).json({
      success: true,
      message: isLiked ? 'Post liked' : 'Post unliked',
      data: {
        likeCount: uniqueLikeCount,
        isLiked,
        post: await resolveClientMediaPayload(formatPostDTO(finalPost, req.user && req.user.userType === 'guest', authorId?.toString?.() === userId.toString()))
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

// Paginated TOP-LEVEL comments for the Instagram-style comment drawer. Returns
// at most `limit` (default 10) top-level comments after `cursor`, each with its
// precomputed replyCount — never the full reply tree, and never the entire
// comments array in one shot. Ordering is stable (chronological, _id tiebreak)
// so pages never duplicate or skip within a session.
const getPostComments = async (req, res) => {
  try {
    const postId = req.params.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : null;

    const post = await Post.findOne({ _id: postId, isActive: true })
      .select('author visibility isActive hiddenByAdmin boostMeta boostExpiresAt comments')
      .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar');
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (!await requireVisiblePost(req, res, post)) return;

    const all = Array.isArray(post.comments) ? post.comments : [];
    // Top-level only (a reply has parentComment set); newest first (latest →
    // oldest), stable _id tiebreak so pages never duplicate or skip.
    const topLevel = all
      .filter((c) => !c.parentComment)
      .sort((a, b) => {
        const delta = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        return delta !== 0 ? delta : String(b._id).localeCompare(String(a._id));
      });

    let start = 0;
    if (cursor) {
      const idx = topLevel.findIndex((c) => String(c._id) === cursor);
      // Unknown cursor (e.g. the anchor comment was deleted) restarts from the
      // top rather than silently returning nothing.
      start = idx >= 0 ? idx + 1 : 0;
    }
    const pageItems = topLevel.slice(start, start + limit);
    const hasMore = start + limit < topLevel.length;
    const nextCursor = hasMore && pageItems.length ? String(pageItems[pageItems.length - 1]._id) : null;

    const viewerId = req.user?._id ? String(req.user._id) : null;
    const contentOwnerId = idString(post.author);
    const comments = pageItems.map((c) => {
      const likes = Array.isArray(c.likes) ? c.likes : [];
      const permissions = getCommentPermissions({
        viewerId,
        contentOwnerId,
        commentAuthorId: c.user,
      });
      return {
        _id: c._id,
        user: c.user,
        text: c.text,
        mentions: c.mentions || [],
        createdAt: c.createdAt,
        parentComment: null,
        rootComment: null,
        replyCount: Math.max(0, Number(c.replyCount) || 0),
        likeCount: likes.length,
        isLiked: Boolean(viewerId && likes.some((u) => String(u?._id || u) === viewerId)),
        permissions,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        comments,
        nextCursor,
        hasMore,
        // Total drives the drawer header; loaded length must NOT be used for it.
        totalTopLevel: topLevel.length,
        totalComments: all.length,
        contentOwnerId,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load comments',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

// Delete a comment using one server-authoritative permission model. The
// comment author may delete their own comment; the post/Clip owner may delete
// any comment on their content. Descendants are removed with their parent so
// no dangling parentComment references survive.
const deleteComment = async (req, res) => {
  try {
    const { id: postId, commentId } = req.params;
    const viewerId = req.user?._id;
    if (!mongoose.Types.ObjectId.isValid(postId) || !mongoose.Types.ObjectId.isValid(commentId)) {
      return res.status(400).json({ success: false, message: 'Invalid post or comment ID' });
    }

    const post = await Post.findOne({ _id: postId, isActive: true })
      .select('author visibility isActive hiddenByAdmin comments __v');
    if (!post) return res.status(404).json({ success: false, message: 'Post not found' });
    if (!await requireVisiblePost(req, res, post)) return;

    const plan = buildCommentDeletion(post.comments, commentId);
    if (!plan) return res.status(404).json({ success: false, message: 'Comment not found' });
    const permissions = getCommentPermissions({
      viewerId,
      contentOwnerId: post.author,
      commentAuthorId: plan.target.user,
    });
    if (!permissions.canDelete) {
      return res.status(403).json({
        success: false,
        code: 'COMMENT_DELETE_FORBIDDEN',
        message: 'You do not have permission to delete this comment'
      });
    }

    const updated = await Post.findOneAndUpdate(
      {
        _id: post._id,
        __v: post.__v,
        'comments._id': commentId,
        $or: [
          { author: viewerId },
          { comments: { $elemMatch: { _id: commentId, user: viewerId } } }
        ]
      },
      { $set: { comments: plan.comments }, $inc: { __v: 1 } },
      { new: true }
    ).select('comments');

    if (!updated) {
      return res.status(409).json({
        success: false,
        code: 'COMMENT_CHANGED',
        message: 'The comment thread changed. Please refresh and try again.'
      });
    }

    await Promise.all(plan.deletedCommentIds.map((deletedId) => (
      deleteNotificationsForTarget({ targetType: 'comment', targetId: deletedId }).catch(() => null)
    )));

    return res.json({
      success: true,
      message: 'Comment deleted successfully',
      data: {
        deletedCommentIds: plan.deletedCommentIds,
        commentCount: updated.comments.length,
      }
    });
  } catch (error) {
    log.error('Delete comment error:', { error: String(error) });
    return res.status(500).json({
      success: false,
      message: 'Failed to delete comment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Paginated list of the users who liked a post OR clip (clips are video posts,
// so this single endpoint serves both). Cursor pages over the embedded likes[]
// newest-first, honours post visibility, and never leaks deleted/deactivated
// likers. Powers the shared Likes Drawer on Web + Mobile.
const getPostLikes = async (req, res) => {
  try {
    const postId = req.params.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : null;

    const post = await Post.findOne({ _id: postId, isActive: true })
      .select('author visibility isActive hiddenByAdmin boostMeta boostExpiresAt likes')
      .populate('likes.user', 'username userType profile.displayName profile.avatar profilePicture avatar isActive');
    if (!post) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (!await requireVisiblePost(req, res, post)) return;

    // Drop likes whose user was deleted/deactivated so we never leak or crash.
    const visible = (Array.isArray(post.likes) ? post.likes : [])
      .filter((like) => like && like.user && like.user.isActive !== false);
    // Newest first (latest → oldest), stable _id tiebreak so pages never dup/skip.
    const sorted = visible.sort((a, b) => {
      const delta = new Date(b.likedAt || 0).getTime() - new Date(a.likedAt || 0).getTime();
      return delta !== 0 ? delta : String(b._id).localeCompare(String(a._id));
    });

    let start = 0;
    if (cursor) {
      const idx = sorted.findIndex((like) => String(like._id) === cursor);
      // Unknown cursor (e.g. an unliked-since row) restarts from the top.
      start = idx >= 0 ? idx + 1 : 0;
    }
    const pageItems = sorted.slice(start, start + limit);
    const hasMore = start + limit < sorted.length;
    const nextCursor = hasMore && pageItems.length ? String(pageItems[pageItems.length - 1]._id) : null;

    const items = pageItems.map((like) => {
      const u = like.user;
      return {
        id: String(u._id),
        username: u.username,
        displayName: u.profile?.displayName || u.username,
        avatar: u.profile?.avatar || u.profilePicture || u.avatar || null,
        accountType: u.userType === 'team' ? 'team' : 'user',
      };
    });

    return res.status(200).json({
      success: true,
      data: { items, nextCursor, hasMore, total: sorted.length },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load likes',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
};

// Add comment to post
const addComment = async (req, res) => {
  try {
    const postId = req.params.id;
    const { text, parentCommentId } = req.body;
    const userId = req.user._id;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Comment text is required'
      });
    }

    // Load existing comments so a reply can resolve its parent/root thread.
    const visiblePost = await Post.findById(postId)
      .select('author visibility isActive hiddenByAdmin comments._id comments.user comments.parentComment comments.rootComment');
    if (!visiblePost) return res.status(404).json({ success: false, message: 'Post not found' });
    if (!await requireVisiblePost(req, res, visiblePost)) return;

    const relation = resolveCommentRelation(visiblePost.comments, parentCommentId);
    if (!relation.ok) {
      return res.status(404).json({ success: false, message: 'The comment you are replying to no longer exists.' });
    }
    const isReply = Boolean(relation.rootComment);

    let resolvedMentions;
    try {
      resolvedMentions = await resolveCommentMentions(text.trim(), User);
    } catch (error) {
      if (error.code === 'COMMENT_MENTION_LIMIT') {
        return res.status(400).json({ success: false, code: error.code, message: error.message });
      }
      throw error;
    }
    if (resolvedMentions.length) {
      // The same content owner is checked for every recipient; populate once
      // rather than reloading that user for each visibility decision.
      await visiblePost.populate('author', 'username userType profile privacySettings blockedUsers isActive');
      const commentAuthor = await User.findById(userId).select('blockedUsers').lean();
      const mentionVisibility = await Promise.all(resolvedMentions.map(async (recipient) => {
        if ((commentAuthor?.blockedUsers || []).some((id) => String(id) === String(recipient._id))
          || (recipient.blockedUsers || []).some((id) => String(id) === String(userId))) return false;
        return (await resolvePostAccess({ post: visiblePost, viewer: recipient })).allowed;
      }));
      resolvedMentions = resolvedMentions.filter((_, index) => mentionVisibility[index]);
    }

    const comment = {
      user: userId,
      text: text.trim(),
      mentions: resolvedMentions.map(({ _id, username }) => ({ user: _id, username })),
      likes: [],
      parentComment: relation.parentComment,
      rootComment: relation.rootComment,
      replyCount: 0,
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

    // Keep the root thread's replyCount accurate for the "View replies (N)" UI.
    if (isReply) {
      await Post.updateOne(
        { _id: postId, 'comments._id': relation.rootComment },
        { $inc: { 'comments.$.replyCount': 1 } }
      );
    }

    const { source, campaignId } = await getRequestAttribution(req, post);
    await incrementAttributionMetric({ postId, source, campaignId, metric: 'Comments' });

    const newComment = post.comments[post.comments.length - 1];

    // Notifications: a top-level comment notifies the post author; a reply
    // notifies the answered commenter and deep-links to the exact thread.
    // Never notify yourself.
    let standardRecipientId = null;
    if (isReply) {
      if (relation.replyTargetUserId && relation.replyTargetUserId !== userId.toString()) {
        await createReplyNotification(relation.replyTargetUserId, userId, post._id, {
          rootCommentId: relation.rootComment,
          replyId: newComment?._id,
          text: text.trim(),
        }).catch(() => {});
        standardRecipientId = relation.replyTargetUserId;
      }
    } else if (post.author.toString() !== userId.toString()) {
      await createCommentNotification(post.author, userId, post._id, text.trim(), newComment?._id);
      standardRecipientId = post.author;
    }

    // A recipient already notified as post owner or reply target receives only
    // that notification. Every other resolved recipient gets one mention event.
    await Promise.all(mentionNotificationRecipients(resolvedMentions, userId, standardRecipientId).map((recipient) => (
      createCommentMentionNotification(recipient, userId, visiblePost, {
        commentId: newComment?._id,
        rootCommentId: relation.rootComment || newComment?._id,
        isReply,
        text: text.trim(),
      }).catch((error) => log.error('Comment mention notification failed', { error: String(error), postId: String(postId) }))
    )));

    await recordEngagementEvent({
      userId,
      postId,
      authorId: post.author,
      eventType: 'comment',
      context: req.body?.context || 'feed',
      source,
      boostCampaign: campaignId,
      metadata: { length: text.trim().length, reply: isReply }
    });

    res.status(201).json({
      success: true,
      message: isReply ? 'Reply added successfully' : 'Comment added successfully',
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
    const { source, campaignId } = await getRequestAttribution(req, finalPost);
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

    // Decide save-vs-unsave by EXISTENCE, never by updateOne.modifiedCount.
    // The User schema has `timestamps: true`, so every updateOne also $sets
    // `updatedAt` and reports modifiedCount >= 1 even when the $pull removed
    // nothing. The previous modifiedCount check therefore always concluded it
    // had just unsaved, so the guarded $push never ran and saves NEVER
    // persisted (bookmark reverted, Saved list stayed empty).
    const alreadySaved = await User.exists({ _id: userId, 'savedPosts.post': postId });
    if (!alreadySaved && !(await User.exists({ _id: userId }))) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    let isSaved;
    if (alreadySaved) {
      await User.updateOne(
        { _id: userId },
        { $pull: { savedPosts: { post: postId } } }
      );
      isSaved = false;
    } else {
      // Guarded by 'savedPosts.post is absent' so concurrent rapid taps can
      // never insert duplicate save records.
      await User.updateOne(
        { _id: userId, 'savedPosts.post': { $ne: postId } },
        { $push: { savedPosts: { post: postId, savedAt: new Date() } } }
      );
      isSaved = true;
    }
    const savedOwner = await User.findById(userId).select('savedPosts.post').lean();
    const savedCount = (savedOwner?.savedPosts || []).length;
    const { source, campaignId } = await getRequestAttribution(req, post);
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
        savedCount
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
    const posts = await Post.find({ _id: { $in: savedIds }, isActive: true, 'reports.user': { $ne: userId } })
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
    const deliveredPosts = await resolveClientMediaPayload(pageItems.map(({ post, savedAt }) => ({
      ...formatPostDTO(post, false, post.author?._id?.toString() === userId.toString()),
      isSaved: true,
      savedAt
    })));

    res.status(200).json({
      success: true,
      data: {
        posts: deliveredPosts,
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
      Post.find({ isActive: true, 'likes.user': userId, 'reports.user': { $ne: userId } })
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

    const deliveredPosts = await resolveClientMediaPayload(posts.map(post => ({
      ...formatPostDTO(post, false, post.author?._id?.toString() === userId.toString()),
      isLiked: true,
      isSaved: savedIds.has(post._id.toString())
    })));
    res.status(200).json({
      success: true,
      data: {
        posts: deliveredPosts,
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
        message: 'You can only update your own posts'
      });
    }

    // Track whether a user-visible editable field actually changed, so the
    // "Edited" flag reflects real content edits — not a no-op save.
    let contentChanged = false;

    const oldText = post.content.text;
    if (text !== undefined && text !== post.content.text) {
      post.content.text = text;
      contentChanged = true;
    }
    // Re-derive the hashtag index whenever the caption or the explicit tags
    // change. Field tags (added manually, not present in the old caption) are
    // preserved; hashtags removed from the caption drop out automatically.
    // Validate every caption supplied by an edit request, including a no-op
    // resend of a legacy caption that already exceeds the current limit.
    if (tags !== undefined || text !== undefined) {
      const oldCaptionTags = new Set(extractHashtags(oldText));
      const preservedFieldTags = (Array.isArray(post.tags) ? post.tags : [])
        .filter((tag) => !oldCaptionTags.has(String(tag).toLowerCase()));
      const explicit = tags !== undefined ? tags : preservedFieldTags;
      const effectiveText = text !== undefined ? text : oldText;
      const nextTags = mergeTags(explicit, typeof effectiveText === 'string' ? effectiveText : '');
      if (nextTags.length > MAX_HASHTAGS_PER_POST) {
        return res.status(400).json({ success: false, message: HASHTAG_LIMIT_MESSAGE });
      }
      const currentTags = Array.isArray(post.tags) ? post.tags : [];
      if (nextTags.length !== currentTags.length || nextTags.some((tag, i) => tag !== currentTags[i])) {
        post.tags = nextTags;
        contentChanged = true;
      }
    }
    if (visibility !== undefined && visibility !== post.visibility) {
      post.visibility = visibility;
      contentChanged = true;
    }

    // Update recruitment info if provided
    if (post.postType === 'recruitment' && recruitmentInfo) {
      post.recruitmentInfo = {
        ...post.recruitmentInfo,
        ...recruitmentInfo,
        positions: recruitmentInfo.positions
          ? (Array.isArray(recruitmentInfo.positions) ? recruitmentInfo.positions : String(recruitmentInfo.positions).split(','))
            .map(pos => String(pos).trim())
            .filter(Boolean)
          : post.recruitmentInfo.positions
      };
      contentChanged = true;
    }

    // Only a genuine content edit marks the post as edited. Engagement and
    // analytics writes never reach this endpoint.
    if (contentChanged) {
      post.isEdited = true;
      post.editedAt = new Date();
    }

    await post.save();
    await post.populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType');

    res.status(200).json({
      success: true,
      message: 'Post updated successfully',
      data: {
        post: await resolveClientMediaPayload(formatPostDTO(post, false, true))
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

    await deleteNotificationsForTarget({ targetType: 'post', targetId: postId }).catch((cleanupError) => {
      log.error('Post notification cleanup failed', { error: String(cleanupError), postId: String(postId) });
    });

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
    // Views must use POST /posts/:id/view so viewedBy, counters, attribution,
    // and the unique engagement record are updated together.
    const validTypes = ['watch', 'like', 'comment', 'share', 'save', 'click', 'dwell_time', 'skip'];
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
    const { source, campaignId } = await getRequestAttribution(req, post);
    const trackedDuration = normalizeEngagementDuration(durationMs ?? dwellTime);
    const normalizedContext = normalizeEngagementContext(context);
    if (['watch', 'dwell'].includes(normalizedType) && trackedDuration > 0) {
      await incrementAttributionMetric({ postId, source, campaignId, metric: 'WatchTimeMs', amount: trackedDuration });
    }
    await recordEngagementEvent({
      userId,
      postId,
      authorId: post.author,
      eventType: normalizedType,
      context: normalizedContext,
      durationMs: trackedDuration,
      completionRate: normalizeCompletionRate(completionRate),
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
  getPostAvailability,
  getPostComments,
  getPostLikes,
  recordClipView,
  getPersonalizedFeed,
  toggleLike,
  addComment,
  deleteComment,
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
