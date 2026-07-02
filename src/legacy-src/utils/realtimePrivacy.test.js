const assert = require('assert');
const { revokeChatRoomAccess, disconnectUserSockets } = require('./realtimePrivacy');

const calls = [];
const socket = {
  data: {
    groupCallChats: {
      'call-in-revoked-chat': 'chat-1',
      'call-in-other-chat': 'chat-2'
    }
  },
  async leave(room) {
    calls.push({ action: 'socket.leave', room });
  }
};
const io = {
  to(room) {
    return {
      emit(event, payload) {
        calls.push({ action: 'emit', room, event, payload });
      }
    };
  },
  in(room) {
    return {
      socketsLeave(targetRoom) {
        calls.push({ action: 'socketsLeave', room, targetRoom });
      },
      async fetchSockets() {
        calls.push({ action: 'fetchSockets', room });
        return [socket];
      },
      async disconnectSockets(close) {
        calls.push({ action: 'disconnectSockets', room, close });
      }
    };
  }
};

(async () => {
  await revokeChatRoomAccess(io, 'chat-1', 'user-1', 'removed_by_admin');
  assert.deepStrictEqual(calls[0], {
    action: 'emit',
    room: 'user-user-1',
    event: 'chat-access-revoked',
    payload: { chatRoomId: 'chat-1', reason: 'removed_by_admin' }
  });
  assert(calls.some((call) => call.action === 'socketsLeave' && call.targetRoom === 'chat-chat-1'));
  assert(calls.some((call) => call.action === 'socket.leave' && call.room === 'call-call-in-revoked-chat'));
  assert(!calls.some((call) => call.action === 'socket.leave' && call.room === 'call-call-in-other-chat'));

  calls.length = 0;
  await disconnectUserSockets(io, 'user-2', 'account_suspended');
  assert.deepStrictEqual(calls, [
    {
      action: 'emit',
      room: 'user-user-2',
      event: 'session-revoked',
      payload: { reason: 'account_suspended' }
    },
    {
      action: 'disconnectSockets',
      room: 'user-user-2',
      close: true
    }
  ]);

  console.log('realtime privacy room-revocation tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
