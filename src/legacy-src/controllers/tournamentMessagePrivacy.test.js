const assert = require('assert');
const User = require('../models/User');
const {
  _private: {
    canReadTournamentMessages,
    canReadGroupMessages,
    sanitizeTournamentMessages
  }
} = require('./tournamentController');

const id = (value) => ({ _id: value, toString: () => value });

(async () => {
  const originalExists = User.exists;
  User.exists = async () => null;
  try {
    const tournament = {
      host: id('host'),
      participants: [id('participant')],
      teams: [id('team')]
    };
    assert.strictEqual(await canReadTournamentMessages(tournament, id('host')), true);
    assert.strictEqual(await canReadTournamentMessages(tournament, id('participant')), true);
    assert.strictEqual(await canReadTournamentMessages(tournament, id('team')), true);
    assert.strictEqual(
      await canReadTournamentMessages(tournament, id('unrelated')),
      false,
      'an unrelated authenticated user must not read tournament messages'
    );

    const group = { participants: [id('participant')] };
    assert.strictEqual(await canReadGroupMessages(tournament, group, id('host')), true);
    assert.strictEqual(await canReadGroupMessages(tournament, group, id('participant')), true);
    assert.strictEqual(
      await canReadGroupMessages(tournament, group, id('team')),
      false,
      'a participant in another group must not read this group thread'
    );

    const [message] = sanitizeTournamentMessages([{
      message: 'Authorized message',
      sender: {
        _id: 'sender',
        username: 'sender',
        email: 'must-not-leak@example.com',
        lastSeen: new Date(),
        privacySettings: { profileVisibility: 'private' },
        profile: { displayName: 'Sender', avatar: 'sender.png', bio: 'protected' }
      }
    }]);
    assert.strictEqual(message.sender.email, undefined);
    assert.strictEqual(message.sender.lastSeen, undefined);
    assert.strictEqual(message.sender.privacySettings, undefined);
    assert.strictEqual(message.sender.profile.bio, undefined);
  } finally {
    User.exists = originalExists;
  }

  console.log('Tournament message privacy tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
