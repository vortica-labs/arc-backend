const express = require('express');
const { body } = require('express-validator');
const { protect, optionalAuth } = require('../middleware/auth');
const { uploadFields } = require('../middleware/upload');
const { handleValidationErrors } = require('../middleware/validation');
const { validateAchievementPostBody } = require('../utils/achievementPostPolicy');
const {
  createPost,
  getPosts,
  getClips,
  getPost,
  recordClipView,
  toggleLike,
  addComment,
  recordShare,
  toggleSave,
  trackInteraction,
  updatePost,
  deletePost,
  reportPost,
  boostPost
} = require('../controllers/postController');

const router = express.Router();

// Validation middleware – allow post with only media (no caption) or only text
const createPostValidation = [
  body('text')
    .optional({ values: 'null' })
    .isString()
    .isLength({ max: 2000 })
    .withMessage('Post content cannot exceed 2000 characters'),
  body()
    .custom((value, { req }) => {
      const hasText = req.body.text != null && String(req.body.text).trim().length > 0;
      const hasMedia = Array.isArray(req.files)
        ? req.files.length > 0
        : Boolean(req.files?.media?.length);
      if (!hasText && !hasMedia) {
        throw new Error('Post must have some text or at least one image/video');
      }
      return true;
    }),
  body('postType')
    .optional()
    .isIn(['general', 'recruitment', 'achievement', 'looking-for-team'])
    .withMessage('Invalid post type'),
  body('visibility')
    .optional()
    .isIn(['public', 'followers', 'private'])
    .withMessage('Invalid visibility setting'),
  body().custom((_, { req }) => {
    const validationError = validateAchievementPostBody(req.body);
    if (validationError) throw new Error(validationError);
    return true;
  })
];

const updatePostValidation = [
  body('text')
    .optional()
    .isLength({ min: 1, max: 2000 })
    .withMessage('Post content must be between 1 and 2000 characters'),
  body('visibility')
    .optional()
    .isIn(['public', 'followers', 'private'])
    .withMessage('Invalid visibility setting')
];

const addCommentValidation = [
  body('text')
    .isLength({ min: 1, max: 500 })
    .withMessage('Comment must be between 1 and 500 characters')
];

const MAX_ENGAGEMENT_DURATION_MS = 24 * 60 * 60 * 1000;
const engagementMetricValidation = [
  body('durationMs').optional({ values: 'null' }).isInt({ min: 0, max: MAX_ENGAGEMENT_DURATION_MS }).withMessage('Invalid engagement duration'),
  body('dwellTime').optional({ values: 'null' }).isInt({ min: 0, max: MAX_ENGAGEMENT_DURATION_MS }).withMessage('Invalid dwell time'),
  body('completionRate').optional({ values: 'null' }).isFloat({ min: 0, max: 1 }).withMessage('Completion rate must be between 0 and 1'),
  body('context').optional({ values: 'null' }).isString().trim().isLength({ max: 64 }).withMessage('Invalid engagement context'),
  body('source').optional({ values: 'null' }).isIn(['organic', 'boost']).withMessage('Invalid engagement source'),
  body('deliverySource').optional({ values: 'null' }).isIn(['organic', 'boost']).withMessage('Invalid delivery source')
];
const interactionValidation = [
  body('postId').isString().isMongoId().withMessage('Invalid post ID'),
  body('interactionType').isIn(['watch', 'like', 'comment', 'share', 'save', 'click', 'dwell_time', 'skip']).withMessage('Invalid interaction type'),
  body('clickedElement').optional({ values: 'null' }).isString().isLength({ max: 128 }).withMessage('Invalid clicked element'),
  ...engagementMetricValidation
];

// Routes
router.post('/', protect, uploadFields([{ name: 'media', maxCount: 5 }, { name: 'cover', maxCount: 1 }]), createPostValidation, handleValidationErrors, createPost);
router.get('/', optionalAuth, getPosts);
router.get('/clips', optionalAuth, getClips);
router.get('/:id', optionalAuth, getPost);
router.post('/:id/view', protect, engagementMetricValidation, handleValidationErrors, recordClipView);
router.post('/:id/like', protect, toggleLike);
router.post('/:id/comment', protect, addCommentValidation, handleValidationErrors, addComment);
router.post('/:id/share', protect, recordShare);
router.post('/:id/save', protect, toggleSave);
router.post('/interaction', protect, interactionValidation, handleValidationErrors, trackInteraction);
router.put('/:id', protect, updatePostValidation, handleValidationErrors, updatePost);
router.delete('/:id', protect, deletePost);
router.post('/:id/report', protect, reportPost);
router.post('/:id/boost', protect, boostPost);

module.exports = router;
