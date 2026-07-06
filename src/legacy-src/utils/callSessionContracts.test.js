const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const legacyRoot = path.resolve(__dirname, '..');
const backendRoot = path.resolve(legacyRoot, '..');
const CallSession = require('../models/CallSession');
const CallVoipPushAttempt = require('../models/CallVoipPushAttempt');

const service = fs.readFileSync(path.join(legacyRoot, 'services', 'callSessionService.js'), 'utf8');
const controller = fs.readFileSync(path.join(legacyRoot, 'controllers', 'callSessionController.js'), 'utf8');
const routes = fs.readFileSync(path.join(legacyRoot, 'routes', 'calls.js'), 'utf8');
const socket = fs.readFileSync(path.join(backendRoot, 'modules', 'legacy', 'legacy.socket.ts'), 'utf8');
const socketBootstrap = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'websocket', 'socket.ts'), 'utf8');
const push = fs.readFileSync(path.join(legacyRoot, 'utils', 'pushNotificationService.js'), 'utf8');
const server = fs.readFileSync(path.join(backendRoot, 'server.ts'), 'utf8');
const apnsService = fs.readFileSync(path.join(legacyRoot, 'services', 'apnsVoipPushService.js'), 'utf8');
const notificationsRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'notifications', 'notifications.routes.ts'), 'utf8');
const callController = fs.readFileSync(path.join(legacyRoot, 'controllers', 'callController.js'), 'utf8');
const migration = fs.readFileSync(path.join(backendRoot, '..', 'scripts', 'migrate-push-infrastructure.js'), 'utf8');

for (const field of [
  'callId', 'nativeCallId', 'caller', 'callee', 'participantLeaseKeys',
  'participantLeaseActive', 'callType', 'status', 'expiresAt',
  'acceptedInstallationId', 'activeUntil', 'purgeAt'
]) {
  assert(CallSession.schema.path(field), `CallSession.${field} is required`);
}
for (const field of [
  'initialVoipPushStatus', 'initialVoipPushAttempts', 'initialVoipPushNextAttemptAt',
  'initialVoipPushLeaseAt', 'initialVoipPushLeaseKey', 'initialVoipPushLastError',
  'initialVoipPushCompletedAt', 'initialVoipFallbackSentAt',
  'statePushStatus', 'statePushRevision', 'statePushExcludeInstallationId',
  'statePushAttempts', 'statePushNextAttemptAt', 'statePushLeaseAt',
  'statePushLeaseKey', 'statePushLastError', 'statePushCompletedAt'
]) assert(CallSession.schema.path(field), `CallSession.${field} is required for durable call push recovery`);
assert(CallSession.schema.indexes().some(([key, options]) => key.callId === 1 && options.unique));
assert(CallSession.schema.indexes().some(([key, options]) => key.nativeCallId === 1 && options.unique));
assert(CallSession.schema.indexes().some(([key, options]) =>
  key.participantLeaseKeys === 1 && options.unique && options.partialFilterExpression?.participantLeaseActive === true
));
assert(CallSession.schema.indexes().some(([key, options]) => key.purgeAt === 1 && options.expireAfterSeconds === 0));
assert(CallVoipPushAttempt.schema.indexes().some(([key, options]) => key.requestKey === 1 && key.voipTokenHash === 1 && options.unique));
assert(CallVoipPushAttempt.schema.indexes().some(([key, options]) => key.expiresAt === 1 && options.expireAfterSeconds === 0));
assert(CallVoipPushAttempt.schema.path('providerRequestId'));
for (const field of ['clientDeliveredAt', 'openedAt', 'clickedAt']) {
  assert(CallVoipPushAttempt.schema.path(field), `CallVoipPushAttempt.${field} must capture client acknowledgement`);
}

for (const contract of [
  "status: 'ringing'",
  "status: 'accepted'",
  "status: 'declined'",
  "status: 'missed'",
  "status: endingFromRinging ? 'cancelled' : 'ended'",
  'expiresAt: { $gt: now }',
  'MAX_CALL_DURATION_SECONDS',
  'acceptedInstallationId',
  'activeUntil',
  'participantLeaseActive: true',
  'dispatchCallStatePushes',
  'recoverCallStatePushes',
  'callStatePushMarker',
  'startCallSessionSweeper',
  'stopCallSessionSweeper'
]) assert(service.includes(contract), `Missing durable call contract: ${contract}`);

// Amazon DocumentDB does not support aggregation-pipeline updates (an update
// passed as an array, or update expressions such as $cond). Every call-session
// state transition must therefore use plain update operators.
assert(!service.includes('$cond'), 'DocumentDB rejects pipeline updates; call transitions must use plain $set (no $cond)');
assert(service.includes("actor !== callerId && actor !== calleeId"), 'actions must be participant-scoped');
assert(service.includes("actor !== calleeId"), 'accept/decline must be callee-scoped');
assert(!service.includes("require('./apnsVoipPushService')"), 'call-state cleanup must not use PushKit-only transport');
assert(controller.includes("emit('call-session-updated'"), 'REST actions must reconcile every device');
assert(controller.includes("emit('call-accept'"), 'REST accept must wake the Web caller so it creates the offer');
assert(controller.includes("'call_accept_forwarded'"), 'REST accept must expose timestamped signaling diagnostics');
assert(routes.includes("router.get('/sessions/pending'"));
assert(routes.includes("router.post('/sessions/:callId/accept'"));
assert(routes.includes("router.post('/sessions/:callId/decline'"));
assert(socket.includes('callSessionService.createCallSession'));
assert(socket.includes('callSessionService.transitionCallSession'));
assert(socket.includes('"signal_forwarded"'), 'Socket signaling forwarding must expose diagnostics');
assert(socket.includes('nativeCallId: durableSession.nativeCallId'));
assert(socket.includes('endAcceptedCallSessionsForUser'), 'disconnect cleanup must only release accepted calls');
assert(socket.includes('fetchSockets()'), 'disconnect cleanup must preserve calls owned by another user socket');
assert(!socket.includes('endLiveCallSessionsForUser'), 'disconnect cleanup must not terminate native-push ringing calls');
const acceptedDisconnectCleanup = service.slice(
  service.indexOf('const endAcceptedCallSessionsForUser'),
  service.indexOf('const recoverCallStatePushes')
);
assert(acceptedDisconnectCleanup.includes("status: 'accepted'"));
assert(!acceptedDisconnectCleanup.includes("status: 'ringing'"));
const groupCallRequestHandler = socket.slice(
  socket.indexOf('socket.on("group-call-request"'),
  socket.indexOf('socket.on("group-call-join"')
);
assert(groupCallRequestHandler.includes('socket.emit("group-call-joined"'), 'group initiator must receive its media-start acknowledgement');
assert(socket.includes('(error as { code?: unknown })?.code'), 'socket call creation must preserve busy/conflict error codes');
assert(!socketBootstrap.includes('registerCallSocketHandlers'), 'unsafe target-ID call relay must not be mounted beside durable signaling');
assert(socketBootstrap.includes('registerLegacySocketHandlers'));
assert(push.includes('nativeCallId: sanitizeString(customData.nativeCallId)'));
assert(server.includes('callSessionService?.startCallSessionSweeper?.()'));
assert(server.includes('callSessionService?.stopCallSessionSweeper?.()'));
for (const contract of [
  "'apns-push-type': 'voip'",
  "'apns-priority': '10'",
  "'apns-expiration': '0'",
  "'apns-id': providerRequestId",
  "dsaEncoding: 'ieee-p1363'",
  "PERMANENT_TOKEN_ERRORS",
  'invalidateVoipTokensByHash',
  'nextAttemptAt',
  'enqueueTerminalIncomingFallback',
  'sendVoipCallStatePush',
  'dispatchInitialVoipPush',
  'recoverInitialVoipPushes',
  'recoverInterruptedVoipRequests',
  'terminalizeExhaustedVoipAttempts',
  'APNS_REQUEST_RECOVERY_EXHAUSTED',
  'call_state_update',
  "status: 'sending', leaseAt: new Date(), leaseKey: randomUUID(), retryable: true",
  'startApnsVoipPushSweeper'
]) assert(apnsService.includes(contract), `Missing APNs VoIP contract: ${contract}`);
assert(notificationsRoutes.includes('router.post("/voip-token"'));
assert(notificationsRoutes.includes('router.delete("/voip-token"'));
assert(notificationsRoutes.includes('CallVoipPushAttempt.updateOne('), 'direct PushKit delivery/open actions must update the VoIP ledger');
assert(server.includes('apnsVoipPushService?.startApnsVoipPushSweeper?.()'));
assert(server.includes('apnsVoipPushService?.stopApnsVoipPushSweeper?.()'));
assert(apnsService.includes('pushkit_state_updates_disabled'));
assert(!apnsService.includes('apns_voip_state'), 'PushKit must be reserved for real incoming calls reported to CallKit');
assert(apnsService.includes('pushDeliveryAttemptId: String(attempt._id)'), 'PushKit payloads must preserve delivery/open attribution');
assert(socket.includes('dispatchInitialVoipPush(durableSession)'), 'ringing APNs handoff must claim the durable CallSession outbox');
assert(migration.includes('...statePushMarker()'), 'migration-created terminal calls must enqueue multi-device state cleanup');
assert(callController.includes("participantId does not match the durable call session"));
assert(!callController.includes('Ending legacy call without durable session'));
assert(callController.includes("'callSummary.callId': durableSession.callId"));
for (const canonicalEvent of ["'call-request'", "'call-accept'", "'call-reject'", "'call-end'"]) {
  assert(callController.includes(`emit(${canonicalEvent}`), `legacy REST calls must bridge ${canonicalEvent}`);
}
assert(callController.includes("emit('call-session-updated'"), 'legacy REST transitions must reconcile every device');
assert(service.includes("emitTerminalCallSession(session, 'timeout')"), 'ring timeout must end the Web call UI');
assert(service.includes("emitTerminalCallSession(session, 'max_duration')"), 'max duration must end the Web call UI');

console.log('Durable call-session contracts passed');
