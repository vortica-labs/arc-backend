const assert = require('assert');
const {
  decodeCursor,
  encodeCursor,
  parseExcludedIds,
  scorePost,
  selectDiversePosts
} = require('./recommendationService');

const basePost = {
  _id: '507f1f77bcf86cd799439011',
  author: { _id: '507f1f77bcf86cd799439012' },
  postType: 'general',
  tags: ['bgmi'],
  content: { media: [{ type: 'video', url: 'https://example.com/a.mp4' }] },
  likes: [],
  comments: [],
  shares: [],
  reports: [],
  viewedBy: [],
  views: 0,
  createdAt: new Date()
};

const context = {
  mode: 'clips',
  relationship: {
    currentUserId: '507f1f77bcf86cd799439099',
    followingIds: new Set(['507f1f77bcf86cd799439012'])
  },
  interestProfile: {
    tagWeights: new Map([['bgmi', 10]]),
    authorWeights: new Map(),
    postTypeWeights: new Map()
  },
  seed: 'test'
};

const cursor = encodeCursor(basePost);
assert.strictEqual(decodeCursor(cursor).id, basePost._id);
assert.strictEqual(decodeCursor('not-valid'), null);

assert.deepStrictEqual(parseExcludedIds(`${basePost._id},bad-id`), [basePost._id]);

const highEngagementScore = scorePost({
  ...basePost,
  likes: [{ user: 'u1' }, { user: 'u2' }],
  comments: [{ user: 'u3' }],
  shares: [{ user: 'u4' }],
  viewedBy: [{ user: 'u5' }, { user: 'u6' }]
}, context);
const reportedScore = scorePost({
  ...basePost,
  reports: [{ user: 'u9' }, { user: 'u10' }]
}, context);
assert(highEngagementScore > reportedScore, 'engagement should outrank reported content');

const diverse = selectDiversePosts([
  { post: { ...basePost, _id: '507f1f77bcf86cd799439001', author: { _id: 'a1' }, tags: ['x'] }, score: 100 },
  { post: { ...basePost, _id: '507f1f77bcf86cd799439002', author: { _id: 'a1' }, tags: ['x'] }, score: 99 },
  { post: { ...basePost, _id: '507f1f77bcf86cd799439003', author: { _id: 'a2' }, tags: ['y'] }, score: 98 }
], 2, 'clips');
assert.deepStrictEqual(diverse.map((item) => item.post.author._id), ['a1', 'a2']);

console.log('recommendation service tests passed');
