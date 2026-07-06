import assert from "node:assert/strict";

import {
  buildIncomingCallNotification,
  releaseDisconnectedUserCallSessions
} from "./legacy.socket";

const now = new Date("2026-07-02T12:00:00.000Z");
const notification = buildIncomingCallNotification({
  callId: "call-123",
  callType: "video",
  callerId: "507f1f77bcf86cd799439011",
  callerName: "Arc Player",
  nativeCallId: "89d4a55d-3e3c-4d11-89cb-8df7b4df775b",
  randomRoomId: "random-456",
  now
});

assert.equal(notification.type, "call");
assert.equal(notification.title, "Arc Player is calling");
assert.equal(notification.message, "Incoming video call");
assert.equal(notification.data.deepLink, "/conversation/direct_507f1f77bcf86cd799439011");
assert.deepEqual(notification.data.customData, {
  eventType: "incoming_call",
  callId: "call-123",
  nativeCallId: "89d4a55d-3e3c-4d11-89cb-8df7b4df775b",
  notificationDedupeKey: "incoming-call:call-123",
  pushRequestId: "incoming-call:call-123",
  roomId: "call-123",
  callType: "video",
  callerId: "507f1f77bcf86cd799439011",
  callerName: "Arc Player",
  deadlineAt: "2026-07-02T12:00:30.000Z",
  expiresAt: "2026-07-02T12:00:30.000Z",
  randomRoomId: "random-456",
  url: "/conversation/direct_507f1f77bcf86cd799439011",
  pushOptions: {
    ttl: 30,
    priority: "high",
    collapseKey: "incoming-call-call-123"
  }
});

const voiceNotification = buildIncomingCallNotification({
  callId: "voice-1",
  callType: "voice",
  callerId: "507f191e810c19729de860ea",
  callerName: "",
  now
});
assert.equal(voiceNotification.title, "Someone is calling");
assert.equal(voiceNotification.message, "Incoming voice call");
assert.equal("randomRoomId" in voiceNotification.data.customData, false);

const disconnectSession = {
  callId: "call-disconnect-123",
  nativeCallId: "native-disconnect-123",
  caller: "507f1f77bcf86cd799439011",
  callee: "507f191e810c19729de860ea",
  callType: "voice" as const,
  expiresAt: new Date("2026-07-02T12:01:00.000Z"),
  status: "ended"
};

const createDisconnectIo = (remainingSocketCount: number) => {
  const emissions: Array<{ room: string; event: string; payload: unknown }> = [];
  return {
    emissions,
    io: {
      in: () => ({
        fetchSockets: async () => Array.from({ length: remainingSocketCount }, () => ({}))
      }),
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => emissions.push({ room, event, payload })
      })
    }
  };
};

const runDisconnectTests = async () => {
  // A tab or installation disconnect must not tear down a call while another
  // authenticated socket for the same user remains online.
  const { io, emissions } = createDisconnectIo(1);
  let releaseCount = 0;
  const ended = await releaseDisconnectedUserCallSessions(io as never, String(disconnectSession.caller), {
    endAcceptedCallSessionsForUser: async () => {
      releaseCount += 1;
      return [disconnectSession];
    }
  } as never);
  assert.deepEqual(ended, []);
  assert.equal(releaseCount, 0);
  assert.deepEqual(emissions, []);

  // Ringing calls intentionally have no accepted-session release method:
  // native CallKit / push acceptance remains possible with zero sockets.
  const { io: ringingIo } = createDisconnectIo(0);
  const ringingSession = { ...disconnectSession, status: "ringing" };
  let unsafeLiveReleaseCount = 0;
  const ringingEnded = await releaseDisconnectedUserCallSessions(ringingIo as never, String(disconnectSession.callee), {
    endLiveCallSessionsForUser: async () => {
      unsafeLiveReleaseCount += 1;
      return [ringingSession];
    }
  } as never);
  assert.deepEqual(ringingEnded, []);
  assert.equal(unsafeLiveReleaseCount, 0);

  // With no reconnecting socket, an accepted call is released and the peer
  // gets the canonical event understood by both clients.
  const { io: acceptedIo, emissions: acceptedEmissions } = createDisconnectIo(0);
  const acceptedEnded = await releaseDisconnectedUserCallSessions(acceptedIo as never, String(disconnectSession.caller), {
    endAcceptedCallSessionsForUser: async () => [disconnectSession]
  } as never);
  assert.deepEqual(acceptedEnded, [disconnectSession]);
  assert.equal(acceptedEmissions.length, 1);
  assert.equal(acceptedEmissions[0]?.room, `user-${disconnectSession.callee}`);
  assert.equal(acceptedEmissions[0]?.event, "call-end");
  assert.deepEqual(acceptedEmissions[0]?.payload, {
    callId: disconnectSession.callId,
    nativeCallId: disconnectSession.nativeCallId,
    fromUserId: disconnectSession.caller,
    reason: "peer_disconnected"
  });
};

runDisconnectTests()
  .then(() => console.log("Legacy incoming-call notification and disconnect contract tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
