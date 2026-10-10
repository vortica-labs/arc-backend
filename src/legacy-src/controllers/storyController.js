const Story = require('../models/Story');
const StoryMediaAsset = require('../models/StoryMediaAsset');
const StoryView = require('../models/StoryView');
const User = require('../models/User');
const UserAudio = require('../models/UserAudio');
const { uploadMultipleFiles, uploadAudio } = require('../utils/cloudinary');
const { STORY_MAX_SECONDS, processStoryVideo, probeMediaDuration } = require('../utils/videoProcessing');
const { resolveStoryMusicTrim, validateStoryMusicDuration, validateStoryMusicFile } = require('../utils/storyMusicPolicy');
const {
  cleanupStoryAssets,
  deferStoryAssetCleanup,
  deletePublicIds,
} = require('../services/storyMediaCleanupService');
const log = require('../utils/logger');
const { deleteNotificationsForTarget } = require('../services/notificationHistoryService');
const mongoose = require('mongoose');
const Follow = require('../models/Follow');
const { resolvePrivacyAccess, minimalProfile } = require('../utils/privacyPolicy');
const { resolveClientMediaPayload } = require('../utils/privateMediaDelivery');
const { parseStoryOverlays } = require('../utils/storyOverlays');

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_CLIENT_UPLOAD_ID_LENGTH = 96;

const toIdStr = (v) => (v == null ? '' : typeof v === 'string' ? v : (v.toString && v.toString()) || String(v));
const STORY_DEBUG_ENABLED = process.env.STORY_DEBUG === 'true' || process.env.NODE_ENV !== 'production';

const storyDebug = (event, payload = {}) => {
  if (!STORY_DEBUG_ENABLED) return;
  log.info(`Story:${event}`, payload);
};

const rejectStoryPrivacy = (res, target, privacyAccess) => res.status(403).json({
  success: false,
  code: 'PRIVACY_RESTRICTED',
  reason: privacyAccess?.reason || 'privacy_restricted',
  message: 'Stories are not available for this account',
  data: { user: minimalProfile(target), privacyAccess }
});

const getStoryAuthorAccess = async (viewer, authorValue) => {
  const authorId = toIdStr(authorValue?._id || authorValue);
  const author = authorValue?.privacySettings
    ? authorValue
    : await User.findById(authorId).select('username userType profile privacySettings blockedUsers isActive').lean();
  if (!author || author.isActive === false) return null;
  return { author, relationship: await resolvePrivacyAccess({ viewer, targetUser: author }) };
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

const cleanMusicText = (value, max = 200) => (
  typeof value === 'string'
    ? value
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
      .slice(0, max)
    : ''
);

const isTruthyFlag = (value) => value === true || value === 'true' || value === '1' || value === 1;

const storyMusicError = (statusCode, code, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const parseAttachedMusicPayload = (value) => {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    throw storyMusicError(400, 'STORY_MUSIC_INVALID_PAYLOAD', 'Story music metadata is invalid.');
  }
};

const getTrimBodyFromAttachedMusic = (payload = {}) => ({
  musicStartTime: payload.musicStartTime ?? payload.musicStart ?? payload.musicOffset ?? payload.startTime,
  musicEndTime: payload.musicEndTime ?? payload.endTime,
  musicPlaybackDuration: payload.musicPlaybackDuration ?? payload.playbackDuration,
});

const resolveAttachedStoryMusic = async ({ payload, userId, storyDuration }) => {
  if (!payload || typeof payload !== 'object') return null;
  const sourceType = payload.sourceType === 'user_upload' ? 'user_upload' : 'library';

  if (sourceType === 'user_upload') {
    if (!payload.audioId || !mongoose.Types.ObjectId.isValid(payload.audioId)) {
      throw storyMusicError(400, 'STORY_MUSIC_UPLOAD_NOT_FOUND', 'Uploaded music could not be found.');
    }

    const audioDoc = await UserAudio.findOne({
      _id: payload.audioId,
      owner: userId,
      removed: { $ne: true },
    });
    if (!audioDoc) {
      throw storyMusicError(404, 'STORY_MUSIC_UPLOAD_NOT_FOUND', 'Uploaded music could not be found.');
    }
    if (audioDoc.status && audioDoc.status !== 'ready') {
      throw storyMusicError(422, 'STORY_MUSIC_NOT_READY', 'Uploaded music is not ready yet.');
    }

    const confirmedAt = audioDoc.copyrightConfirmedAt
      || (isTruthyFlag(payload.copyrightConfirmed) ? new Date() : null);
    if (!confirmedAt) {
      throw storyMusicError(403, 'STORY_MUSIC_RIGHTS_REQUIRED', 'Confirm you have rights to use this audio before attaching it.');
    }

    const durationValidation = validateStoryMusicDuration(audioDoc.duration);
    if (!durationValidation.ok) {
      throw storyMusicError(durationValidation.statusCode, durationValidation.code, durationValidation.message);
    }

    const trim = resolveStoryMusicTrim(
      getTrimBodyFromAttachedMusic(payload),
      durationValidation.duration,
      storyDuration,
    );

    if (!audioDoc.copyrightConfirmedAt) {
      audioDoc.copyrightConfirmedAt = confirmedAt;
      audioDoc.save().catch(() => {});
    }

    return {
      sourceType: 'user_upload',
      audioId: audioDoc._id,
      trackId: undefined,
      title: cleanMusicText(audioDoc.title || payload.title || 'Custom track'),
      artist: cleanMusicText(audioDoc.artistName || payload.artist || 'Custom track'),
      url: audioDoc.url,
      coverUrl: '',
      filename: cleanMusicText(audioDoc.title || payload.title || 'custom-track'),
      mimeType: audioDoc.mimeType || undefined,
      size: audioDoc.fileSize || undefined,
      duration: durationValidation.duration,
      startTime: trim.startTime,
      endTime: trim.endTime,
      playbackDuration: trim.playbackDuration,
      copyrightConfirmedAt: confirmedAt,
    };
  }

  const url = cleanMusicText(payload.url, 2048);
  if (!url || !/^https?:\/\//i.test(url)) {
    throw storyMusicError(400, 'STORY_MUSIC_INVALID_URL', 'Selected music is unavailable. Choose another track.');
  }

  const declaredDuration = Number(payload.duration);
  const inferredDuration = Number.isFinite(declaredDuration) && declaredDuration > 0
    ? declaredDuration
    : Math.max(Number(payload.endTime) || 0, storyDuration);
  if (!Number.isFinite(inferredDuration) || inferredDuration <= 0) {
    throw storyMusicError(400, 'STORY_MUSIC_DURATION_INVALID', 'Selected music is unavailable. Choose another track.');
  }

  const trim = resolveStoryMusicTrim(
    getTrimBodyFromAttachedMusic(payload),
    inferredDuration,
    storyDuration,
  );

  return {
    sourceType: 'library',
    trackId: cleanMusicText(payload.trackId, 120) || undefined,
    title: cleanMusicText(payload.title || 'Selected track'),
    artist: cleanMusicText(payload.artist || 'Music'),
    url,
    coverUrl: cleanMusicText(payload.coverUrl, 2048),
    duration: inferredDuration,
    startTime: trim.startTime,
    endTime: trim.endTime,
    playbackDuration: trim.playbackDuration,
  };
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
  const plain = await resolveClientMediaPayload(story.toObject());
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
  return resolveClientMediaPayload(plainStories.map((story) => ({
    ...story,
    viewCount: counts.get(toIdStr(story._id)) || 0
  })));
};

// Fetch one still-active story by ID. This is intentionally constrained to
// the same 24-hour/media validity contract as feeds so notification deep links
// cannot resurrect expired or incomplete story records.
const getStory = async (req, res) => {
  try {
    setStoryNoStoreHeaders(res);
    const { storyId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(storyId)) {
      return res.status(400).json({ success: false, message: 'Invalid story ID' });
    }
    const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);
    const story = await Story.findOne(buildActiveStoryQuery({
      _id: storyId,
      createdAt: { $gte: since }
    })).select('-views').populate('author', 'username userType profile profilePicture privacySettings blockedUsers isActive').lean();
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found or expired' });
    }
    const authorAccess = await getStoryAuthorAccess(req.user, story.author);
    if (!authorAccess) return res.status(404).json({ success: false, message: 'Story not found or expired' });
    if (!authorAccess.relationship.access.canViewStories) {
      return rejectStoryPrivacy(res, authorAccess.author, authorAccess.relationship.access);
    }
    const counts = await getStoryViewCountMap([story._id]);
    const safeStory = await resolveClientMediaPayload({ ...story, author: minimalProfile(story.author) });
    return res.json({
      success: true,
      data: { story: { ...safeStory, viewCount: counts.get(toIdStr(story._id)) || 0 } }
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to fetch story' });
  }
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
  const uploadedPublicIds = [];
  let createdStoryId = null;

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
    if (!mediaFile.mimetype.startsWith('image/') && !mediaFile.mimetype.startsWith('video/')) {
      return res.status(415).json({ success: false, code: 'STORY_MEDIA_INVALID', message: 'Story media must be an image or video.' });
    }
    // Validate before media processing/upload so invalid metadata cannot leave
    // an uploaded asset behind or produce a Story missing its text.
    const overlays = parseStoryOverlays(req.body?.overlays);
    const musicFile = req.files?.music?.[0];
    const attachedMusicPayload = parseAttachedMusicPayload(req.body?.attachedMusic);
    if (musicFile && attachedMusicPayload) {
      return res.status(400).json({
        success: false,
        code: 'STORY_MUSIC_AMBIGUOUS',
        message: 'Choose either uploaded story music or selected music metadata, not both.',
      });
    }
    const musicValidation = validateStoryMusicFile(musicFile);
    if (!musicValidation.ok) {
      return res.status(musicValidation.statusCode).json({
        success: false,
        code: musicValidation.code,
        message: musicValidation.message,
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
    uploadedPublicIds.push(mediaPublicId);
    const media = {
      type: isVideo ? 'video' : 'image',
      url: mediaUrl,
      publicId: mediaPublicId
    };
    const verifiedVideoDuration = isVideo
      ? Number(uploadFile.duration || await probeMediaDuration(uploadFile))
      : STORY_MAX_SECONDS;
    const duration = isVideo
      ? Math.max(1, Math.min(STORY_MAX_SECONDS, verifiedVideoDuration))
      : STORY_MAX_SECONDS;
    let musicData;
    if (musicFile) {
      const verifiedMusicDuration = await probeMediaDuration(musicFile).catch((error) => {
        const validationError = new Error('Music duration could not be verified. Please choose another audio file.');
        validationError.statusCode = 422;
        validationError.code = 'STORY_MUSIC_DURATION_INVALID';
        validationError.cause = error;
        throw validationError;
      });
      const musicDurationValidation = validateStoryMusicDuration(verifiedMusicDuration);
      if (!musicDurationValidation.ok) {
        const durationError = new Error(musicDurationValidation.message);
        durationError.statusCode = musicDurationValidation.statusCode;
        durationError.code = musicDurationValidation.code;
        throw durationError;
      }
      const musicUploadFile = {
        ...musicFile,
        mimetype: musicValidation.mimeType,
        originalname: musicValidation.filename,
      };
      const musicResult = await uploadAudio(musicUploadFile, 'gaming-social/stories/music');
      if (!musicResult?.url || !musicResult?.publicId) {
        const uploadError = new Error('Music upload did not complete. Please retry or remove music.');
        uploadError.statusCode = 502;
        uploadError.code = 'STORY_MUSIC_UPLOAD_FAILED';
        throw uploadError;
      }
      uploadedPublicIds.push(musicResult.publicId);
      const trim = resolveStoryMusicTrim(req.body, musicDurationValidation.duration, duration);
      musicData = {
        url: musicResult.url,
        publicId: musicResult.publicId,
        filename: musicValidation.filename,
        mimeType: musicValidation.mimeType,
        size: musicValidation.size,
        duration: musicDurationValidation.duration,
        startTime: trim.startTime,
        endTime: trim.endTime,
        playbackDuration: trim.playbackDuration,
      };
    }
    if (!musicData && attachedMusicPayload) {
      musicData = await resolveAttachedStoryMusic({
        payload: attachedMusicPayload,
        userId: req.user._id,
        storyDuration: duration,
      });
    }
    const story = await Story.create({
      author: req.user._id,
      media,
      duration,
      overlays,
      ...(clientUploadId && { clientUploadId }),
      ...(musicData && { music: musicData })
    });
    createdStoryId = story._id;
    await StoryMediaAsset.create({
      story: story._id,
      owner: req.user._id,
      publicIds: uploadedPublicIds,
      expiresAt: new Date(story.createdAt.getTime() + TWENTY_FOUR_HOURS_MS),
    });
    return respondWithStory(res, story, 201);
  } catch (err) {
    if (clientUploadId && isDuplicateClientUploadError(err)) {
      const existingStory = await findStoryByClientUploadId(req.user._id, clientUploadId);
      if (existingStory) {
        await deletePublicIds(uploadedPublicIds).catch(async cleanupError => {
          await deferStoryAssetCleanup({
            ownerId: req.user._id,
            publicIds: uploadedPublicIds,
            error: cleanupError,
          }).catch(() => {});
          log.error('Duplicate Story upload cleanup failed', { error: String(cleanupError) });
        });
        return respondWithStory(res, existingStory, 200);
      }
    }
    if (createdStoryId) {
      await Story.deleteOne({ _id: createdStoryId }).catch(() => {});
    }
    await deletePublicIds(uploadedPublicIds).then(async () => {
      if (createdStoryId) await StoryMediaAsset.deleteOne({ story: createdStoryId }).catch(() => {});
    }).catch(async cleanupError => {
      await deferStoryAssetCleanup({
        storyId: createdStoryId,
        ownerId: req.user._id,
        publicIds: uploadedPublicIds,
        error: cleanupError,
      }).catch(() => {});
      log.error('Failed Story creation media cleanup failed', { error: String(cleanupError) });
    });
    const status = Number(err?.statusCode || 500);
    const safeMusicError = String(err?.code || '').startsWith('STORY_MUSIC_') || err?.code === 'STORY_OVERLAYS_INVALID';
    return res.status(status).json({
      success: false,
      ...(err?.code && { code: err.code }),
      message: safeMusicError
        ? (err.message || 'Music could not be attached to this Story.')
        : status >= 500
          ? 'Failed to create story'
          : (err.message || 'Failed to create story')
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
    const followingIds = await Follow.find({ follower: myId }).distinct('following');
    const allowedIds = [myIdStr];
    followingIds.map(toIdStr).forEach((id) => {
      if (!id || id === myIdStr) return;
      try {
        if (mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id) {
          allowedIds.push(id);
        }
      } catch (_) { /* skip invalid id */ }
    });
    const candidateUsers = await User.find({ _id: { $in: allowedIds }, isActive: true })
      .select('username userType profile privacySettings blockedUsers isActive')
      .lean();
    const allowedAfterPrivacy = [];
    for (const candidate of candidateUsers) {
      const relationship = await resolvePrivacyAccess({ viewer: req.user, targetUser: candidate });
      if (relationship.access.canViewStories) allowedAfterPrivacy.push(toIdStr(candidate._id));
    }
    const allowedObjectIds = allowedAfterPrivacy.map((id) => new mongoose.Types.ObjectId(id));

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
            profile: {
              displayName: '$userDoc.profile.displayName',
              avatar: '$userDoc.profile.avatar'
            },
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
    finalUsers = await resolveClientMediaPayload(finalUsers);

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
    console.error('getStoriesFeed error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch stories feed'
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
    const authorAccess = await getStoryAuthorAccess(req.user, userId);
    if (!authorAccess) return res.status(404).json({ success: false, message: 'User not found' });
    if (!authorAccess.relationship.access.canViewStories) {
      return rejectStoryPrivacy(res, authorAccess.author, authorAccess.relationship.access);
    }
    const since = new Date(Date.now() - TWENTY_FOUR_HOURS_MS);
    const isOwnStoryList = Boolean(req.user?._id && toIdStr(userId) === toIdStr(req.user._id));
    const query = Story.find(buildActiveStoryQuery({
      author: userId,
      createdAt: { $gte: since }
    })).select('-views');
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
      message: 'Failed to fetch stories'
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
    const story = await Story.findOne(buildActiveStoryQuery({
      _id: storyId,
      createdAt: { $gte: new Date(Date.now() - TWENTY_FOUR_HOURS_MS) }
    })).select('author').lean();
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }
    const authorAccess = await getStoryAuthorAccess(req.user, story.author);
    if (!authorAccess) return res.status(404).json({ success: false, message: 'Story not found' });
    if (!authorAccess.relationship.access.canViewStories) {
      return rejectStoryPrivacy(res, authorAccess.author, authorAccess.relationship.access);
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
      message: 'Failed to record view'
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
      message: 'Failed to fetch story viewers'
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
    cleanupStoryAssets({
      storyId: story._id,
      fallbackPublicIds: [story.media?.publicId, story.music?.publicId],
    }).catch((cleanupError) => {
      log.error('Story object storage cleanup deferred for retry', {
        error: String(cleanupError),
        storyId: String(story._id),
      });
    });
    await deleteNotificationsForTarget({ targetType: 'story', targetId: req.params.storyId }).catch((cleanupError) => {
      log.error('Story notification cleanup failed', { error: String(cleanupError), storyId: String(req.params.storyId) });
    });
    return res.json({ success: true, message: 'Story deleted' });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to delete story'
    });
  }
};

module.exports = {
  createStory,
  getStory,
  getStoriesFeed,
  getUserStories,
  viewStory,
  getStoryViewers,
  deleteStory
};
