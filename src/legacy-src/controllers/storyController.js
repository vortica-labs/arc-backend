const Story = require('../models/Story');
const StoryView = require('../models/StoryView');
const User = require('../models/User');
const { uploadMultipleFiles } = require('../utils/cloudinary');
const { STORY_MAX_SECONDS, processStoryVideo } = require('../utils/videoProcessing');
const log = require('../utils/logger');
const mongoose = require('mongoose');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_CLIENT_UPLOAD_ID_LENGTH = 96;

const toIdStr = (v) => (v == null ? '' : typeof v === 'string' ? v : (v.toString && v.toString()) || String(v));
const STORY_DEBUG_ENABLED = process.env.STORY_DEBUG === 'true' || process.env.NODE_ENV !== 'production';

const storyDebug = (event, payload = {}) => {
  if (!STORY_DEBUG_ENABLED) return;
  log.info(`Story:${event}`, payload);
};

const setStoryNoStoreHeaders = (res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
};

const validStoryMediaMatch = {
  'media.type': { $in: ['image', 'video'] },
  'media.url': { $type: 'string', $ne: '' },
  'media.publicId': { $type: 'string', $ne: '' }
};

const buildActiveStoryQuery = (extra = {}) => ({
  ...extra,
  ...validStoryMediaMatch
});

const normalizeClientUploadId = (value) => {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_CLIENT_UPLOAD_ID_LENGTH) return '';
  return raw;
};

const isDuplicateClientUploadError = (err) => (
  err?.code === 11000 && (
    err?.keyPattern?.clientUploadId ||
    String(err?.message || '').includes('clientUploadId')
  )
);

const populateStoryAuthor = (story) => story.populate('author', 'username profile.displayName profile.avatar profilePicture');

const respondWithStory = async (res, story, statusCode = 201) => {
  await populateStoryAuthor(story);
  const plain = story.toObject();
  return res.status(statusCode).json({
    success: true,
    data: { story: { ...plain, viewCount: 0 } }
  });
};

const findStoryByClientUploadId = async (authorId, clientUploadId) => {
  if (!clientUploadId) return null;
  return Story.findOne({ author: authorId, clientUploadId })
    .select('+clientUploadId')
    .populate('author', 'username profile.displayName profile.avatar profilePicture');
};

const getStoryViewCountMap = async (storyIds) => {
  const objectIds = storyIds
    .map((id) => toIdStr(id))
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (!objectIds.length) return new Map();

  const rows = await StoryView.aggregate([
    { $match: { story: { $in: objectIds } } },
    { $group: { _id: '$story', count: { $sum: 1 } } }
  ]);

  return new Map(rows.map((row) => [toIdStr(row._id), row.count]));
};

const withStoryViewCounts = async (stories) => {
  const plainStories = stories.map((story) => (
    typeof story.toObject === 'function' ? story.toObject() : story
  ));
  const counts = await getStoryViewCountMap(plainStories.map((story) => story._id));
  return plainStories.map((story) => ({
    ...story,
    viewCount: counts.get(toIdStr(story._id)) || 0
  }));
};

const mapViewer = (view) => {
  const user = view.user || {};
  return {
    _id: toIdStr(user._id || view.user),
    username: user.username || '',
    profile: user.profile || {},
    profilePicture: user.profilePicture,
    viewedAt: view.viewedAt
  };
};

// Create story (single image or video, max 30s for video; optional music)
const createStory = async (req, res) => {
  const clientUploadId = normalizeClientUploadId(
    req.get?.('x-idempotency-key') || req.body?.clientUploadId
  );

  try {
    if (clientUploadId) {
      const existingStory = await findStoryByClientUploadId(req.user._id, clientUploadId);
      if (existingStory) {
        const counts = await getStoryViewCountMap([existingStory._id]);
        const storyObject = existingStory.toObject();
        return res.status(200).json({
          success: true,
          data: {
            story: {
              ...storyObject,
              viewCount: counts.get(toIdStr(existingStory._id)) || 0
            },
            duplicate: true
          }
        });
      }
    }

    const mediaFile = req.files?.media?.[0] || req.file;
    if (!mediaFile) {
      return res.status(400).json({ success: false, message: 'Image or video is required' });
    }
    if (!process.env.AWS_S3_BUCKET) {
      return res.status(500).json({
        success: false,
        message: 'Media upload is not configured. Please set AWS_S3_BUCKET in environment.'
      });
    }
    const isVideo = mediaFile.mimetype.startsWith('video/');
    const uploadFile = isVideo ? await processStoryVideo(mediaFile) : mediaFile;
    const results = await uploadMultipleFiles([uploadFile], 'gaming-social/stories');
    const mediaUrl = results?.[0]?.url;
    const mediaPublicId = results?.[0]?.publicId;
    if (!mediaUrl || !mediaPublicId) {
      return res.status(502).json({
        success: false,
        message: 'Story media upload did not complete. Please try again.'
      });
    }
    const media = {
      type: isVideo ? 'video' : 'image',
      url: mediaUrl,
      publicId: mediaPublicId
    };
    const duration = isVideo ? STORY_MAX_SECONDS : 30;
    let musicData;
    const musicFile = req.files?.music?.[0];
    if (musicFile) {
      const { uploadAudio } = require('../utils/cloudinary');
      const musicResult = await uploadAudio(musicFile, 'gaming-social/stories/music');
      musicData = { url: musicResult.url, publicId: musicResult.publicId };
    }
    const story = await Story.create({
      author: req.user._id,
      media,
      duration,
      ...(clientUploadId && { clientUploadId }),
      ...(musicData && { music: musicData })
    });
    return respondWithStory(res, story, 201);
  } catch (err) {
    if (clientUploadId && isDuplicateClientUploadError(err)) {
      const existingStory = await findStoryByClientUploadId(req.user._id, clientUploadId);
      if (existingStory) {
        return respondWithStory(res, existingStory, 200);
      }
    }
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Failed to create story'
    });
  }
};

// Feed: current user + followed users who have at least one story in last 24h
const getStoriesFeed = async (req, res) => {
  try {
    setStoryNoStoreHeaders(res);
    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);
    const myId = req.user._id;
    const myIdStr = myId.toString();
    const followingIds = (req.user.following || []).map((id) => (typeof id === 'string' ? id : id.toString()));
    const allowedIds = [myIdStr];
    followingIds.forEach((id) => {
      if (!id || id === myIdStr) return;
      try {
        if (mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id) {
          allowedIds.push(id);
        }
      } catch (_) { /* skip invalid id */ }
    });
    const allowedObjectIds = allowedIds.map((id) => new mongoose.Types.ObjectId(id));

    const usersWithStories = await Story.aggregate([
      { $match: buildActiveStoryQuery({ author: { $in: allowedObjectIds }, createdAt: { $gte: since } }) },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$author',
          count: { $sum: 1 },
          latestStoryId: { $first: '$_id' },
          latestMedia: { $first: '$media' },
          latestCreatedAt: { $first: '$createdAt' }
        }
      },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userDoc' } },
      { $unwind: '$userDoc' },
      {
        $project: {
          _id: 1,
          count: 1,
          latestStoryId: 1,
          latestMedia: 1,
          latestCreatedAt: 1,
          author: {
            _id: '$userDoc._id',
            username: '$userDoc.username',
            profile: '$userDoc.profile',
            profilePicture: '$userDoc.profilePicture'
          }
        }
      },
      { $sort: { latestCreatedAt: -1 } }
    ]);

    // Ensure current user's story is included and first, with string _id (only remove+replace when we have their story)
    const myLatest = await Story.findOne(buildActiveStoryQuery({ author: myId, createdAt: { $gte: since } }))
      .sort({ createdAt: -1 })
      .limit(1)
      .lean();
    let finalUsers;
    if (myLatest) {
      const me = await User.findById(myId).select('username profile profilePicture').lean();
      const myEntry = {
        _id: myIdStr,
        count: await Story.countDocuments(buildActiveStoryQuery({ author: myId, createdAt: { $gte: since } })),
        latestStoryId: myLatest._id,
        latestMedia: myLatest.media,
        latestCreatedAt: myLatest.createdAt,
        author: me ? { _id: me._id, username: me.username, profile: me.profile, profilePicture: me.profilePicture } : { _id: myId, username: '', profile: {} }
      };
      const others = usersWithStories.filter((u) => (u._id && u._id.toString()) !== myIdStr);
      finalUsers = [myEntry, ...others];
    } else {
      finalUsers = usersWithStories;
    }
    const latestStoryIds = finalUsers.map((u) => u.latestStoryId).filter(Boolean);
    const latestViewCounts = await getStoryViewCountMap(latestStoryIds);

    // Normalize _id to string for every entry so frontend always gets consistent format (safe for JSON)
    finalUsers = finalUsers.map((u) => ({
      _id: toIdStr(u._id),
      count: u.count,
      latestStoryId: u.latestStoryId,
      latestStoryViewCount: latestViewCounts.get(toIdStr(u.latestStoryId)) || 0,
      latestMedia: u.latestMedia,
      latestCreatedAt: u.latestCreatedAt,
      author: u.author ? {
        _id: toIdStr(u.author._id),
        username: u.author.username,
        profile: u.author.profile,
        profilePicture: u.author.profilePicture
      } : { _id: toIdStr(u._id), username: '', profile: {} }
    }));

    storyDebug('feed-response', {
      userId: myIdStr,
      allowedIds,
      users: finalUsers.map((u) => ({
        userId: toIdStr(u._id),
        latestStoryId: toIdStr(u.latestStoryId),
        count: u.count,
        latestCreatedAt: u.latestCreatedAt
      }))
    });

    return res.json({
      success: true,
      data: { users: finalUsers }
    });
  } catch (err) {
    console.error('getStoriesFeed error:', err.message || err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch stories feed'
    });
  }
};

// Get all stories of one user (last 24h)
const getUserStories = async (req, res) => {
  try {
    setStoryNoStoreHeaders(res);
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid user id' });
    }
    const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);
    const isOwnStoryList = toIdStr(userId) === toIdStr(req.user._id);
    const query = Story.find(buildActiveStoryQuery({
      author: userId,
      createdAt: { $gte: since }
    }));
    if (isOwnStoryList) query.select('+clientUploadId');
    const stories = await query
      .sort({ createdAt: 1 })
      .populate('author', 'username profile.displayName profile.avatar profilePicture')
      .lean();
    const storiesWithCounts = await withStoryViewCounts(stories);
    const normalizedStories = storiesWithCounts
      .filter((story) => story?.media?.type && story?.media?.url)
      .map((story) => ({
        ...story,
        _id: toIdStr(story._id),
        author: story.author ? {
          ...story.author,
          _id: toIdStr(story.author._id)
        } : story.author
      }));
    storyDebug('user-stories-response', {
      requestedUserId: userId,
      storyIds: normalizedStories.map((story) => story._id),
      count: normalizedStories.length
    });
    return res.json({
      success: true,
      data: { stories: normalizedStories }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch stories'
    });
  }
};

// Mark story as viewed
const viewStory = async (req, res) => {
  try {
    const { storyId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(storyId)) {
      return res.status(400).json({ success: false, message: 'Invalid story id' });
    }
    const story = await Story.findOne(buildActiveStoryQuery({ _id: storyId })).select('author').lean();
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }
    const userId = toIdStr(req.user._id);
    const authorId = toIdStr(story.author);
    let viewed = false;

    if (authorId !== userId) {
      try {
        const result = await StoryView.updateOne(
          { story: story._id, user: req.user._id },
          {
            $setOnInsert: {
              story: story._id,
              author: story.author,
              user: req.user._id,
              viewedAt: new Date()
            }
          },
          { upsert: true }
        );
        viewed = !!result.upsertedCount;
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
    const viewCount = await StoryView.countDocuments({ story: story._id });
    return res.json({ success: true, data: { viewed, viewCount } });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to record view'
    });
  }
};

// Get viewer list for own story
const getStoryViewers = async (req, res) => {
  try {
    const { storyId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(storyId)) {
      return res.status(400).json({ success: false, message: 'Invalid story id' });
    }

    const story = await Story.findOne(buildActiveStoryQuery({ _id: storyId })).select('author').lean();
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }
    if (toIdStr(story.author) !== toIdStr(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not allowed to view story viewers' });
    }

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const skip = (page - 1) * limit;

    const [total, views] = await Promise.all([
      StoryView.countDocuments({ story: story._id }),
      StoryView.find({ story: story._id })
        .sort({ viewedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'username profile.displayName profile.avatar profilePicture')
        .lean()
    ]);

    return res.json({
      success: true,
      data: {
        viewers: views.map(mapViewer),
        total,
        page,
        limit
      }
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to fetch story viewers'
    });
  }
};

// Delete own story
const deleteStory = async (req, res) => {
  try {
    const story = await Story.findById(req.params.storyId);
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }
    if (story.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not allowed to delete this story' });
    }
    await Promise.all([
      Story.findByIdAndDelete(req.params.storyId),
      StoryView.deleteMany({ story: req.params.storyId })
    ]);
    return res.json({ success: true, message: 'Story deleted' });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Failed to delete story'
    });
  }
};

module.exports = {
  createStory,
  getStoriesFeed,
  getUserStories,
  viewStory,
  getStoryViewers,
  deleteStory
};
