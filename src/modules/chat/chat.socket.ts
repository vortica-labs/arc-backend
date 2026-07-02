import type { Server, Socket } from "socket.io";
import path from "path";
import { chatService } from "./chat.service";
import { backendModelPath, backendRootPath } from "../legacy/legacy.paths";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacyMessageModels = require(path.join(backendModelPath, "Message.js")) as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const User = require(path.join(backendModelPath, "User.js")) as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Follow = require(path.join(backendModelPath, "Follow.js")) as any;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizePrivacySettings, buildPrivacyAccess } = require(
  path.join(backendRootPath, "utils", "privacyPolicy.js")
) as any;

const LegacyChatRoom = legacyMessageModels.ChatRoom;
const LegacyMessage = legacyMessageModels.Message;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const TYPING_THROTTLE_MS = 300;

type ChatAccess = {
  kind: "modular" | "legacy";
  participantIds: string[];
};

type MessageEventPayload = {
  chatId?: unknown;
  text?: unknown;
};

type TypingEventPayload = {
  chatId?: unknown;
};

const idString = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id?: unknown })._id || "");
  }
  return String(value || "");
};

const hasId = (values: unknown, expected: string): boolean => (
  Array.isArray(values) && values.some((value) => idString(value) === expected)
);

/**
 * Resolve the room namespace and current participants from the database. A
 * modular Chat and a legacy ChatRoom can theoretically share the same ObjectId,
 * so their Socket.IO rooms must never share a namespace.
 */
const resolveChatAccess = async (chatRoomId: string, userId: string): Promise<ChatAccess> => {
  if (!OBJECT_ID_PATTERN.test(chatRoomId)) throw new Error("CHAT_ACCESS_DENIED");

  const modularChat = await chatService.resolveParticipant(chatRoomId, userId);
  if (modularChat) {
    await chatService.assertRealtimeParticipant(chatRoomId, userId);
    return {
      kind: "modular",
      participantIds: (modularChat.participantIds || []).map(String)
    };
  }

  const legacyChat = await LegacyChatRoom.findOne({
    _id: chatRoomId,
    isActive: true,
    $or: [
      { creator: userId },
      { "members.user": userId }
    ]
  }).select("creator members.user").lean();
  if (!legacyChat) throw new Error("CHAT_ACCESS_DENIED");

  return {
    kind: "legacy",
    participantIds: [...new Set([
      idString(legacyChat.creator),
      ...(legacyChat.members || []).map((member: { user?: unknown }) => idString(member.user))
    ].filter(Boolean))]
  };
};

const directTypingParticipants = async (chatId: string, actorId: string): Promise<string[]> => {
  if (!chatId.startsWith("direct_")) return [];
  const otherUserId = chatId.slice("direct_".length);
  if (!OBJECT_ID_PATTERN.test(otherUserId) || otherUserId === actorId) return [];
  const exists = await LegacyMessage.exists({
    messageType: "direct",
    isDeleted: false,
    $or: [
      { sender: actorId, recipient: otherUserId },
      { sender: otherUserId, recipient: actorId }
    ]
  });
  return exists ? [otherUserId] : [];
};

const emitAuthorizedTypingState = async (
  io: Server,
  actorId: string,
  payload: TypingEventPayload,
  isTyping: boolean
): Promise<void> => {
  const chatId = typeof payload?.chatId === "string" ? payload.chatId.trim() : "";
  if (!chatId || chatId.length > 160) return;

  let participantIds = await directTypingParticipants(chatId, actorId);
  if (participantIds.length === 0 && !chatId.startsWith("direct_")) {
    const access = await resolveChatAccess(chatId, actorId);
    participantIds = access.participantIds.filter((participantId) => participantId !== actorId);
  }
  if (participantIds.length === 0) return;

  const actor = await User.findOne({ _id: actorId, isActive: true })
    .select("_id userType privacySettings blockedUsers isActive")
    .lean();
  if (!actor || !normalizePrivacySettings(actor.privacySettings).showOnlineStatus) return;

  const recipients = await User.find({ _id: { $in: participantIds }, isActive: true })
    .select("_id userType blockedUsers isActive")
    .lean();
  const recipientIds = recipients.map((recipient: any) => idString(recipient));
  const followerIds = new Set((await Follow.find({
    follower: { $in: recipientIds },
    following: actorId
  }).distinct("follower")).map(String));

  for (const recipient of recipients) {
    const recipientId = idString(recipient);
    const blocked = hasId(actor.blockedUsers, recipientId) || hasId(recipient.blockedUsers, actorId);
    const access = buildPrivacyAccess({
      settings: actor.privacySettings,
      isFollower: followerIds.has(recipientId),
      existingConversation: true,
      blocked
    });
    if (!access.canSeeOnlineStatus) continue;
    io.to(`user-${recipientId}`).emit(isTyping ? "user-typing" : "user-stopped-typing", {
      chatId,
      userId: actorId
    });
  }
};

export const registerChatSocketHandlers = (io: Server, socket: Socket): void => {
  let lastTypingStartAt = 0;

  socket.on("join-chat-room", async (chatRoomId: unknown) => {
    const userId = socket.authUser?.userId;
    const normalizedChatRoomId = typeof chatRoomId === "string" ? chatRoomId.trim() : "";
    if (!normalizedChatRoomId || !userId) return;
    try {
      const access = await resolveChatAccess(normalizedChatRoomId, userId);
      const room = access.kind === "modular"
        ? `modular-chat-${normalizedChatRoomId}`
        : `chat-${normalizedChatRoomId}`;
      await socket.join(room);
    } catch (_error) {
      socket.emit("chat:error", { code: "CHAT_ACCESS_DENIED", message: "Chat not found or access denied" });
    }
  });

  socket.on("leave-chat-room", async (chatRoomId: unknown) => {
    if (chatRoomId === "all") {
      await Promise.all([...socket.rooms]
        .filter((room) => room.startsWith("chat-") || room.startsWith("modular-chat-"))
        .map((room) => socket.leave(room)));
      return;
    }

    if (typeof chatRoomId === "string" && chatRoomId.trim()) {
      await Promise.all([
        socket.leave(`chat-${chatRoomId.trim()}`),
        socket.leave(`modular-chat-${chatRoomId.trim()}`)
      ]);
    }
  });

  socket.on("send-message", async (payload: MessageEventPayload) => {
    try {
      const userId = socket.authUser?.userId;
      const chatId = typeof payload?.chatId === "string" ? payload.chatId.trim() : "";
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!userId || !OBJECT_ID_PATTERN.test(chatId) || !text || text.length > 1000) {
        socket.emit("chat:error", { code: "INVALID_MESSAGE", message: "Invalid message" });
        return;
      }

      const message = await chatService.postMessage({ chatId, senderId: userId, text });
      io.to(`modular-chat-${chatId}`).emit("newMessage", { chatId, message });
    } catch (_error) {
      socket.emit("chat:error", { code: "CHAT_ACCESS_DENIED", message: "Chat not found or access denied" });
    }
  });

  const handleTyping = async (payload: TypingEventPayload, isTyping: boolean) => {
    const userId = socket.authUser?.userId;
    if (!userId) return;
    const now = Date.now();
    if (isTyping && now - lastTypingStartAt < TYPING_THROTTLE_MS) return;
    if (isTyping) lastTypingStartAt = now;
    try {
      await emitAuthorizedTypingState(io, userId, payload, isTyping);
    } catch (_error) {
      // Typing is ephemeral. Fail closed without exposing room/user existence.
    }
  };

  socket.on("typing-start", (payload: TypingEventPayload) => void handleTyping(payload, true));
  socket.on("typing-stop", (payload: TypingEventPayload) => void handleTyping(payload, false));
};
