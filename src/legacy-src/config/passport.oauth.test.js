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

let verifyGoogle = null;
let tokenCalls = 0;
let refreshTokenCalls = 0;
let avatarUploadCalls = 0;
let saveCalls = 0;

class GoogleStrategy {
  constructor(_options, verify) {
    verifyGoogle = verify;
  }
}

stubModule('passport', { use: () => {} });
stubModule('passport-google-oauth20', { Strategy: GoogleStrategy });
stubModule('../models/User', {
  findOne: async () => ({
    _id: 'deactivated-user-id',
    email: 'deactivated@example.com',
    username: 'deactivated_user',
    userType: 'player',
    isActive: false,
    async save() {
      saveCalls += 1;
    }
  }),
  create: async () => {
    throw new Error('Deactivated users must not create a replacement account');
  }
});
stubModule('../utils/jwt', {
  generateToken: () => {
    tokenCalls += 1;
    return 'token';
  },
  generateRefreshToken: () => {
    refreshTokenCalls += 1;
    return 'refresh-token';
  }
});
stubModule('../utils/cloudinary', {
  uploadAvatarFromUrl: async () => {
    avatarUploadCalls += 1;
    return { url: 'avatar' };
  }
});

require('./passport');

(async () => {
  assert.strictEqual(typeof verifyGoogle, 'function');

  const result = await new Promise((resolve, reject) => {
    verifyGoogle(
      'google-access-token',
      'google-refresh-token',
      {
        id: 'google-subject',
        displayName: 'Deactivated User',
        emails: [{ value: 'deactivated@example.com' }],
        photos: [{ value: 'https://example.test/avatar.png' }]
      },
      (error, user, info) => {
        if (error) return reject(error);
        return resolve({ user, info });
      }
    );
  });

  assert.strictEqual(result.user, false);
  assert.deepStrictEqual(result.info, { message: 'Account is deactivated.' });
  assert.strictEqual(avatarUploadCalls, 0);
  assert.strictEqual(saveCalls, 0);
  assert.strictEqual(tokenCalls, 0);
  assert.strictEqual(refreshTokenCalls, 0);

  console.log('Passport OAuth contract tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
