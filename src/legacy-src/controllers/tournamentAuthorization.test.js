const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Tournament = require('../models/Tournament');
const User = require('../models/User');
const tournamentController = require('./tournamentController');

const makeQuery = (value) => ({
  select() { return this; },
  populate() { return this; },
  then(resolve) { return Promise.resolve(resolve(value)); }
});

const responseRecorder = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});

(async () => {
  const originalFindById = Tournament.findById;
  const originalUserFind = User.find;
  let saveCount = 0;
  let lookedUpId = '';
  let tournament = {
    _id: '507f1f77bcf86cd799439010',
    host: '507f1f77bcf86cd799439011',
    name: 'Authorization tournament',
    status: 'Registration Open',
    participants: ['507f1f77bcf86cd799439012'],
    teams: [],
    groups: [],
    groupResults: [],
    broadcasts: [],
    matches: [],
    save: async () => { saveCount += 1; }
  };
  Tournament.findById = (id) => {
    lookedUpId = String(id);
    return makeQuery(tournament);
  };
  User.find = () => ({
    select() { return this; },
    lean: async () => []
  });

  try {
    const outsider = { _id: '507f1f77bcf86cd799439099' };

    const assignResponse = responseRecorder();
    await tournamentController.assignParticipantToGroup({
      params: { id: String(tournament._id) },
      body: { participantId: tournament.participants[0], groupId: '', round: 1 },
      user: outsider
    }, assignResponse);
    assert.strictEqual(assignResponse.statusCode, 403);

    const createRoundResponse = responseRecorder();
    await tournamentController.createRound2({
      params: { id: String(tournament._id) },
      body: { groups: [{ name: 'Group A', participants: [] }], round: 2 },
      user: outsider
    }, createRoundResponse);
    assert.strictEqual(createRoundResponse.statusCode, 403);
    assert.strictEqual(lookedUpId, String(tournament._id), 'create-round-2 must consume the route :id parameter');

    const autoRoundResponse = responseRecorder();
    await tournamentController.autoAssignRound2({
      params: { id: String(tournament._id) },
      body: { groups: [{ name: 'Group A', participants: [] }], round: 2, qualifiedTeams: [] },
      user: outsider
    }, autoRoundResponse);
    assert.strictEqual(autoRoundResponse.statusCode, 403);
    assert.strictEqual(saveCount, 0, 'unauthorized tournament commands must not persist');

    const host = { _id: tournament.host };
    const hostRoundResponse = responseRecorder();
    await tournamentController.createRound2({
      params: { id: String(tournament._id) },
      body: { groups: [{ name: 'Group A', participants: [] }], round: 2 },
      user: host
    }, hostRoundResponse);
    assert.strictEqual(hostRoundResponse.statusCode, 409);
    assert.strictEqual(hostRoundResponse.body.success, false);
    assert.strictEqual(saveCount, 0, 'hosts cannot bypass submitted qualification state');

    const socketEvents = [];
    const io = {
      emit(event, payload) { socketEvents.push({ room: null, event, payload }); },
      to(room) {
        return { emit: (event, payload) => socketEvents.push({ room, event, payload }) };
      }
    };
    tournament = {
      ...tournament,
      status: 'Registration Open',
      groups: [],
      participants: [],
      teams: [],
      save: async () => { saveCount += 1; }
    };
    const startResponse = responseRecorder();
    await tournamentController.startTournament({
      params: { id: String(tournament._id) },
      user: host,
      app: { get: (key) => key === 'io' ? io : null }
    }, startResponse);
    assert.strictEqual(startResponse.statusCode, 200);
    assert.strictEqual(tournament.status, 'Ongoing');
    assert(socketEvents.some((entry) => entry.event === 'broadcast_message'));
    assert(socketEvents.some((entry) => entry.event === 'tournament_updated'));

    const teamId = '507f1f77bcf86cd799439055';
    tournament = {
      ...tournament,
      groupResults: [{
        round: 1,
        groupId: 'Group A',
        groupName: 'Group A',
        submittedAt: new Date('2026-07-03T00:00:00.000Z'),
        teams: [{
          _doc: { secretOwnerDocument: 'must-not-leak' },
          toObject: () => ({
            teamId,
            teamName: 'Safe Team',
            wins: 1,
            finishPoints: 10,
            positionPoints: 5,
            totalPoints: 15,
            rank: 1,
            qualified: true
          })
        }]
      }]
    };
    const resultsResponse = responseRecorder();
    await tournamentController.getRoundResults({
      params: { id: String(tournament._id), round: '1' },
      user: { _id: tournament.participants?.[0] || host._id }
    }, resultsResponse);
    assert.strictEqual(resultsResponse.statusCode, 200);
    assert.strictEqual(resultsResponse.body.data.overallStandings[0].teamId, teamId);
    assert.strictEqual(resultsResponse.body.data.overallStandings[0].totalPoints, 15);
    assert.strictEqual(resultsResponse.body.data.overallStandings[0].qualified, true);
    assert(!JSON.stringify(resultsResponse.body).includes('secretOwnerDocument'));
  } finally {
    Tournament.findById = originalFindById;
    User.find = originalUserFind;
  }

  const root = path.resolve(__dirname, '../..');
  const controllerSource = fs.readFileSync(path.join(root, 'legacy-src/controllers/tournamentController.js'), 'utf8');
  const userControllerSource = fs.readFileSync(path.join(root, 'legacy-src/controllers/userController.js'), 'utf8');
  const routesSource = fs.readFileSync(path.join(root, 'modules/tournaments/tournaments.routes.ts'), 'utf8');
  const legacyRoutesSource = fs.readFileSync(path.join(root, 'legacy-src/routes/tournaments.js'), 'utf8');

  assert(!controllerSource.includes("require('../server')"), 'modular controllers must use the injected Socket.IO server');
  assert(!controllerSource.includes('id.length > 20'), 'ObjectIds must never be misclassified as tournament codes');
  assert(controllerSource.includes('const isTournamentCode ='));
  assert(controllerSource.includes("$addToSet: { [registrationField]: userId }"), 'normal registration must reserve capacity atomically');
  assert(controllerSource.includes('req.body[field] !== undefined'), 'updates must use an explicit field whitelist');
  assert(!controllerSource.includes("'specialPrizes', 'rules', 'banner'"), 'body-supplied banner paths must not be accepted');
  assert(controllerSource.includes("io.emit('tournament_updated', publicTournamentViewerShape(payload))"));
  assert(controllerSource.includes("PUBLIC_TEAM_POPULATE"));
  assert(controllerSource.includes('multer.memoryStorage()'), 'tournament banners must not use ephemeral container storage');
  assert(controllerSource.includes("uploadImage(req.file, 'gaming-social/tournaments'"));
  assert(controllerSource.includes('validateTournamentGameConfiguration(game, mode, format)'));
  assert(controllerSource.includes('submittedRoundCoverage(tournament, currentRoundNumber)'));
  assert(controllerSource.includes('MAX_GENERATED_MATCHES_PER_ROUND'));
  assert(controllerSource.includes("message: 'Historical and future round results are read-only'"));
  assert(controllerSource.includes('expandTournamentRecipientIds'), 'team registrations must notify their active members');
  assert(controllerSource.includes("const tournamentId = req.params.id || req.params.tournamentId"));
  assert(!controllerSource.includes('memberUser.playerInfo.joinedTeams'), 'leaving a tournament must not remove team membership');
  const removeParticipantSource = controllerSource.slice(
    controllerSource.indexOf('const removeParticipant = async'),
    controllerSource.indexOf('const assignParticipantToGroup = async')
  );
  const startMatchSource = controllerSource.slice(
    controllerSource.indexOf('const startMatch = async'),
    controllerSource.indexOf('const completeMatch = async')
  );
  assert(!removeParticipantSource.includes("match.status !== 'Scheduled'"), 'participant removal must not reference match state');
  assert(startMatchSource.includes("match.status !== 'Scheduled'"), 'match start must reject invalid lifecycle transitions');
  assert(userControllerSource.includes("Duo teammate must be one of your followers"));
  assert(userControllerSource.includes("format: 'Duo'"));
  assert(userControllerSource.includes("status: 'Registration Open'"));
  assert(userControllerSource.includes("$addToSet: { teams: team._id }"));
  assert(userControllerSource.includes('duoRegistrationMembers: { $nin: reservedMemberIds }'));
  assert(userControllerSource.includes('duoRegistrationMembers: { $each: reservedMemberIds }'));
  assert(userControllerSource.includes("password: crypto.randomBytes(32).toString('hex')"));
  assert(!userControllerSource.includes("password: 'team123'"));
  assert(routesSource.includes('router.post("/:id/assign-participant", protect'));
  assert(routesSource.includes('router.post("/:id/auto-assign-round-2", protect'));
  assert(routesSource.includes('router.post("/:id/join-duo", protect'));
  assert(legacyRoutesSource.includes("router.post('/:id/assign-participant', protect"));
  assert(legacyRoutesSource.includes("router.post('/:id/auto-assign-round-2', protect"));

  console.log('Tournament authorization contract tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
