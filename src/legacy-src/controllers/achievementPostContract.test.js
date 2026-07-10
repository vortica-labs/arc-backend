const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const { formatPostDTO } = require('../utils/dto');
const {
  ACHIEVEMENT_TYPES,
  normalizeAchievementInfoInput,
  validateAchievementPostBody,
  toAchievementInfoForPersistence
} = require('../utils/achievementPostPolicy');
const postController = require('./postController');

const responseRecorder = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const validBracketBody = {
  text: 'Won the finals',
  postType: 'achievement',
  'achievementInfo[gameTitle]': ' BGMI ',
  'achievementInfo[achievementType]': 'tournament_win',
  'achievementInfo[date]': '2026-07-09'
};

assert.deepStrictEqual(ACHIEVEMENT_TYPES, [
  'tournament_win',
  'rank_achievement',
  'milestone',
  'personal_best',
  'team_achievement',
  'other'
]);

const normalizedBracket = normalizeAchievementInfoInput(validBracketBody);
assert.deepStrictEqual(normalizedBracket.value, {
  gameTitle: 'BGMI',
  achievementType: 'tournament_win',
  date: '2026-07-09'
});
assert.strictEqual(validateAchievementPostBody(validBracketBody), null);

const normalizedJson = normalizeAchievementInfoInput({
  achievementInfo: JSON.stringify({
    gameTitle: 'Valorant',
    achievementType: 'rank_achievement',
    description: 'Reached Immortal',
    date: '2026-07-08T00:00:00.000Z'
  })
});
assert.strictEqual(normalizedJson.value.gameTitle, 'Valorant');
assert.strictEqual(normalizedJson.value.description, 'Reached Immortal');
assert.strictEqual(
  toAchievementInfoForPersistence(normalizedJson).date.toISOString(),
  '2026-07-08T00:00:00.000Z'
);

assert.strictEqual(
  validateAchievementPostBody({ ...validBracketBody, text: '' }),
  'Please add some content about your achievement'
);
assert.strictEqual(
  validateAchievementPostBody({ ...validBracketBody, 'achievementInfo[gameTitle]': ' ' }),
  'Please enter the game title'
);
assert.strictEqual(
  validateAchievementPostBody({ ...validBracketBody, 'achievementInfo[achievementType]': 'unsupported' }),
  'Invalid achievement type'
);
assert.strictEqual(
  validateAchievementPostBody({ ...validBracketBody, 'achievementInfo[date]': 'not-a-date' }),
  'Invalid achievement date'
);
assert.strictEqual(
  validateAchievementPostBody({ ...validBracketBody, 'achievementInfo[date]': '2026-02-31' }),
  'Invalid achievement date'
);
assert.strictEqual(
  validateAchievementPostBody({
    text: 'Normal post',
    postType: 'general',
    achievementInfo: { achievementType: 'unsupported', date: 'not-a-date' }
  }),
  null
);

const schemaPost = new Post({
  author: new mongoose.Types.ObjectId(),
  content: { text: 'Achievement post', media: [] },
  postType: 'achievement',
  achievementInfo: {
    gameTitle: 'BGMI',
    achievementType: 'tournament_win',
    description: 'Champion',
    date: new Date('2026-07-09T00:00:00.000Z')
  }
});
const schemaValidationError = schemaPost.validateSync();
assert.strictEqual(schemaValidationError, undefined);
const achievementDto = formatPostDTO(schemaPost, false, true);
assert.strictEqual(achievementDto.postType, 'achievement');
assert.strictEqual(achievementDto.achievementInfo.gameTitle, 'BGMI');
assert.strictEqual(achievementDto.achievementInfo.achievementType, 'tournament_win');

const runControllerContracts = async () => {
  const originalCreate = Post.create;
  const originalFindById = Post.findById;
  const originalUserUpdate = User.findByIdAndUpdate;

  try {
    let createdPayload;
    Post.create = async (payload) => {
      createdPayload = payload;
      const created = new Post({
        ...payload,
        _id: new mongoose.Types.ObjectId()
      });
      created.populate = async () => created;
      return created;
    };
    User.findByIdAndUpdate = async () => ({});

    const createResponse = responseRecorder();
    await postController.createPost({
      body: validBracketBody,
      files: [],
      user: { _id: new mongoose.Types.ObjectId(), userType: 'player' }
    }, createResponse);
    assert.strictEqual(createResponse.statusCode, 201);
    assert.strictEqual(createdPayload.postType, 'achievement');
    assert.strictEqual(createdPayload.achievementInfo.gameTitle, 'BGMI');
    assert.strictEqual(createdPayload.achievementInfo.achievementType, 'tournament_win');
    assert(createdPayload.achievementInfo.date instanceof Date);
    assert.strictEqual(createResponse.body.data.post.postType, 'achievement');
    assert.strictEqual(createResponse.body.data.post.achievementInfo.gameTitle, 'BGMI');

    const ownerId = new mongoose.Types.ObjectId();
    const fakePost = {
      _id: new mongoose.Types.ObjectId(),
      author: ownerId,
      content: { text: 'Original', media: [] },
      postType: 'achievement',
      achievementInfo: {
        gameTitle: 'BGMI',
        achievementType: 'tournament_win',
        description: 'Old description',
        date: new Date('2026-07-01T00:00:00.000Z')
      },
      tags: ['old'],
      visibility: 'public',
      likes: [],
      comments: [],
      shares: [],
      reports: [],
      viewedBy: [],
      views: 0,
      isActive: true,
      saveCalled: false,
      async save() { this.saveCalled = true; },
      async populate() { return this; },
      toObject() {
        const { save, populate, toObject, ...plain } = this;
        return plain;
      }
    };
    Post.findById = async () => fakePost;

    const updateResponse = responseRecorder();
    await postController.updatePost({
      params: { id: String(fakePost._id) },
      body: {
        text: 'Updated achievement',
        tags: ['winner', 'finals']
      },
      user: { _id: ownerId }
    }, updateResponse);
    assert.strictEqual(updateResponse.statusCode, 200);
    assert.strictEqual(fakePost.saveCalled, true);
    assert.strictEqual(fakePost.postType, 'achievement');
    assert.strictEqual(fakePost.content.text, 'Updated achievement');
    assert.deepStrictEqual(fakePost.tags, ['winner', 'finals']);
    assert.strictEqual(fakePost.achievementInfo.gameTitle, 'BGMI');
    assert.strictEqual(fakePost.achievementInfo.achievementType, 'tournament_win');
    assert.strictEqual(fakePost.achievementInfo.description, 'Old description');
    assert.strictEqual(fakePost.achievementInfo.date.toISOString(), '2026-07-01T00:00:00.000Z');
    assert.strictEqual(updateResponse.body.data.post.postType, 'achievement');
    assert.strictEqual(updateResponse.body.data.post.achievementInfo.gameTitle, 'BGMI');

    const invalidResponse = responseRecorder();
    await postController.createPost({
      body: { text: 'Missing metadata', postType: 'achievement' },
      files: [],
      user: { _id: ownerId, userType: 'player' }
    }, invalidResponse);
    assert.strictEqual(invalidResponse.statusCode, 400);
    assert.strictEqual(invalidResponse.body.message, 'Please enter the game title');
  } finally {
    Post.create = originalCreate;
    Post.findById = originalFindById;
    User.findByIdAndUpdate = originalUserUpdate;
  }
};

const backendRoot = path.resolve(__dirname, '../..');
const controllerSource = fs.readFileSync(path.join(__dirname, 'postController.js'), 'utf8');
const legacyRoutesSource = fs.readFileSync(path.join(backendRoot, 'legacy-src/routes/posts.js'), 'utf8');
const modularRoutesSource = fs.readFileSync(path.join(backendRoot, 'modules/posts/posts.routes.ts'), 'utf8');
const recommendationSource = fs.readFileSync(path.join(backendRoot, 'legacy-src/services/recommendationService.js'), 'utf8');
const userControllerSource = fs.readFileSync(path.join(__dirname, 'userController.js'), 'utf8');
const adminControllerSource = fs.readFileSync(path.join(__dirname, 'adminController.js'), 'utf8');

assert(controllerSource.includes('post: formatPostDTO(post, false, true)'));
assert(controllerSource.includes("'savedPosts.post': post._id"));
assert(legacyRoutesSource.includes('validateAchievementPostBody(req.body)'));
assert(modularRoutesSource.includes('validateAchievementPostBody(req.body)'));
assert(recommendationSource.includes('if (query.postType) filter.postType = query.postType'));
assert(!recommendationSource.includes("postType: { $ne: 'achievement' }"));
assert(recommendationSource.includes('dto.isSaved = Boolean'));
assert(!userControllerSource.includes("postType: { $ne: 'achievement' }"));
assert(adminControllerSource.includes('postType achievementInfo visibility'));

runControllerContracts()
  .then(() => console.log('Achievement post backend contracts passed'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
