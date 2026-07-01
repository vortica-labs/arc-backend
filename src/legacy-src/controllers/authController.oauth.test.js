const assert = require('assert');

const stubModule = (request, exportsValue) => {
  const filename = require.resolve(request);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: exportsValue,
    children: [],
    paths: []
  };
};

let findOneImpl = () => null;
let createImpl = async () => {
  throw new Error('User.create should not be called in this test');
};
let completionUser = null;
let tokenCalls = 0;
let refreshTokenCalls = 0;
const invalidatedUserIds = [];
const completionEvents = [];

const User = {
  findOne(query) {
    return findOneImpl(query);
  },
  async findById() {
    return completionUser;
  },
  async create(data) {
    return createImpl(data);
  }
};

stubModule('../models/User', User);
stubModule('../models/OtpVerification', {});
stubModule('../models/Follow', {});
stubModule('../utils/jwt', {
  generateToken() {
    tokenCalls += 1;
    return 'app-token';
  },
  generateRefreshToken() {
    refreshTokenCalls += 1;
    return 'refresh-token';
  }
});
stubModule('../utils/cloudinary', {
  uploadAvatar: async () => ({}),
  uploadImage: async () => ({}),
  uploadAvatarFromUrl: async () => ({ url: '' })
});
stubModule('../utils/email', { sendOTPEmail: async () => {} });
stubModule('../utils/logger', { error: () => {}, warn: () => {}, info: () => {} });
stubModule('../middleware/auth', {
  invalidateUserCache: async (userId) => {
    invalidatedUserIds.push(String(userId));
    completionEvents.push('invalidate');
  }
});
let googleProfile = {
  sub: 'google-admin-subject',
  email: 'admin@example.com'
};
stubModule('axios', { get: async () => ({ data: googleProfile }) });

const { completeGoogleProfile, completeProfile, googleTokenLogin, register } = require('./authController');

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const dateYearsAgo = (years) => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
};

(async () => {
  let adminSaveCalled = false;
  findOneImpl = () => Promise.resolve({
    _id: 'admin-id',
    email: 'admin@example.com',
    username: 'admin-user',
    userType: 'admin',
    async save() {
      adminSaveCalled = true;
    }
  });

  const adminRes = createRes();
  await googleTokenLogin({ body: { access_token: 'google-access-token' } }, adminRes);

  assert.strictEqual(adminRes.statusCode, 403);
  assert.deepStrictEqual(adminRes.body, {
    success: false,
    message: 'Admin accounts must sign in through the dedicated Admin Portal.'
  });
  assert.strictEqual(adminSaveCalled, false);
  assert.strictEqual(tokenCalls, 0);
  assert.strictEqual(refreshTokenCalls, 0);

  let deactivatedSaveCalled = false;
  googleProfile = {
    sub: 'deactivated-google-subject',
    email: 'deactivated@example.com'
  };
  findOneImpl = () => Promise.resolve({
    _id: 'deactivated-user-id',
    email: 'deactivated@example.com',
    username: 'deactivated_user',
    userType: 'player',
    isActive: false,
    async save() {
      deactivatedSaveCalled = true;
    }
  });

  const deactivatedRes = createRes();
  await googleTokenLogin({ body: { access_token: 'google-access-token' } }, deactivatedRes);
  assert.strictEqual(deactivatedRes.statusCode, 401);
  assert.deepStrictEqual(deactivatedRes.body, {
    success: false,
    message: 'Account is deactivated.'
  });
  assert.strictEqual(deactivatedSaveCalled, false);
  assert.strictEqual(tokenCalls, 0);
  assert.strictEqual(refreshTokenCalls, 0);

  let existingGoogleSaveCalled = false;
  const existingGoogleUser = {
    _id: 'existing-google-id',
    email: 'existing@example.com',
    username: 'existing_player',
    userType: 'player',
    isActive: true,
    profile: { displayName: 'Existing Player' },
    needsProfileCompletion: false,
    async save() {
      existingGoogleSaveCalled = true;
    },
    toObject() {
      return { ...this };
    }
  };
  googleProfile = {
    sub: 'existing-google-subject',
    email: 'existing@example.com',
    name: 'Existing Player'
  };
  findOneImpl = () => Promise.resolve(existingGoogleUser);

  const existingGoogleRes = createRes();
  await googleTokenLogin({ body: { access_token: 'google-access-token' } }, existingGoogleRes);
  assert.strictEqual(existingGoogleRes.statusCode, 200);
  assert.strictEqual(existingGoogleRes.body.profileComplete, true);
  assert.strictEqual(existingGoogleRes.body.data.user.profile.displayName, 'Existing Player');
  assert.strictEqual(existingGoogleSaveCalled, true);

  let createdGoogleData = null;
  googleProfile = {
    sub: 'new-google-subject',
    email: 'new@example.com',
    name: 'New Google User'
  };
  findOneImpl = () => Promise.resolve(null);
  createImpl = async (data) => {
    createdGoogleData = data;
    return {
      _id: 'new-google-id',
      ...data,
      toObject() {
        return { ...this };
      }
    };
  };

  const newGoogleRes = createRes();
  await googleTokenLogin({ body: { access_token: 'google-access-token' } }, newGoogleRes);
  assert.strictEqual(newGoogleRes.statusCode, 200);
  assert.strictEqual(newGoogleRes.body.profileComplete, false);
  assert.strictEqual(newGoogleRes.body.user.needsProfileCompletion, true);
  assert.strictEqual(createdGoogleData.needsProfileCompletion, true);
  assert.strictEqual(createdGoogleData.profile.displayName, 'New Google User');

  createImpl = async () => {
    throw new Error('User.create should not be called during profile completion');
  };

  completionUser = {
    _id: 'google-user-id',
    email: 'player@example.com',
    username: 'temporary-name',
    userType: 'player',
    password: 'temporary-password',
    profile: {
      displayName: 'Google Name',
      avatar: 'https://example.test/avatar.png'
    },
    needsProfileCompletion: true,
    teamInfo: null,
    async save() {
      completionEvents.push('save');
    },
    toObject() {
      return { ...this };
    }
  };
  findOneImpl = () => ({ select: async () => null });

  const missingDisplayNameRes = createRes();
  await completeProfile({
    user: { _id: 'google-user-id' },
    body: {
      userType: 'team',
      username: 'completed_team'
    }
  }, missingDisplayNameRes);

  assert.strictEqual(missingDisplayNameRes.statusCode, 400);
  assert.strictEqual(missingDisplayNameRes.body.message, 'Display name is required and must be less than 50 characters');
  assert.strictEqual(completionUser.needsProfileCompletion, true);
  assert.deepStrictEqual(completionEvents, []);

  const underageRegistrationRes = createRes();
  await register({
    body: {
      userType: 'player',
      displayName: 'Young Player',
      username: 'young_player',
      email: 'young@example.com',
      password: 'password',
      dob: dateYearsAgo(10),
      otp: '123456'
    }
  }, underageRegistrationRes);

  assert.strictEqual(underageRegistrationRes.statusCode, 400);
  assert.strictEqual(underageRegistrationRes.body.message, 'You must be at least 13 years old');

  const completionRes = createRes();
  const validDob = dateYearsAgo(25);
  await completeProfile({
    user: { _id: 'google-user-id' },
    body: {
      userType: 'team',
      username: 'completed_team',
      displayName: 'Completed Team',
      gender: 'prefer_not_to_say',
      dob: validDob,
      bio: 'Ready to compete'
    }
  }, completionRes);

  assert.strictEqual(completionRes.statusCode, 200);
  assert.deepStrictEqual(completionEvents.slice(0, 2), ['save', 'invalidate']);
  assert.deepStrictEqual(invalidatedUserIds, ['google-user-id']);
  assert.strictEqual(completionUser.userType, 'team');
  assert.strictEqual(completionUser.username, 'completed_team');
  assert.strictEqual(completionUser.password, 'temporary-password');
  assert.strictEqual(completionUser.profile.displayName, 'Completed Team');
  assert.strictEqual(completionUser.profile.gender, 'prefer_not_to_say');
  assert.strictEqual(completionUser.profile.dob.toISOString(), `${validDob}T00:00:00.000Z`);
  assert.strictEqual(completionUser.profile.bio, 'Ready to compete');
  assert.strictEqual(completionUser.needsProfileCompletion, false);
  assert.strictEqual(completionRes.body.profileComplete, true);
  assert.strictEqual(completionRes.body.data.token, 'app-token');
  assert.strictEqual(completionRes.body.data.refreshToken, 'refresh-token');
  assert.strictEqual(completionRes.body.data.user.password, undefined);

  completionEvents.length = 0;
  invalidatedUserIds.length = 0;
  completionUser.needsProfileCompletion = true;
  completionUser.username = 'temporary-name';
  const compatibilityRes = createRes();
  await completeGoogleProfile({
    user: {
      _id: 'google-user-id',
      profile: { displayName: 'Stored OAuth Name' }
    },
    body: {
      userType: 'player',
      username: 'compatible_user',
      password: 'legacy-client-password'
    }
  }, compatibilityRes);

  assert.strictEqual(compatibilityRes.statusCode, 200);
  assert.strictEqual(completionUser.profile.displayName, 'Stored OAuth Name');
  assert.strictEqual(completionUser.password, 'temporary-password');
  assert.strictEqual(completionUser.needsProfileCompletion, false);

  console.log('Auth OAuth contract tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
