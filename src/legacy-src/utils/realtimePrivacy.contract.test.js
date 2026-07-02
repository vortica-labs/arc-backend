const assert = require('assert');
const fs = require('fs');
const path = require('path');

const legacyRoot = path.resolve(__dirname, '..');
const readLegacy = (relative) => fs.readFileSync(path.join(legacyRoot, relative), 'utf8');
const readModule = (relative) => fs.readFileSync(path.resolve(legacyRoot, '../modules', relative), 'utf8');

const message = readLegacy('controllers/messageController.js');
const call = readLegacy('controllers/callController.js');
const auth = readLegacy('controllers/authController.js');
const admin = readLegacy('controllers/adminController.js');
const callPrivacy = readLegacy('utils/callPrivacy.js');
const chatSocket = readModule('chat/chat.socket.ts');
const chatService = readModule('chat/chat.service.ts');
const legacySocket = readModule('legacy/legacy.socket.ts');
const presenceSocket = readModule('presence/presence.socket.ts');
const deprecatedCallSocket = readModule('calls/calls.socket.ts');

assert(chatSocket.includes('socket.on("typing-start"'));
assert(chatSocket.includes('socket.on("typing-stop"'));
assert(chatSocket.includes('normalizePrivacySettings(actor.privacySettings).showOnlineStatus'));
assert(chatSocket.includes('access.canSeeOnlineStatus'));
assert(chatSocket.includes('modular-chat-${normalizedChatRoomId}'));
assert(chatSocket.includes('LegacyMessage.exists'));
assert(chatService.includes('assertRealtimeParticipant'));
assert(chatService.includes('existingConversation: true'));
assert(chatService.includes('relationship.blocked'));
assert(chatService.includes('User.findOne({ _id: targetId, isActive: true })'));

assert(message.includes('redactMessageReadReceipts'));
assert(message.includes('relationship.access.canSeeOnlineStatus'));
assert(message.includes('getGroupMembershipWindow'));
assert(message.includes('groupHistoryBoundary(membershipWindow)'));
assert(message.includes('canReadGroupMessageAt'));
assert(message.includes('Keep prior membership epochs'));
assert(message.includes("await revokeChatRoomAccess(io, chatRoom._id, memberId, 'removed_by_admin')"));
assert(message.includes("await revokeChatRoomAccess(io, chatRoomId, userId, 'left_group')"));
assert(message.includes('getCallSessionForParticipant(callId, senderId)'));
assert(message.includes("code: 'CALL_SUMMARY_ACCESS_DENIED'"));
assert(message.includes('Reply target is not part of this conversation'));
assert(message.includes('Reply target is not part of this chat room'));
assert(message.includes('Follow.isFollowing(user._id, userId)'));
assert(message.includes("chatRoom.settings?.allowInvites === false"));
assert(message.includes(".select('name avatar members.user settings.allowInvites settings.maxMembers')"));
assert(!message.includes(".select('username privacySettings following')"));

assert(call.includes('await assertCallSessionPrivacy(callSession)'));
assert(call.includes('await assertCallSessionPrivacy(durableSession)'));
assert(call.includes("'members.user': userId"));
assert(call.includes("code: 'GROUP_CALL_ACCESS_DENIED'"));
assert(callPrivacy.includes('relationship.blocked'));
assert(legacySocket.includes('await callPrivacy.assertCallSessionPrivacy(session)'));
assert(legacySocket.includes('isAuthorizedLegacyChatMember(session.chatRoomId, targetUserId)'));
assert(legacySocket.includes('Buffer.byteLength(serializedSignal, "utf8") > 64 * 1024'));
assert(!deprecatedCallSocket.includes('payload.targetUserId'));
assert(!deprecatedCallSocket.includes('payload.callerId'));

assert(auth.includes("disconnectUserSockets(global._arcSocketIO, userId, 'account_deleted')"));
assert(admin.includes("disconnectUserSockets(global._arcSocketIO, userId, 'account_suspended')"));
assert(presenceSocket.includes('presence cannot be used as an account'));
assert(presenceSocket.includes('snapshots.push({ userId: targetId, isOnline: false, lastSeen: null, hidden: true })'));

console.log('realtime privacy enforcement contract tests passed');
