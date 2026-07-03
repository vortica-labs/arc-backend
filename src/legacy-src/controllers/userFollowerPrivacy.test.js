const assert = require('assert');
const mongoose = require('mongoose');

const User = require('../models/User');
const Follow = require('../models/Follow');
const FollowRequest = require('../models/FollowRequest');
const userController = require('./userController');

const targetId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
const followerId = new mongoose.Types.ObjectId('507f1f77bcf86cd799439012');

const responseRecorder = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const publicTarget = () => new User({
  _id: targetId,
  username: 'target_user',
  userType: 'player',
  isActive: true,
  blockedUsers: [],
  privacySettings: {
    profileVisibility: 'public',
    showPostsToFollowers: true
  }
});

const followerRecord = () => ({
  _id: followerId,
  username: 'follower_user',
  userType: 'player',
  isActive: true,
  blockedUsers: [],
  profile: { displayName: 'Follower User' },
  privacySettings: {
    profileVisibility: 'public',
    showOnlineStatus: true,
    allowFollowRequests: true
  }
});

const guestRequest = (id = String(targetId)) => ({
  params: { id },
  query: { page: '1', limit: '20' },
  user: {
    _id: 'guest_00000000-0000-4000-8000-000000000000',
    username: 'guest',
    userType: 'guest'
  }
});

(async () => {
  const originals = {
    findById: User.findById,
    isFollowing: Follow.isFollowing,
    getFollowers: Follow.getFollowers,
    getFollowing: Follow.getFollowing,
    followFind: Follow.find,
    followRequestFind: FollowRequest.find
  };

  let target = publicTarget();
  let followerQueries = 0;
  let followingQueries = 0;
  let relationshipQueryAttempted = false;

  User.findById = (id) => ({
    select: async () => {
      assert.strictEqual(String(id), String(targetId));
      return target;
    }
  });
  Follow.isFollowing = async () => {
    relationshipQueryAttempted = true;
    throw new Error('guest follower lists must not query viewer relationships');
  };
  Follow.find = () => {
    relationshipQueryAttempted = true;
    throw new Error('guest follower lists must not query viewer follows');
  };
  FollowRequest.find = () => {
    relationshipQueryAttempted = true;
    throw new Error('guest follower lists must not query follow requests');
  };
  Follow.getFollowers = async (id, options) => {
    followerQueries += 1;
    assert.strictEqual(String(id), String(targetId));
    assert.deepStrictEqual(options, { page: 1, limit: 20, search: '', excludeUserIds: [] });
    return { users: [followerRecord()], total: 1, pages: 1, current: 1 };
  };
  Follow.getFollowing = async (id, options) => {
    followingQueries += 1;
    assert.strictEqual(String(id), String(targetId));
    assert.deepStrictEqual(options, { page: 1, limit: 20, search: '', excludeUserIds: [] });
    return { users: [followerRecord()], total: 1, pages: 1, current: 1 };
  };

  try {
    const followersResponse = responseRecorder();
    await userController.getFollowers(guestRequest(), followersResponse);
    assert.strictEqual(followersResponse.statusCode, 200);
    assert.strictEqual(followersResponse.body.success, true);
    assert.strictEqual(followersResponse.body.data.followers.length, 1);
    assert.strictEqual(followersResponse.body.data.followers[0]._id, String(followerId));
    assert.strictEqual(followersResponse.body.data.pagination.totalFollowers, 1);

    const followingResponse = responseRecorder();
    await userController.getFollowing(guestRequest(), followingResponse);
    assert.strictEqual(followingResponse.statusCode, 200);
    assert.strictEqual(followingResponse.body.success, true);
    assert.strictEqual(followingResponse.body.data.following.length, 1);
    assert.strictEqual(followingResponse.body.data.following[0]._id, String(followerId));
    assert.strictEqual(followingResponse.body.data.pagination.totalFollowing, 1);

    assert.strictEqual(followerQueries, 1);
    assert.strictEqual(followingQueries, 1);
    assert.strictEqual(relationshipQueryAttempted, false);

    target = new User({
      _id: targetId,
      username: 'private_target',
      userType: 'player',
      isActive: true,
      blockedUsers: [],
      privacySettings: { profileVisibility: 'private' }
    });
    const privateResponse = responseRecorder();
    await userController.getFollowers(guestRequest(), privateResponse);
    assert.strictEqual(privateResponse.statusCode, 403);
    assert.strictEqual(privateResponse.body.code, 'PRIVACY_RESTRICTED');
    assert.strictEqual(followerQueries, 1, 'private target must be rejected before list lookup');

    console.log('user follower privacy tests passed');
  } finally {
    User.findById = originals.findById;
    Follow.isFollowing = originals.isFollowing;
    Follow.getFollowers = originals.getFollowers;
    Follow.getFollowing = originals.getFollowing;
    Follow.find = originals.followFind;
    FollowRequest.find = originals.followRequestFind;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
