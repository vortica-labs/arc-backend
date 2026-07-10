const assert = require('assert');
const Scrim = require('../models/Scrim');
const User = require('../models/User');
const notificationEmitter = require('../utils/notificationEmitter');

const controllerPath = require.resolve('./scrimController');
const originals = {
  findById: Scrim.findById,
  findOneAndUpdate: Scrim.findOneAndUpdate,
  updateOne: Scrim.updateOne,
  userFindById: User.findById,
  userFind: User.find,
  userFindOne: User.findOne,
  createAndEmitNotification: notificationEmitter.createAndEmitNotification
};

const makeResponse = () => ({
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

const scrimId = '64b000000000000000000010';
const hostId = '64b000000000000000000011';
const participantId = '64b000000000000000000012';
const teamMemberId = '64b000000000000000000013';

(async () => {
  try {
    // Notification delivery is deliberately rejected: persistence commands
    // must still succeed because the controller uses an all-settled producer.
    const emittedRecipients = [];
    notificationEmitter.createAndEmitNotification = async (notification) => {
      emittedRecipients.push(String(notification.recipient));
      throw new Error('simulated push failure');
    };
    delete require.cache[controllerPath];
    const { assignScrimSpecialPrize, joinScrim, leaveScrim, updateScrim } = require(controllerPath);

    const sourceScrim = {
      _id: scrimId,
      host: hostId,
      name: 'Evening Scrim',
      description: '',
      format: 'Squad',
      scrimType: 'Daily',
      timeSlot: '7-8',
      numberOfMatches: 1,
      date: new Date('2099-07-03T00:00:00.000Z'),
      endDate: null,
      maxTeams: 16,
      timezone: 'Asia/Kolkata',
      prizePoolType: 'without_prize',
      prizePool: 0,
      prizePoolCurrency: 'INR',
      prizeDistribution: [],
      specialPrizes: [],
      matches: [{ matchNumber: 1, map: 'Erangel', idpTime: '18:00', startTime: '18:30' }],
      registeredTeams: [],
      status: 'Open',
      __v: 2
    };
    const joinedScrim = {
      ...sourceScrim,
      registeredTeams: [participantId],
      updatedAt: new Date(),
      populate: async () => joinedScrim
    };
    let admissionCommand;
    Scrim.findById = async () => sourceScrim;
    User.findById = () => ({ select: async () => ({ userType: 'team' }) });
    User.find = () => ({ select: () => ({ lean: async () => [] }) });
    Scrim.findOneAndUpdate = async (filter, update, options) => {
      admissionCommand = { filter, update, options };
      return joinedScrim;
    };
    Scrim.updateOne = async () => ({ modifiedCount: 0 });

    const joinResponse = makeResponse();
    await joinScrim({
      params: { id: scrimId },
      user: { _id: participantId, username: 'team-alpha', profile: { displayName: 'Team Alpha' } }
    }, joinResponse);
    assert.strictEqual(joinResponse.statusCode, 200);
    assert.strictEqual(joinResponse.body.success, true);
    assert.strictEqual(Array.isArray(admissionCommand.update), false);
    assert.deepStrictEqual(admissionCommand.update, { $addToSet: { registeredTeams: participantId } });
    assert.deepStrictEqual(admissionCommand.filter['registeredTeams.15'], { $exists: false });
    assert.strictEqual(admissionCommand.options.runValidators, true);

    const updatedScrim = {
      ...sourceScrim,
      name: 'Renamed Scrim',
      updatedAt: new Date(),
      populate: async () => updatedScrim
    };
    let editCommand;
    Scrim.findById = async () => sourceScrim;
    Scrim.findOneAndUpdate = async (filter, update, options) => {
      editCommand = { filter, update, options };
      return updatedScrim;
    };
    const editResponse = makeResponse();
    await updateScrim({
      params: { id: scrimId },
      user: { _id: hostId, username: 'host' },
      body: { name: ' Renamed Scrim ' }
    }, editResponse);
    assert.strictEqual(editResponse.statusCode, 200);
    assert.strictEqual(editResponse.body.data.scrim.name, 'Renamed Scrim');
    assert.strictEqual(editCommand.filter.__v, 2);
    assert.strictEqual(editCommand.update.$set.name, 'Renamed Scrim');
    assert.strictEqual(editCommand.update.$set.registeredTeams, undefined, 'edit must not overwrite concurrent registrations');
    assert.deepStrictEqual(editCommand.update.$inc, { __v: 1 });
    assert.strictEqual(editCommand.options.runValidators, true);

    // Repeat admission is rejected before a database mutation.
    let mutationCalled = false;
    Scrim.findById = async () => ({ ...sourceScrim, registeredTeams: [participantId] });
    Scrim.findOneAndUpdate = async () => {
      mutationCalled = true;
      return null;
    };
    const duplicateResponse = makeResponse();
    await joinScrim({
      params: { id: scrimId },
      user: { _id: participantId, username: 'team-alpha', profile: {} }
    }, duplicateResponse);
    assert.strictEqual(duplicateResponse.statusCode, 400);
    assert.match(duplicateResponse.body.message, /already registered/i);
    assert.strictEqual(mutationCalled, false);

    // A competing request can take the final slot between read and mutation.
    // The guarded command returns null and the endpoint reports Full, not 500.
    const fifteenParticipants = Array.from(
      { length: 15 },
      (_, index) => (index + 100).toString(16).padStart(24, '0')
    );
    const latestFull = {
      ...sourceScrim,
      status: 'Full',
      registeredTeams: [...fifteenParticipants, '64b000000000000000000099']
    };
    let lookupCount = 0;
    const queryFor = (value) => ({
      select: async () => value,
      then: (resolve, reject) => Promise.resolve(value).then(resolve, reject)
    });
    Scrim.findById = () => queryFor(lookupCount++ === 0
      ? { ...sourceScrim, registeredTeams: fifteenParticipants }
      : latestFull);
    Scrim.findOneAndUpdate = async () => null;
    const finalSlotResponse = makeResponse();
    await joinScrim({
      params: { id: scrimId },
      user: { _id: participantId, username: 'team-alpha', profile: {} }
    }, finalSlotResponse);
    assert.strictEqual(finalSlotResponse.statusCode, 400);
    assert.match(finalSlotResponse.body.message, /full/i);

    const committedFinalSlot = {
      ...sourceScrim,
      registeredTeams: [...fifteenParticipants, participantId],
      updatedAt: new Date(),
      populate: async () => committedFinalSlot
    };
    Scrim.findById = async () => ({ ...sourceScrim, registeredTeams: fifteenParticipants });
    Scrim.findOneAndUpdate = async () => committedFinalSlot;
    Scrim.updateOne = async () => { throw new Error('simulated derived-status failure'); };
    const partialCommitResponse = makeResponse();
    await joinScrim({
      params: { id: scrimId },
      user: { _id: participantId, username: 'team-alpha', profile: {} }
    }, partialCommitResponse);
    assert.strictEqual(partialCommitResponse.statusCode, 200, 'committed join must not be reported as failed');

    // Missing legacy participant arrays are admitted safely with $addToSet.
    const missingArraySource = { ...sourceScrim, registeredTeams: undefined };
    const missingArrayJoined = {
      ...sourceScrim,
      registeredTeams: [participantId],
      updatedAt: new Date(),
      populate: async () => { throw new Error('simulated populate failure'); }
    };
    Scrim.findById = async () => missingArraySource;
    User.find = () => ({
      select: () => ({
        lean: async () => [{
          teamInfo: { members: [{ user: teamMemberId }], rosters: [], staff: [] }
        }]
      })
    });
    emittedRecipients.length = 0;
    Scrim.findOneAndUpdate = async (_filter, update) => {
      assert.deepStrictEqual(update, { $addToSet: { registeredTeams: participantId } });
      return missingArrayJoined;
    };
    Scrim.updateOne = async () => ({ modifiedCount: 0 });
    const legacyJoinResponse = makeResponse();
    await joinScrim({
      params: { id: scrimId },
      user: { _id: participantId, username: 'team-alpha', profile: {} }
    }, legacyJoinResponse);
    assert.strictEqual(legacyJoinResponse.statusCode, 200);
    assert.deepStrictEqual(
      [...new Set(emittedRecipients)].sort(),
      [hostId, teamMemberId].sort(),
      'team-account notifications must also reach active team members'
    );

    lookupCount = 0;
    const nullArraySource = { ...sourceScrim, registeredTeams: null };
    Scrim.findById = () => queryFor(nullArraySource);
    Scrim.findOneAndUpdate = async (filter) => {
      assert.deepStrictEqual(filter.$and[1].$or[1].registeredTeams, { $type: 'array' });
      return null;
    };
    const corruptArrayResponse = makeResponse();
    await joinScrim({
      params: { id: scrimId },
      user: { _id: participantId, username: 'team-alpha', profile: {} }
    }, corruptArrayResponse);
    assert.strictEqual(corruptArrayResponse.statusCode, 409, 'legacy null arrays must remain recoverable');

    // Leave uses an atomic $pull, reopens a formerly Full scrim, and strips the
    // participant-only broadcast archive from the response after membership ends.
    const fullSource = {
      ...sourceScrim,
      status: 'Full',
      registeredTeams: [participantId, ...fifteenParticipants],
      broadcasts: [{ message: 'private room details' }]
    };
    const leftDocument = {
      ...fullSource,
      registeredTeams: fifteenParticipants,
      updatedAt: new Date(),
      populate: async () => { throw new Error('simulated populate failure'); },
      toObject: () => ({ ...leftDocument, toObject: undefined, populate: undefined })
    };
    let leaveCommand;
    Scrim.findById = async () => fullSource;
    Scrim.findOneAndUpdate = async (filter, update, options) => {
      leaveCommand = { filter, update, options };
      return leftDocument;
    };
    Scrim.updateOne = async () => ({ modifiedCount: 1 });
    const leaveResponse = makeResponse();
    await leaveScrim({
      params: { id: scrimId },
      user: { _id: participantId, username: 'team-alpha', profile: {} }
    }, leaveResponse);
    assert.strictEqual(leaveResponse.statusCode, 200);
    assert.deepStrictEqual(leaveCommand.update, { $pull: { registeredTeams: participantId } });
    assert.strictEqual(leftDocument.status, 'Open');
    assert.strictEqual(leaveResponse.body.data.scrim.broadcasts, undefined);

    const prizeScrim = {
      ...sourceScrim,
      registeredTeams: [participantId],
      specialPrizes: [{ category: 'Most Finishes', amount: 100 }],
      finalResult: { specialPrizeWinners: [{ category: 'Most Finishes', amount: 100 }] },
      save: async () => prizeScrim
    };
    Scrim.findById = async () => prizeScrim;
    const outsiderResponse = makeResponse();
    await assignScrimSpecialPrize({
      params: { id: scrimId },
      user: { _id: hostId },
      body: { category: 'Most Finishes', winnerId: '64b000000000000000000099', winnerName: 'Spoofed' }
    }, outsiderResponse);
    assert.strictEqual(outsiderResponse.statusCode, 400);
    assert.match(outsiderResponse.body.message, /registered scrim participant/i);

    User.findOne = () => ({
      select: () => ({
        lean: async () => ({ username: 'real-winner', profile: { displayName: 'Real Winner' } })
      })
    });
    const winnerResponse = makeResponse();
    await assignScrimSpecialPrize({
      params: { id: scrimId },
      user: { _id: hostId },
      body: { category: 'Most Finishes', winnerId: participantId, winnerName: 'Spoofed' }
    }, winnerResponse);
    assert.strictEqual(winnerResponse.statusCode, 200);
    assert.strictEqual(prizeScrim.specialPrizes[0].winnerName, 'Real Winner');
    assert.strictEqual(prizeScrim.finalResult.specialPrizeWinners[0].winnerName, 'Real Winner');

    console.log('Scrim join/edit database command regressions passed');
  } finally {
    Scrim.findById = originals.findById;
    Scrim.findOneAndUpdate = originals.findOneAndUpdate;
    Scrim.updateOne = originals.updateOne;
    User.findById = originals.userFindById;
    User.find = originals.userFind;
    User.findOne = originals.userFindOne;
    notificationEmitter.createAndEmitNotification = originals.createAndEmitNotification;
    delete require.cache[controllerPath];
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
