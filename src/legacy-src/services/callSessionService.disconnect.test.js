const assert = require('node:assert/strict');
const CallSession = require('../models/CallSession');
const { endAcceptedCallSessionsForUser } = require('./callSessionService');

const originalFind = CallSession.find;
let capturedFilter = null;

CallSession.find = (filter) => {
  capturedFilter = filter;
  return {
    select() {
      return {
        async lean() {
          return [];
        }
      };
    }
  };
};

endAcceptedCallSessionsForUser('507f1f77bcf86cd799439011')
  .then((ended) => {
    assert.deepEqual(ended, []);
    assert.equal(capturedFilter.status, 'accepted');
    assert.equal(Object.hasOwn(capturedFilter, 'expiresAt'), false);
    assert.equal(JSON.stringify(capturedFilter).includes('ringing'), false);
    assert.deepEqual(capturedFilter.$or, [
      { caller: '507f1f77bcf86cd799439011' },
      { callee: '507f1f77bcf86cd799439011' }
    ]);
    console.log('Call-session accepted-only disconnect cleanup tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    CallSession.find = originalFind;
  });
