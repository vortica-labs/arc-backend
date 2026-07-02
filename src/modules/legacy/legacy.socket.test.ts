import assert from "node:assert/strict";

import { buildIncomingCallNotification } from "./legacy.socket";

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

console.log("Legacy incoming-call notification contract tests passed");
