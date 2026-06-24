const express = require('express');
const { protect } = require('../middleware/auth');
const { uploadFields } = require('../middleware/upload');
const {
  createStory,
  getStoriesFeed,
  getUserStories,
  viewStory,
  getStoryViewers,
  deleteStory
} = require('../controllers/storyController');

const router = express.Router();

router.get('/feed', protect, getStoriesFeed);
router.get('/user/:userId', protect, getUserStories);
router.post('/', protect, uploadFields([{ name: 'media', maxCount: 1 }, { name: 'music', maxCount: 1 }]), createStory);
router.post('/:storyId/view', protect, viewStory);
router.get('/:storyId/views', protect, getStoryViewers);
router.delete('/:storyId', protect, deleteStory);

module.exports = router;
