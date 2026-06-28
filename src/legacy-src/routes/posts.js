const express = require('express');
const { body } = require('express-validator');
const { protect, optionalAuth } = require('../middleware/auth');
const { uploadFields } = require('../middleware/upload');
const { handleValidationErrors } = require('../middleware/validation');
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
    .withMessage('Invalid visibility setting')
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

// Routes
router.post('/', protect, uploadFields([{ name: 'media', maxCount: 5 }, { name: 'cover', maxCount: 1 }]), createPostValidation, handleValidationErrors, createPost);
router.get('/', optionalAuth, getPosts);
router.get('/clips', optionalAuth, getClips);
router.get('/:id', optionalAuth, getPost);
router.post('/:id/view', protect, recordClipView);
router.post('/:id/like', protect, toggleLike);
router.post('/:id/comment', protect, addCommentValidation, handleValidationErrors, addComment);
router.post('/:id/share', protect, recordShare);
router.post('/:id/save', protect, toggleSave);
router.post('/interaction', protect, trackInteraction);
router.put('/:id', protect, updatePostValidation, handleValidationErrors, updatePost);
router.delete('/:id', protect, deletePost);
router.post('/:id/report', protect, reportPost);
router.post('/:id/boost', protect, boostPost);

module.exports = router;
