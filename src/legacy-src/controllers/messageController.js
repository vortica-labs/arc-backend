const { Message, ChatRoom } = require('../models/Message');
const User = require('../models/User');
const Post = require('../models/Post');
const Notification = require('../models/Notification');
const { uploadMultipleFiles } = require('../utils/cloudinary');
const { createMessageNotification } = require('../utils/notificationService');
const log = require('../utils/logger');

// Get io instance from server
let io;
const setIoInstance = (ioInstance) => {
  io = ioInstance;
};

const sharedPostSelect = 'content.text content.media author likes comments shares createdAt postType';
const sharedPostAuthorSelect = 'username profile.displayName profile.avatar profilePicture avatar profileImage avatarUrl userType role';

const getMessageKind = ({ media = [], sharedPost, sharedProfile, replyTo, forwardedFrom, invite }) => {
  if (invite) return 'invite';
  if (sharedPost) return 'shared_post';
  if (sharedProfile) return 'shared_profile';
  if (forwardedFrom) return 'forwarded';
  if (replyTo) return 'reply';
  if (media.length > 0) return 'media';
  return 'text';
};

function formatActivityStatus(lastSeen, showActivityStatus) {
  if (!showActivityStatus || !lastSeen) return null;
  const diffMs = Date.now() - new Date(lastSeen).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 5) return 'Active now';
  if (diffMin < 60) return `Active ${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `Active ${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `Active ${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
}

// Send direct message
const sendDirectMessage = async (req, res) => {
  try {
    let { recipientId, recipientUsername, text, replyTo, replyToId, forwardedFrom, sharedPostId, sharedPostCaption, sharedProfileUsername } = req.body || {};
    replyTo = replyTo || replyToId;
    text = text != null ? String(text) : '';
    sharedPostId = sharedPostId != null ? (typeof sharedPostId === 'string' ? sharedPostId.trim() : String(sharedPostId)) : null;
    sharedProfileUsername = sharedProfileUsername != null && typeof sharedProfileUsername === 'string' ? sharedProfileUsername.trim() : null;
    const senderId = req.user._id;

    // Resolve recipient by username (preferred) or by id
    let recipient;
    if (recipientUsername && typeof recipientUsername === 'string' && recipientUsername.trim()) {
      recipient = await User.findOne({ username: recipientUsername.trim(), isActive: true }).select('+privacySettings +following username isActive');
    } else if (recipientId) {
      const id = typeof recipientId === 'string' ? recipientId.replace(/^direct_/, '').trim() : String(recipientId);
      if (id) recipient = await User.findById(id).select('+privacySettings +following username isActive');
    }
    if (!recipientId && !recipientUsername) {
      return res.status(400).json({ success: false, message: 'Recipient (username or id) is required' });
    }
    if (!recipient || !recipient.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Recipient not found'
      });
    }
    const recipientIdResolved = recipient._id.toString();
    if (senderId.toString() === recipientIdResolved) {
      return res.status(400).json({
        success: false,
        message: 'You cannot send message to yourself'
      });
    }

    // DM privacy check: whoCanMessage
    // Skip if recipient already initiated the conversation (sent a message to sender first)
    const recipientPrivacy = recipient.privacySettings?.whoCanMessage || 'anyone';
    if (recipientPrivacy !== 'anyone') {
      const recipientInitiated = await Message.exists({
        messageType: 'direct',
        sender: recipientIdResolved,
        recipient: senderId,
        isDeleted: false
      });
      if (!recipientInitiated) {
        if (recipientPrivacy === 'nobody') {
          return res.status(403).json({ success: false, reason: 'dm_privacy_blocked', targetUsername: recipient.username });
        }
        if (recipientPrivacy === 'people_you_follow') {
          const recipientWithFollowing = await User.findById(recipientIdResolved).select('following');
          const recipientFollowsSender = recipientWithFollowing.following && recipientWithFollowing.following.some(
            id => id.toString() === senderId.toString()
          );
          if (!recipientFollowsSender) {
            return res.status(403).json({ success: false, reason: 'dm_privacy_blocked', targetUsername: recipient.username });
          }
        }
      }
    }

    // Handle shared post (rich preview in DM)
    let sharedPostObj = null;
    if (sharedPostId) {
      const post = await Post.findById(sharedPostId).select('_id author content').lean();
      if (!post) {
        return res.status(400).json({ success: false, message: 'Post not found' });
      }
      sharedPostObj = sharedPostId;
    }

    // Handle shared profile (rich preview in DM)
    let sharedProfileObj = null;
    if (sharedProfileUsername) {
      const profileUser = await User.findOne({ username: sharedProfileUsername, isActive: true }).select('_id username profile.displayName profile.avatar profile.bio').lean();
      if (!profileUser) {
        return res.status(400).json({ success: false, message: 'Profile not found' });
      }
      sharedProfileObj = profileUser._id;
    }

    // Handle forwarded messages - get original message content
    let messageText = text || '';
    let mediaData = [];
    
    if (forwardedFrom) {
      // Get the original message
      const originalMessage = await Message.findById(forwardedFrom).populate('sender', 'username profile.displayName profile.avatar');
      if (originalMessage) {
        // Use original message content
        messageText = typeof originalMessage.content === 'string' 
          ? originalMessage.content 
          : (originalMessage.content?.text || '');
        mediaData = originalMessage.content?.media || [];
      }
    } else {
      // Handle media uploads for new messages
      if (req.files && req.files.length > 0) {
        try {
          const uploadResults = await uploadMultipleFiles(req.files, 'gaming-social/messages');
          mediaData = uploadResults.map(result => ({
            type: result.type,
            url: result.url,
            publicId: result.publicId,
            filename: req.files.find(f => f.originalname).originalname,
            size: req.files.find(f => f.size).size
          }));
        } catch (uploadError) {
          return res.status(400).json({
            success: false,
            message: 'Failed to upload media files',
            error: uploadError.message
          });
        }
      }
    }

    // For shared post: keep a schema-safe label without leaking raw post URLs into chat.
    if (sharedPostObj && !messageText.trim()) {
      messageText = 'Shared a post';
    }
    // Ensure content.text is never empty when we have shared post (schema requires text if no media)
    if (sharedPostObj && !(messageText && messageText.trim())) {
      messageText = `Shared a post`;
    }
    // For shared profile: default text
    if (sharedProfileObj && !messageText.trim()) {
      messageText = 'Shared a profile';
    }

    const defaultText = sharedProfileObj ? 'Shared a profile' : (sharedPostObj ? 'Shared a post' : messageText);
    const messageData = {
      sender: senderId,
      recipient: recipientIdResolved,
      messageType: 'direct',
      content: {
        text: (sharedPostCaption && sharedPostCaption.trim()) ? sharedPostCaption.trim() : (messageText || defaultText),
        media: mediaData
      }
    };

    if (replyTo) {
      messageData.replyTo = replyTo;
    }

    if (forwardedFrom) {
      messageData.forwardedFrom = forwardedFrom;
    }

    if (sharedPostObj) {
      messageData.sharedPost = sharedPostObj;
      if (sharedPostCaption && sharedPostCaption.trim()) {
        messageData.sharedPostCaption = sharedPostCaption.trim();
      }
    }
    if (sharedProfileObj) {
      messageData.sharedProfile = sharedProfileObj;
    }

    const message = await Message.create(messageData);
    
    // Populate sender, recipient, sharedPost for rich preview
    await message.populate([
      { path: 'sender', select: 'username profile.displayName profile.avatar' },
      { path: 'recipient', select: 'username profile.displayName profile.avatar' },
      { path: 'replyTo', select: 'content.text sender', populate: { path: 'sender', select: 'username profile.displayName' } },
      { path: 'forwardedFrom', select: 'content.text content.media sender', populate: { path: 'sender', select: 'username profile.displayName profile.avatar' } },
      { path: 'sharedPost', select: sharedPostSelect, populate: { path: 'author', select: sharedPostAuthorSelect } },
      { path: 'sharedProfile', select: 'username profile.displayName profile.avatar profile.bio' }
    ]);

    // Plain object so nested populated (e.g. sharedPost.author) serializes correctly in JSON/socket
    const messagePojo = message.toObject ? message.toObject() : message;

    // Emit the chat event immediately. Socket connectivity is transport
    // presence, not proof that a particular conversation is visible on any
    // device, so notification delivery must not be suppressed by this room.
    if (io) {
      io.to(`user-${recipientIdResolved}`).emit('newMessage', {
        chatId: `direct_${senderId}`,
        message: messagePojo
      });
      if (process.env.NODE_ENV === 'development') { console.log('Real-time message emitted successfully');}
    } else {
      if (process.env.NODE_ENV === 'development') { console.log('Socket.io not available for real-time messaging');}
    }

    // Always create/update the durable notification. Active-conversation push
    // suppression must be installation-scoped; a process-local Socket.IO room
    // cannot distinguish foreground chat, background app, or another device.
    await createMessageNotification(recipientIdResolved, senderId, message._id, {
      conversationId: `direct_${senderId}`,
      chatId: `direct_${senderId}`,
      muteKey: senderId,
      messageKind: getMessageKind({ media: mediaData, sharedPost: sharedPostObj, sharedProfile: sharedProfileObj, replyTo, forwardedFrom }),
      hasMedia: mediaData.length > 0,
      primaryMediaType: mediaData[0]?.type,
      deepLink: `/conversation/direct_${senderId}`
    });

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: {
        message: messagePojo
      }
    });

  } catch (error) {
    log.error('sendDirectMessage error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get direct messages between two users
const getDirectMessages = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    // Return deep history by default so old messages remain visible in chat.
    // A hard cap is kept to prevent unbounded payloads.
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 1000)
      : 1000;
    const skip = (page - 1) * limit;

    const messages = await Message.find({
      messageType: 'direct',
      deletedForEveryone: { $ne: true },
      $or: [
        { sender: currentUserId, recipient: userId },
        { sender: userId, recipient: currentUserId }
      ],
      $and: [
        {
          $or: [
            { deletedForUsers: { $exists: false } },
            { deletedForUsers: { $size: 0 } },
            { deletedForUsers: { $not: { $elemMatch: { user: currentUserId } } } }
          ]
        }
      ]
    })
    
    .populate('sender', 'username profile.displayName profile.avatar')
    .populate('recipient', 'username profile.displayName profile.avatar')
    .populate({ path: 'replyTo', select: 'content.text content.media sender', populate: { path: 'sender', select: 'username profile.displayName profile.avatar' } })
    .populate('forwardedFrom', 'content.text content.media sender')
    .populate('forwardedFrom.sender', 'username profile.displayName profile.avatar')
    .populate('sharedPost', sharedPostSelect)
    .populate('sharedPost.author', sharedPostAuthorSelect)
    .populate('sharedProfile', 'username profile.displayName profile.avatar profile.bio')
    .populate('reactions.user', 'username profile.displayName')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

    const total = await Message.countDocuments({
      messageType: 'direct',
      deletedForEveryone: { $ne: true },
      $or: [
        { sender: currentUserId, recipient: userId },
        { sender: userId, recipient: currentUserId }
      ],
      $and: [
        {
          $or: [
            { deletedForUsers: { $exists: false } },
            { deletedForUsers: { $size: 0 } },
            { deletedForUsers: { $not: { $elemMatch: { user: currentUserId } } } }
          ]
        }
      ]
    });

    res.status(200).json({
      success: true,
      messages: messages.reverse(), // Reverse to show oldest first
      pagination: {
        current: page,
        total: Math.ceil(total / limit),
        count: messages.length,
        totalMessages: total
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch messages',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create chat room
const createChatRoom = async (req, res) => {
  try {
    const { name, description, memberIds } = req.body;
    const creatorId = req.user._id;

    // Validate members and check privacy settings
    // Members who pass privacy check get added; blocked ones are returned separately
    let allowedMemberIds = [];
    let blockedMembers = [];

    if (memberIds && memberIds.length > 0) {
      const validMembers = await User.find({ _id: { $in: memberIds }, isActive: true })
        .select('username privacySettings following');
      if (validMembers.length !== memberIds.length) {
        return res.status(400).json({
          success: false,
          message: 'Some members are invalid or inactive'
        });
      }

      for (const member of validMembers) {
        const privacy = member.privacySettings?.whoCanAddToGroup || 'anyone';
        let blocked = false;
        if (privacy === 'nobody') {
          blocked = true;
        } else if (privacy === 'people_you_follow') {
          const followsCreator = member.following &&
            member.following.some(id => id.toString() === creatorId.toString());
          if (!followsCreator) blocked = true;
        }
        if (blocked) {
          blockedMembers.push({ _id: member._id, username: member.username });
        } else {
          allowedMemberIds.push(member._id);
        }
      }
    }

    // Create chat room
    const chatRoomData = {
      name,
      description: description || '',
      roomType: 'private', // Default to private
      creator: creatorId,
      members: [
        { user: creatorId, role: 'admin' },
        ...allowedMemberIds.map(memberId => ({ user: memberId, role: 'member' }))
      ]
    };

    const chatRoom = await ChatRoom.create(chatRoomData);
    
    // Populate members info
    await chatRoom.populate('members.user', 'username profile.displayName profile.avatar');
    await chatRoom.populate('creator', 'username profile.displayName profile.avatar');

    // Transform to match frontend expectations
    const transformedChatRoom = {
      _id: chatRoom._id,
      name: chatRoom.name,
      description: chatRoom.description,
      avatar: chatRoom.avatar,
      roomType: chatRoom.roomType,
      creator: {
        _id: chatRoom.creator._id,
        username: chatRoom.creator.username || chatRoom.creator.profile?.displayName,
        profile: chatRoom.creator.profile
      },
      members: chatRoom.members.map(member => ({
        user: {
          _id: member.user._id,
          username: member.user.username || member.user.profile?.displayName,
          profile: member.user.profile
        },
        role: member.role,
        joinedAt: member.joinedAt
      })),
      memberCount: chatRoom.members.length,
      lastMessage: null,
      unreadCount: 0,
      lastActivity: chatRoom.lastActivity
    };

    res.status(201).json({
      success: true,
      message: 'Chat room created successfully',
      data: {
        chatRoom: transformedChatRoom,
        blockedMembers: blockedMembers.length > 0 ? blockedMembers : undefined
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create chat room',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get user's chat rooms
const getChatRooms = async (req, res) => {
  try {
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const chatRooms = await ChatRoom.find({
      $or: [
        { 'members.user': userId, isActive: true },
        { 'removedMembers.user': userId }
      ]
    })
    .populate('members.user', 'username profile.displayName profile.avatar')
    .populate('creator', 'username profile.displayName profile.avatar')
    .populate('lastMessage')
    .sort({ lastActivity: -1 })
    .skip(skip)
    .limit(limit);

    // Transform chat rooms to match frontend expectations
    const transformedChatRooms = await Promise.all(chatRooms.map(async (room) => {
      let lastVisibleMessage = room.lastMessage;
      const lastDeletedForUser = lastVisibleMessage?.deletedForUsers?.some?.(
        entry => entry.user && entry.user.toString() === userId.toString()
      );
      if (lastVisibleMessage?.deletedForEveryone || lastDeletedForUser) {
        lastVisibleMessage = await Message.findOne({
          chatRoom: room._id,
          messageType: 'group',
          deletedForEveryone: { $ne: true },
          $or: [
            { deletedForUsers: { $exists: false } },
            { deletedForUsers: { $size: 0 } },
            { deletedForUsers: { $not: { $elemMatch: { user: userId } } } }
          ]
        }).sort({ createdAt: -1 }).lean();
      }

      // Get unread count for this user (exclude messages sent by this user)
      const unreadCount = await Message.countDocuments({
        chatRoom: room._id,
        messageType: 'group',
        sender: { $ne: userId },
        'readBy.user': { $ne: userId },
        deletedForEveryone: { $ne: true },
        $or: [
          { deletedForUsers: { $exists: false } },
          { deletedForUsers: { $size: 0 } },
          { deletedForUsers: { $not: { $elemMatch: { user: userId } } } }
        ]
      });

      // Check if current user is mentioned in unread messages
      const isMentioned = await Message.exists({
        chatRoom: room._id,
        messageType: 'group',
        sender: { $ne: userId },
        'readBy.user': { $ne: userId },
        mentions: userId,
        deletedForEveryone: { $ne: true },
        $or: [
          { deletedForUsers: { $exists: false } },
          { deletedForUsers: { $size: 0 } },
          { deletedForUsers: { $not: { $elemMatch: { user: userId } } } }
        ]
      });
      
      return {
        _id: room._id,
        name: room.name,
        description: room.description,
        avatar: room.avatar,
        roomType: room.roomType,
        creator: {
          _id: room.creator._id,
          username: room.creator.username || room.creator.profile?.displayName,
          profile: room.creator.profile
        },
        members: room.members.map(member => ({
          user: {
            _id: member.user._id,
            username: member.user.username || member.user.profile?.displayName,
            profile: member.user.profile
          },
          role: member.role,
          joinedAt: member.joinedAt
        })),
        memberCount: room.members.length,
        lastMessage: lastVisibleMessage ? {
          content: lastVisibleMessage.content,
          sender: lastVisibleMessage.sender,
          createdAt: lastVisibleMessage.createdAt
        } : null,
        unreadCount,
        lastActivity: room.lastActivity,
        isMentioned: !!isMentioned,
        isRemoved: !room.members.some(m => m.user._id.toString() === userId.toString()),
        memberPermissions: room.memberPermissions || { editGroupSettings: true, sendMessages: true, addMembers: true }
      };
    }));

    // Sort by unread count first, then by last activity
    transformedChatRooms.sort((a, b) => {
      if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
      if (a.unreadCount === 0 && b.unreadCount > 0) return 1;
      return new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0);
    });

    const total = await ChatRoom.countDocuments({
      $or: [
        { 'members.user': userId, isActive: true },
        { 'removedMembers.user': userId }
      ]
    });

    res.status(200).json({
      success: true,
      chatRooms: transformedChatRooms,
      pagination: {
        current: page,
        total: Math.ceil(total / limit),
        count: transformedChatRooms.length,
        totalRooms: total
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch chat rooms',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get recent conversations (direct messages)
const getRecentConversations = async (req, res) => {
  try {
    const userId = req.user._id;
    const mongoose = require('mongoose');
    const userObjectId = mongoose.Types.ObjectId.isValid(userId)
      ? new mongoose.Types.ObjectId(userId)
      : userId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    // Prevent stale/empty inbox caused by cache revalidation on route changes.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    // Get all unique users the current user has had conversations with
    const conversations = await Message.aggregate([
      {
        $match: {
          messageType: 'direct',
          deletedForEveryone: { $ne: true },
          $and: [
            {
              $or: [
                { sender: userObjectId },
                { recipient: userObjectId }
              ]
            },
            {
              $or: [
                { deletedForUsers: { $exists: false } },
                { deletedForUsers: { $size: 0 } },
                { deletedForUsers: { $not: { $elemMatch: { user: userObjectId } } } }
              ]
            }
          ]
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$sender', userObjectId] },
              '$recipient',
              '$sender'
            ]
          },
          lastMessage: { $first: '$$ROOT' },
          messageCount: { $sum: 1 }
        }
      },
      {
        $sort: { 'lastMessage.createdAt': -1 }
      },
      {
        $skip: skip
      },
      {
        $limit: limit
      }
    ]);

    // Populate user information for each conversation
    const populatedConversations = await Promise.all(
      conversations.map(async (conv) => {
        const otherUser = await User.findById(conv._id)
          .select('username profile.displayName profile.avatar role userType lastSeen privacySettings.showActivityStatus')
          .lean();

        if (!otherUser) return null;

        // Get unread count
        const unreadCount = await Message.countDocuments({
          messageType: 'direct',
          sender: conv._id,
          recipient: userObjectId,
          'readBy.user': { $ne: userObjectId },
          deletedForEveryone: { $ne: true },
          $or: [
            { deletedForUsers: { $exists: false } },
            { deletedForUsers: { $size: 0 } },
            { deletedForUsers: { $not: { $elemMatch: { user: userObjectId } } } }
          ]
        });

        return {
          _id: `direct_${conv._id}`,
          participants: [{
            _id: otherUser._id,
            username: otherUser.username || otherUser.profile?.displayName,
            profilePicture: otherUser.profile?.avatar,
            role: otherUser.role || otherUser.userType,
            activityStatus: formatActivityStatus(otherUser.lastSeen, otherUser.privacySettings?.showActivityStatus ?? true)
          }],
          lastMessage: {
            content: conv.lastMessage.content,
            sender: conv.lastMessage.sender,
            createdAt: conv.lastMessage.createdAt
          },
          unreadCount,
          messageCount: conv.messageCount
        };
      })
    );

    // Filter out null entries (deleted users)
    const validConversations = populatedConversations.filter(conv => conv !== null);

    // Sort by unread count first, then by last message time
    validConversations.sort((a, b) => {
      if (a.unreadCount > 0 && b.unreadCount === 0) return -1;
      if (a.unreadCount === 0 && b.unreadCount > 0) return 1;
      return new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt);
    });

    const total = await Message.aggregate([
      {
        $match: {
          messageType: 'direct',
          deletedForEveryone: { $ne: true },
          $and: [
            {
              $or: [
                { sender: userObjectId },
                { recipient: userObjectId }
              ]
            },
            {
              $or: [
                { deletedForUsers: { $exists: false } },
                { deletedForUsers: { $size: 0 } },
                { deletedForUsers: { $not: { $elemMatch: { user: userObjectId } } } }
              ]
            }
          ]
        }
      },
      {
        $group: {
          _id: {
            $cond: [
              { $eq: ['$sender', userObjectId] },
              '$recipient',
              '$sender'
            ]
          }
        }
      },
      {
        $count: 'total'
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        conversations: validConversations,
        pagination: {
          current: page,
          total: Math.ceil((total[0]?.total || 0) / limit),
          count: validConversations.length,
          totalConversations: total[0]?.total || 0
        }
      }
    });

  } catch (error) {
    log.error('Error fetching recent conversations:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent conversations',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send group message
const sendGroupMessage = async (req, res) => {
  try {
    let { chatRoomId, text, replyTo, replyToId, forwardedFrom, sharedPostId, sharedPostCaption } = req.body;
    replyTo = replyTo || replyToId;
    text = text != null ? String(text) : '';
    sharedPostId = sharedPostId != null ? (typeof sharedPostId === 'string' ? sharedPostId.trim() : String(sharedPostId)) : null;
    const senderId = req.user._id;

    // Check if user is member of the chat room
    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom || !chatRoom.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Chat room not found'
      });
    }

    const isMember = chatRoom.members.some(member => member.user.toString() === senderId.toString());
    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'You are not a member of this chat room'
      });
    }

    // Check sendMessages permission — if disabled, only admins can send
    const isAdmin = chatRoom.members.some(m => m.user.toString() === senderId.toString() && m.role === 'admin');
    if (chatRoom.memberPermissions && chatRoom.memberPermissions.sendMessages === false && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can send messages in this group'
      });
    }

    // Handle forwarded messages - get original message content
    let messageText = text || '';
    let mediaData = [];
    let sharedPostObj = null;

    if (sharedPostId) {
      const post = await Post.findById(sharedPostId).select('_id author content').lean();
      if (!post) {
        return res.status(400).json({ success: false, message: 'Post not found' });
      }
      sharedPostObj = sharedPostId;
    }
    
    if (forwardedFrom) {
      // Get the original message
      const originalMessage = await Message.findById(forwardedFrom).populate('sender', 'username profile.displayName profile.avatar');
      if (originalMessage) {
        // Use original message content
        messageText = typeof originalMessage.content === 'string' 
          ? originalMessage.content 
          : (originalMessage.content?.text || '');
        mediaData = originalMessage.content?.media || [];
      }
    } else {
      // Handle media uploads for new messages
      if (req.files && req.files.length > 0) {
        try {
          const uploadResults = await uploadMultipleFiles(req.files, 'gaming-social/messages');
          mediaData = uploadResults.map(result => ({
            type: result.type,
            url: result.url,
            publicId: result.publicId
          }));
        } catch (uploadError) {
          return res.status(400).json({
            success: false,
            message: 'Failed to upload media files',
            error: uploadError.message
          });
        }
      }
    }

    if (sharedPostObj && !messageText.trim()) {
      messageText = 'Shared a post';
    }

    // Create message
    const messageData = {
      sender: senderId,
      chatRoom: chatRoomId,
      messageType: 'group',
      content: {
        text: (sharedPostCaption && sharedPostCaption.trim()) ? sharedPostCaption.trim() : messageText,
        media: mediaData
      }
    };

    if (replyTo) {
      messageData.replyTo = replyTo;
    }

    if (forwardedFrom) {
      messageData.forwardedFrom = forwardedFrom;
    }

    if (sharedPostObj) {
      messageData.sharedPost = sharedPostObj;
      if (sharedPostCaption && sharedPostCaption.trim()) {
        messageData.sharedPostCaption = sharedPostCaption.trim();
      }
    }

    // Parse @mentions from message text
    const mentionedUserIds = [];
    if (messageText) {
      const mentionRegex = /@(\w+)/g;
      let match;
      const mentionedUsernames = [];
      while ((match = mentionRegex.exec(messageText)) !== null) {
        mentionedUsernames.push(match[1]);
      }
      if (mentionedUsernames.length > 0) {
        // Only mention actual group members
        const memberUserIds = chatRoom.members.map(m => m.user.toString());
        const mentionedUsers = await User.find({
          username: { $in: mentionedUsernames },
          _id: { $in: memberUserIds }
        }).select('_id username');
        mentionedUsers.forEach(u => {
          if (u._id.toString() !== senderId.toString()) {
            mentionedUserIds.push(u._id);
          }
        });
      }
    }

    if (mentionedUserIds.length > 0) {
      messageData.mentions = mentionedUserIds;
    }

    const message = await Message.create(messageData);
    
    // Update chat room last message and activity
    chatRoom.lastMessage = message._id;
    chatRoom.lastActivity = new Date();
    await chatRoom.save();

    // Populate message info
    await message.populate([
      { path: 'sender', select: 'username profile.displayName profile.avatar' },
      { path: 'replyTo', select: 'content.text sender', populate: { path: 'sender', select: 'username profile.displayName' } },
      { path: 'forwardedFrom', select: 'content.text content.media sender', populate: { path: 'sender', select: 'username profile.displayName profile.avatar' } },
      { path: 'sharedPost', select: sharedPostSelect, populate: { path: 'author', select: sharedPostAuthorSelect } },
      { path: 'mentions', select: 'username profile.displayName profile.avatar' }
    ]);

    const messagePojo = message.toObject ? message.toObject() : message;

    // Send mention notifications
    if (mentionedUserIds.length > 0) {
      const senderUser = await User.findById(senderId).select('username profile.displayName').lean();
      const senderName = senderUser?.username || 'Someone';
      for (const mentionedId of mentionedUserIds) {
        try {
          await createMessageNotification(mentionedId, senderId, message._id, {
            conversationId: String(chatRoomId),
            chatId: String(chatRoomId),
            muteKey: String(chatRoomId),
            groupName: chatRoom.name,
            title: 'You were mentioned',
            message: `${senderName} mentioned you in ${chatRoom.name}`,
            messageKind: 'mention',
            hasMedia: mediaData.length > 0,
            primaryMediaType: mediaData[0]?.type,
            deepLink: `/conversation/${chatRoomId}`
          });
        } catch (notifErr) {
          log.error('Failed to deliver group mention notification', {
            error: String(notifErr),
            recipientId: String(mentionedId),
            chatRoomId: String(chatRoomId)
          });
        }
      }
    }

    // Ordinary group messages receive the same durable push/in-app fallback as
    // DMs. Mentioned members already have a higher-signal mention notification.
    const mentionedIds = new Set(mentionedUserIds.map((id) => String(id)));
    const groupRecipientIds = Array.from(new Set(chatRoom.members
      .map((member) => String(member.user))
      .filter((memberId) => memberId !== String(senderId) && !mentionedIds.has(memberId))));
    if (groupRecipientIds.length > 0) {
      const senderName = messagePojo?.sender?.username || req.user?.username || 'Someone';
      const messageKind = getMessageKind({ media: mediaData, sharedPost: sharedPostObj, replyTo, forwardedFrom });
      const notificationResults = await Promise.allSettled(groupRecipientIds.map((recipientId) => createMessageNotification(
        recipientId,
        senderId,
        message._id,
        {
          conversationId: String(chatRoomId),
          chatId: String(chatRoomId),
          muteKey: String(chatRoomId),
          groupName: chatRoom.name,
          title: chatRoom.name,
          message: `${senderName} sent a message in ${chatRoom.name}`,
          messageKind,
          hasMedia: mediaData.length > 0,
          primaryMediaType: mediaData[0]?.type,
          deepLink: `/conversation/${chatRoomId}`
        }
      )));
      notificationResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          log.error('Failed to deliver group message notification', {
            error: String(result.reason),
            recipientId: groupRecipientIds[index],
            chatRoomId: String(chatRoomId),
            messageId: String(message._id)
          });
        }
      });
    }

    // Emit real-time message to all group members
    if (io) {
      if (process.env.NODE_ENV === 'development') { console.log('Emitting real-time group message to chat room:', chatRoomId);}
      io.to(`chat-${chatRoomId}`).emit('newMessage', {
        chatId: chatRoomId,
        message: messagePojo
      });
      if (process.env.NODE_ENV === 'development') { console.log('Real-time group message emitted successfully');}
    } else {
      if (process.env.NODE_ENV === 'development') { console.log('Socket.io not available for real-time group messaging');}
    }

    res.status(201).json({
      success: true,
      message: 'Group message sent successfully',
      data: {
        message: messagePojo
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to send group message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get group messages
const getGroupMessages = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const userId = req.user._id;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    // Return deep history by default so old messages remain visible in group chat.
    // A hard cap is kept to prevent unbounded payloads.
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 1000)
      : 1000;
    const skip = (page - 1) * limit;

    // Check if user is member of the chat room
    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom || !chatRoom.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Chat room not found'
      });
    }

    const isMember = chatRoom.members.some(member => member.user.toString() === userId.toString());
    // Also allow removed members to view history (read-only)
    const wasEverMember = isMember || 
      (chatRoom.removedMembers && chatRoom.removedMembers.some(m => m.user.toString() === userId.toString()));
    if (!wasEverMember) {
      return res.status(403).json({
        success: false,
        message: 'You are not a member of this chat room'
      });
    }

    const messages = await Message.find({
      chatRoom: chatRoomId,
      messageType: 'group',
      deletedForEveryone: { $ne: true },
      $and: [
        {
          $or: [
            { deletedForUsers: { $exists: false } },
            { deletedForUsers: { $size: 0 } },
            { deletedForUsers: { $not: { $elemMatch: { user: userId } } } }
          ]
        }
      ]
    })
    .populate('sender', 'username profile.displayName profile.avatar')
    .populate({ path: 'replyTo', select: 'content.text content.media sender', populate: { path: 'sender', select: 'username profile.displayName profile.avatar' } })
    .populate('forwardedFrom', 'content.text content.media sender')
    .populate('forwardedFrom.sender', 'username profile.displayName profile.avatar')
    .populate('sharedPost', sharedPostSelect)
    .populate('sharedPost.author', sharedPostAuthorSelect)
    .populate('reactions.user', 'username profile.displayName')
    .populate('mentions', 'username profile.displayName profile.avatar')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);

    const total = await Message.countDocuments({
      chatRoom: chatRoomId,
      messageType: 'group',
      deletedForEveryone: { $ne: true },
      $and: [
        {
          $or: [
            { deletedForUsers: { $exists: false } },
            { deletedForUsers: { $size: 0 } },
            { deletedForUsers: { $not: { $elemMatch: { user: userId } } } }
          ]
        }
      ]
    });

    res.status(200).json({
      success: true,
      messages: messages.reverse(), // Reverse to show oldest first
      pagination: {
        current: page,
        total: Math.ceil(total / limit),
        count: messages.length,
        totalMessages: total
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch group messages',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Mark messages as read
const markMessagesAsRead = async (req, res) => {
  try {
    const { chatId, messageType } = req.body;
    const userId = req.user._id;

    let filter = {
      'readBy.user': { $ne: userId },
      deletedForEveryone: { $ne: true },
      $or: [
        { deletedForUsers: { $exists: false } },
        { deletedForUsers: { $size: 0 } },
        { deletedForUsers: { $not: { $elemMatch: { user: userId } } } }
      ]
    };

    if (messageType === 'direct') {
      // For direct messages, mark messages from the other user as read
      const otherUserId = chatId.replace('direct_', '');
      filter = {
        ...filter,
        messageType: 'direct',
        sender: otherUserId,
        recipient: userId
      };
    } else {
      // For group messages, mark all messages in the chat room as read (excluding own messages)
      filter = {
        ...filter,
        messageType: 'group',
        sender: { $ne: userId },
        chatRoom: chatId
      };
    }

    const result = await Message.updateMany(filter, {
      $addToSet: {
        readBy: {
          user: userId,
          readAt: new Date()
        }
      }
    });

    // Also mark related notifications as read so the notification bell clears
    if (messageType === 'direct') {
      const otherUserId = chatId.replace('direct_', '');
      await Notification.updateMany(
        { recipient: userId, sender: otherUserId, type: 'message', isRead: false },
        { $set: { isRead: true, readAt: new Date() } }
      );
    } else {
      // For group chats, mark all unread message/mention notifications for this room
      const roomMessages = await Message.find({ messageType: 'group', chatRoom: chatId }, '_id').lean();
      const roomMessageIds = roomMessages.map(m => m._id);
      await Notification.updateMany(
        { recipient: userId, type: { $in: ['message', 'mention'] }, isRead: false, 'data.messageId': { $in: roomMessageIds } },
        { $set: { isRead: true, readAt: new Date() } }
      );
    }

    res.status(200).json({
      success: true,
      message: 'Messages marked as read',
      data: {
        updatedCount: result.modifiedCount
      }
    });

  } catch (error) {
    log.error('Error marking messages as read:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to mark messages as read',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Add reaction to message
const addReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user._id;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    // Check if user already reacted with this emoji
    const existingReaction = message.reactions.find(
      reaction => reaction.user.toString() === userId.toString() && reaction.emoji === emoji
    );

    if (existingReaction) {
      // Remove reaction
      message.reactions = message.reactions.filter(
        reaction => !(reaction.user.toString() === userId.toString() && reaction.emoji === emoji)
      );
    } else {
      // Add reaction
      message.reactions.push({
        user: userId,
        emoji,
        reactedAt: new Date()
      });
    }

    await message.save();

    // Broadcast reaction update in real-time
    if (io) {
      const reactionPayload = { messageId: message._id, reactions: message.reactions };
      if (message.chatRoom) {
        io.to(`chat-${message.chatRoom}`).emit('message_reaction', reactionPayload);
      } else if (message.recipient) {
        io.to(`user-${message.sender}`).emit('message_reaction', reactionPayload);
        io.to(`user-${message.recipient}`).emit('message_reaction', reactionPayload);
      }
    }

    res.status(200).json({
      success: true,
      message: existingReaction ? 'Reaction removed' : 'Reaction added',
      reactions: message.reactions,
      data: {
        reactions: message.reactions
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to add reaction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update chat room settings
const updateChatRoom = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const { name, description } = req.body;
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        message: 'Chat room not found'
      });
    }

    // Check if user is admin
    const isAdmin = chatRoom.creator.toString() === userId.toString() || 
                   chatRoom.members.some(member => 
                     member.user.toString() === userId.toString() && member.role === 'admin'
                   );

    // Check editGroupSettings permission — if disabled, only admins can edit
    const editAllowed = chatRoom.memberPermissions?.editGroupSettings !== false;
    if (!isAdmin && !editAllowed) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can update group settings'
      });
    }

    // Capture old values before update for system messages
    const oldName = chatRoom.name;
    const oldDescription = chatRoom.description;

    // Update name/description
    if (name) chatRoom.name = name;
    if (description !== undefined) chatRoom.description = description;

    // Handle avatar upload
    if (req.files && req.files.avatar && req.files.avatar[0]) {
      try {
        const { uploadAvatar } = require('../utils/cloudinary');
        const result = await uploadAvatar(req.files.avatar[0], 'gaming-social/group-avatars');
        chatRoom.avatar = result.url;
      } catch (uploadErr) {
        return res.status(400).json({ success: false, message: 'Failed to upload group avatar' });
      }
    }

    await chatRoom.save();

    // Fetch user display name for system messages
    const actingUser = await User.findById(userId).select('username profile.displayName').lean();
    const actorName = actingUser?.profile?.displayName || actingUser?.username || 'Someone';

    // Emit system messages for name/description changes
    const systemMessages = [];

    if (name && name !== oldName) {
      const msg = await Message.create({
        sender: userId,
        chatRoom: chatRoom._id,
        messageType: 'group',
        content: { text: `${actorName} changed the group name from "${oldName}" to "${name}"` }
      });
      systemMessages.push(msg);
    }

    if (description !== undefined && description !== oldDescription) {
      const descText = description
        ? `${actorName} updated the group description`
        : `${actorName} removed the group description`;
      const msg = await Message.create({
        sender: userId,
        chatRoom: chatRoom._id,
        messageType: 'group',
        content: { text: descText }
      });
      systemMessages.push(msg);
    }

    if (systemMessages.length > 0) {
      const lastMsg = systemMessages[systemMessages.length - 1];
      chatRoom.lastMessage = lastMsg._id;
      chatRoom.lastActivity = new Date();
      await chatRoom.save();
      if (io) {
        systemMessages.forEach(msg => {
          io.to(`chat-${chatRoom._id}`).emit('newMessage', { chatId: chatRoom._id.toString(), message: msg });
        });
        // Notify all members of group info update
        io.to(`chat-${chatRoom._id}`).emit('groupInfoUpdated', {
          chatRoomId: chatRoom._id,
          name: chatRoom.name,
          description: chatRoom.description,
          avatar: chatRoom.avatar
        });
      }
    }

    // Populate and transform for frontend
    await chatRoom.populate([
      { path: 'creator', select: 'username profile.displayName profile.avatar' },
      { path: 'members.user', select: 'username profile.displayName profile.avatar' }
    ]);

    const transformedChatRoom = {
      _id: chatRoom._id,
      name: chatRoom.name,
      description: chatRoom.description,
      avatar: chatRoom.avatar,
      creator: chatRoom.creator,
      members: chatRoom.members,
      memberCount: chatRoom.members.length,
      memberPermissions: chatRoom.memberPermissions || { editGroupSettings: true, sendMessages: true, addMembers: true },
      lastMessage: null,
      unreadCount: 0
    };

    res.status(200).json({
      success: true,
      message: 'Chat room updated successfully',
      data: {
        chatRoom: transformedChatRoom
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update chat room',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Add member to chat room
const addMemberToChatRoom = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const { memberId } = req.body;
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        message: 'Chat room not found'
      });
    }

    // Check if user is admin
    const isAdmin = chatRoom.creator.toString() === userId.toString() || 
                   chatRoom.members.some(member => 
                     member.user.toString() === userId.toString() && member.role === 'admin'
                   );

    // Check addMembers permission — if disabled, only admins can add
    const addAllowed = chatRoom.memberPermissions?.addMembers !== false;
    if (!isAdmin && !addAllowed) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can add members to this group'
      });
    }

    // Check if member already exists
    const existingMember = chatRoom.members.find(
      member => member.user.toString() === memberId
    );

    if (existingMember) {
      return res.status(400).json({
        success: false,
        message: 'User is already a member of this group'
      });
    }

    // Check if user exists
    const user = await User.findById(memberId).select('+following +privacySettings username isActive profile');
    if (!user || !user.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Privacy check: whoCanAddToGroup
    const targetPrivacy = user.privacySettings?.whoCanAddToGroup || 'anyone';
    if (targetPrivacy === 'nobody') {
      return res.status(403).json({ success: false, reason: 'privacy_blocked', targetUsername: user.username });
    }
    if (targetPrivacy === 'people_you_follow') {
      // Check if the target user follows the adder
      const targetFollowsAdder = user.following && user.following.some(
        id => id.toString() === userId.toString()
      );
      if (!targetFollowsAdder) {
        return res.status(403).json({ success: false, reason: 'privacy_blocked', targetUsername: user.username });
      }
    }

    // Add member
    chatRoom.members.push({
      user: memberId,
      role: 'member',
      joinedAt: new Date()
    });
    // Remove from removedMembers if they were previously removed
    if (chatRoom.removedMembers) {
      chatRoom.removedMembers = chatRoom.removedMembers.filter(m => m.user.toString() !== memberId);
    }
    await chatRoom.save();

    // Send system message
    const addedName = user.profile?.displayName || user.username || 'A member';
    const systemMessage = new Message({
      sender: userId,
      chatRoom: chatRoom._id,
      messageType: 'group',
      content: { text: `${addedName} has been added to the group` }
    });
    await systemMessage.save();
    await systemMessage.populate('sender', 'username profile.displayName profile.avatar');

    if (io) {
      io.to(`chat-${chatRoom._id}`).emit('newMessage', {
        chatId: chatRoom._id.toString(),
        message: systemMessage
      });
    }

    // Populate and transform for frontend
    await chatRoom.populate([
      { path: 'creator', select: 'username profile.displayName profile.avatar' },
      { path: 'members.user', select: 'username profile.displayName profile.avatar' }
    ]);

    const transformedChatRoom = {
      _id: chatRoom._id,
      name: chatRoom.name,
      description: chatRoom.description,
      avatar: chatRoom.avatar,
      creator: chatRoom.creator,
      members: chatRoom.members,
      memberCount: chatRoom.members.length,
      lastMessage: null, // TODO: Add last message logic
      unreadCount: 0 // TODO: Add unread count logic
    };

    res.status(200).json({
      success: true,
      message: 'Member added successfully',
      data: {
        chatRoom: transformedChatRoom
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to add member',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Remove member from chat room
const removeMemberFromChatRoom = async (req, res) => {
  try {
    const { chatRoomId, memberId } = req.params;
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        message: 'Chat room not found'
      });
    }

    // Check if user is admin
    const isAdmin = chatRoom.creator.toString() === userId.toString() || 
                   chatRoom.members.some(member => 
                     member.user.toString() === userId.toString() && member.role === 'admin'
                   );

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can remove members'
      });
    }

    // Check if member exists
    const memberIndex = chatRoom.members.findIndex(
      member => member.user.toString() === memberId
    );

    if (memberIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Member not found in this group'
      });
    }

    // Check if trying to remove the creator
    if (chatRoom.creator.toString() === memberId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove the group creator'
      });
    }

    // Get removed member's display name for system message
    const removedMemberDoc = await require('../models/User').findById(memberId).select('username profile.displayName');
    const removedName = removedMemberDoc?.profile?.displayName || removedMemberDoc?.username || 'A member';

    // Remove member
    chatRoom.members.splice(memberIndex, 1);
    // Track in removedMembers for history access
    if (!chatRoom.removedMembers) chatRoom.removedMembers = [];
    chatRoom.removedMembers.push({ user: memberId, removedAt: new Date() });
    await chatRoom.save();

    // Send system message: "xyz has been removed from the group"
    const systemMessage = new Message({
      sender: userId,
      chatRoom: chatRoom._id,
      messageType: 'group',
      content: { text: `${removedName} has been removed from the group` }
    });
    await systemMessage.save();
    await systemMessage.populate('sender', 'username profile.displayName profile.avatar');

    // Emit to room members
    if (io) {
      io.to(`chat-${chatRoom._id}`).emit('newMessage', {
        chatId: chatRoom._id.toString(),
        message: systemMessage
      });
      // Tell the removed user they've been removed
      io.to(`chat-${chatRoom._id}`).emit('memberRemoved', {
        chatRoomId: chatRoom._id.toString(),
        removedUserId: memberId
      });
    }

    // Populate and transform for frontend
    await chatRoom.populate([
      { path: 'creator', select: 'username profile.displayName profile.avatar' },
      { path: 'members.user', select: 'username profile.displayName profile.avatar' }
    ]);

    const transformedChatRoom = {
      _id: chatRoom._id,
      name: chatRoom.name,
      description: chatRoom.description,
      avatar: chatRoom.avatar,
      creator: chatRoom.creator,
      members: chatRoom.members,
      memberCount: chatRoom.members.length,
      lastMessage: null, // TODO: Add last message logic
      unreadCount: 0 // TODO: Add unread count logic
    };

    res.status(200).json({
      success: true,
      message: 'Member removed successfully',
      data: {
        chatRoom: transformedChatRoom
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to remove member',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update member role in chat room
const updateMemberRole = async (req, res) => {
  try {
    const { chatRoomId, memberId } = req.params;
    const { role } = req.body; // 'admin' or 'member'
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        message: 'Chat room not found'
      });
    }

    // Check if user is admin
    const isAdmin = chatRoom.creator.toString() === userId.toString() || 
                   chatRoom.members.some(member => 
                     member.user.toString() === userId.toString() && member.role === 'admin'
                   );

    if (!isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Only admins can update member roles'
      });
    }

    // Check if member exists
    const memberIndex = chatRoom.members.findIndex(
      member => member.user.toString() === memberId
    );

    if (memberIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Member not found in this group'
      });
    }

    // Check if trying to update the creator's role
    if (chatRoom.creator.toString() === memberId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot change the group creator\'s role'
      });
    }

    // Update member role
    chatRoom.members[memberIndex].role = role;

    await chatRoom.save();

    // Populate and transform for frontend
    await chatRoom.populate([
      { path: 'creator', select: 'username profile.displayName profile.avatar' },
      { path: 'members.user', select: 'username profile.displayName profile.avatar' }
    ]);

    const transformedChatRoom = {
      _id: chatRoom._id,
      name: chatRoom.name,
      description: chatRoom.description,
      avatar: chatRoom.avatar,
      creator: chatRoom.creator,
      members: chatRoom.members.map(member => ({
        user: member.user,
        role: member.role,
        joinedAt: member.joinedAt
      })),
      createdAt: chatRoom.createdAt
    };

    res.json({
      success: true,
      message: `Member role updated to ${role}`,
      chatRoom: transformedChatRoom
    });

  } catch (error) {
    log.error('Error updating member role:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Handle invite response from message
const handleInviteResponse = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { response } = req.body; // 'accept' or 'decline'
    const userId = req.user._id;

    // Find the message with invite data
    const message = await Message.findById(messageId);
    if (!message || !message.inviteData) {
      return res.status(404).json({
        success: false,
        message: 'Invite message not found'
      });
    }

    // Check if user is the recipient of the invite
    if (message.recipient.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only respond to invites sent to you'
      });
    }

    // Check if invite is still valid (not expired)
    const RosterInvite = require('../models/RosterInvite');
    const StaffInvite = require('../models/StaffInvite');
    
    let invite;
    if (message.inviteData.type === 'roster') {
      invite = await RosterInvite.findById(message.inviteData.inviteId);
    } else if (message.inviteData.type === 'staff') {
      invite = await StaffInvite.findById(message.inviteData.inviteId);
    }

    if (!invite || invite.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Invite is no longer valid or has already been responded to'
      });
    }

    // Update invite status
    invite.status = response === 'accept' ? 'accepted' : 'declined';
    await invite.save();

    // Handle the response based on type
    if (response === 'accept') {
      if (message.inviteData.type === 'roster') {
        // Add player to team roster
        const team = await User.findById(message.inviteData.teamId);
        if (team) {
          // Ensure teamInfo and rosters exist
          if (!team.teamInfo) {
            team.teamInfo = { rosters: [] };
          }
          if (!team.teamInfo.rosters) {
            team.teamInfo.rosters = [];
          }

          let roster = team.teamInfo.rosters.find(r => r.game === message.inviteData.game);
          if (!roster) {
            // Create new roster with proper Mongoose schema structure
            roster = {
              game: message.inviteData.game,
              players: [],
              isActive: true
            };
            team.teamInfo.rosters.push(roster);
          }

          // Check if player already exists in this roster (handle both ObjectId and populated user)
          const existingPlayerIndex = roster.players.findIndex(
            p => {
              const playerUserId = p.user ? (p.user._id ? p.user._id.toString() : p.user.toString()) : null;
              return playerUserId === userId.toString();
            }
          );

          if (existingPlayerIndex !== -1) {
            // Update existing player entry
            roster.players[existingPlayerIndex].role = message.inviteData.role || 'Player';
            roster.players[existingPlayerIndex].inGameName = message.inviteData.inGameName || null;
            roster.players[existingPlayerIndex].joinedAt = new Date();
            roster.players[existingPlayerIndex].leftAt = null;
            roster.players[existingPlayerIndex].isActive = true;
          } else {
            // Add new player to roster
            roster.players.push({
              user: userId,
              role: message.inviteData.role || 'Player',
              inGameName: message.inviteData.inGameName || null,
              joinedAt: new Date(),
              leftAt: null,
              isActive: true
            });
          }

          // Mark roster as active if it wasn't
          roster.isActive = true;
          
          // Force markModified to ensure Mongoose detects the nested array changes
          team.markModified('teamInfo.rosters');
          team.markModified('teamInfo');
          
          await team.save();
          
          // Verify the save worked by fetching the team again (fresh from DB)
          const verifyTeam = await User.findById(team._id);
          const verifyRoster = verifyTeam?.teamInfo?.rosters?.find(r => r.game === message.inviteData.game);
          const verifyPlayer = verifyRoster?.players?.find(p => {
            const pid = p.user ? (p.user._id ? p.user._id.toString() : p.user.toString()) : p.user?.toString();
            return pid === userId.toString();
          });
          
          log.debug('Player added to roster successfully:', {
            teamId: team._id,
            game: message.inviteData.game,
            playerId: userId,
            role: message.inviteData.role,
            rosterPlayersCountBeforeSave: roster.players.length,
            rosterPlayersCountAfterSave: verifyRoster?.players?.length || 0,
            playerFoundInDB: !!verifyPlayer,
            playerIsActive: verifyPlayer?.isActive
          });
          
          if (!verifyPlayer || verifyPlayer.isActive !== true) {
            log.error('WARNING: Player was not properly saved to roster or isActive is not true!');
          }
        }

        // Add team to player's joinedTeams array
        const player = await User.findById(userId);
        if (player && player.userType === 'player') {
          // Ensure playerInfo and joinedTeams exist
          if (!player.playerInfo) {
            player.playerInfo = { joinedTeams: [] };
          }
          if (!player.playerInfo.joinedTeams) {
            player.playerInfo.joinedTeams = [];
          }

          // Check if player is already in this team for this game
          const existingTeamIndex = player.playerInfo.joinedTeams.findIndex(
            teamEntry => teamEntry.team && teamEntry.team.toString() === message.inviteData.teamId.toString() && 
                        teamEntry.game === message.inviteData.game
          );

          if (existingTeamIndex === -1) {
            // Add new team entry
            player.playerInfo.joinedTeams.push({
              team: message.inviteData.teamId,
              game: message.inviteData.game,
              role: message.inviteData.role,
              inGameName: message.inviteData.inGameName,
              joinedAt: new Date(),
              isActive: true
            });
          } else {
            // Update existing entry
            player.playerInfo.joinedTeams[existingTeamIndex].isActive = true;
            player.playerInfo.joinedTeams[existingTeamIndex].leftAt = null;
            player.playerInfo.joinedTeams[existingTeamIndex].role = message.inviteData.role;
            player.playerInfo.joinedTeams[existingTeamIndex].inGameName = message.inviteData.inGameName;
          }
          
          await player.save();
        }
      } else if (message.inviteData.type === 'staff') {
        // Add player to team staff
        const team = await User.findById(message.inviteData.teamId);
        if (team) {
          team.teamInfo.staff.push({
            user: userId,
            role: message.inviteData.role,
            game: message.inviteData.game || 'General',
            joinedAt: new Date(),
            isActive: true
          });
          
          await team.save();
        }

        // Add team to player's joinedTeams array for staff role
        const player = await User.findById(userId);
        if (player && player.userType === 'player') {
          // Check if player is already in this team for staff role
          const existingTeamIndex = player.playerInfo.joinedTeams.findIndex(
            teamEntry => teamEntry.team.toString() === message.inviteData.teamId.toString() && 
                        teamEntry.role === message.inviteData.role &&
                        teamEntry.game === (message.inviteData.game || 'General')
          );

          if (existingTeamIndex === -1) {
            // Add new team entry for staff role
            player.playerInfo.joinedTeams.push({
              team: message.inviteData.teamId,
              game: message.inviteData.game || 'General',
              role: message.inviteData.role,
              inGameName: '', // Staff members don't have in-game names
              joinedAt: new Date(),
              isActive: true
            });
          } else {
            // Update existing entry
            player.playerInfo.joinedTeams[existingTeamIndex].isActive = true;
            player.playerInfo.joinedTeams[existingTeamIndex].leftAt = null;
            player.playerInfo.joinedTeams[existingTeamIndex].role = message.inviteData.role;
            player.playerInfo.joinedTeams[existingTeamIndex].game = message.inviteData.game || 'General';
          }
          
          await player.save();
        }
      }
    }

    // Send response message back to team
    const responseMessage = response === 'accept' 
      ? `✅ Invitation Accepted\n\nI've accepted your invitation to join the team. Looking forward to working with you!`
      : `❌ Invitation Declined\n\nI've decided to decline the invitation. Thank you for considering me.`;

    const responseMessageData = {
      sender: userId,
      recipient: message.inviteData.teamId,
      messageType: 'direct',
      content: {
        text: responseMessage,
        media: []
      }
    };

    const responseMsg = await Message.create(responseMessageData);
    
    // Populate sender and recipient info
    await responseMsg.populate([
      { path: 'sender', select: 'username profile.displayName profile.avatar' },
      { path: 'recipient', select: 'username profile.displayName profile.avatar' }
    ]);

    // Route the automated response through the same mute-aware message
    // producer as every other direct message.
    await createMessageNotification(message.inviteData.teamId, userId, responseMsg._id, {
      conversationId: `direct_${userId}`,
      chatId: `direct_${userId}`,
      muteKey: userId,
      title: 'New Message',
      message: `${req.user.profile?.displayName || req.user.username} sent you a message`,
      messageKind: 'invite_response',
      hasMedia: false,
      deepLink: `/conversation/direct_${userId}`
    });

    // Update the original invite message to include status
    message.inviteData.status = invite.status;
    message.markModified('inviteData');
    await message.save();

    res.status(200).json({
      success: true,
      message: `Invitation ${response}d successfully`,
      data: {
        inviteStatus: invite.status,
        updatedMessage: message,
        responseMessage: responseMsg
      }
    });

  } catch (error) {
    log.error('Error handling invite response:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to process invite response',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete direct message
const deleteDirectMessage = async (req, res) => {
  try {
    const { userId } = req.params;
    const { messageId, deleteType = 'forMe' } = req.body || {};
    const currentUserId = req.user._id;
    
    if (process.env.NODE_ENV === 'development') { console.log('Delete direct message request:', { userId, messageId, deleteType, currentUserId });
}
    if (!messageId) {
      const otherUserId = String(userId || '').replace(/^direct_/, '');
      if (!otherUserId) {
        return res.status(400).json({
          success: false,
          message: 'User ID is required'
        });
      }

      const deletedAt = new Date();
      const result = await Message.updateMany(
        {
          messageType: 'direct',
          deletedForEveryone: false,
          'deletedForUsers.user': { $ne: currentUserId },
          $or: [
            { sender: currentUserId, recipient: otherUserId },
            { sender: otherUserId, recipient: currentUserId }
          ]
        },
        {
          $addToSet: {
            deletedForUsers: {
              user: currentUserId,
              deletedAt
            }
          }
        }
      );

      return res.status(200).json({
        success: true,
        message: 'Conversation deleted for you',
        data: { updatedCount: result.modifiedCount }
      });
    }

    // Validate messageId format
    if (!messageId || messageId.length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Invalid message ID format'
      });
    }

    // Find the message
    const message = await Message.findById(messageId);
    if (!message) {
      if (process.env.NODE_ENV === 'development') { console.log('Message not found with ID:', messageId);}
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    // Check if user is the sender or recipient
    const isSender = message.sender.toString() === currentUserId.toString();
    const isRecipient = message.recipient.toString() === currentUserId.toString();
    
    if (!isSender && !isRecipient) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own messages'
      });
    }

    if (deleteType === 'forEveryone') {
      // Only sender can delete for everyone
      if (!isSender) {
        return res.status(403).json({
          success: false,
          message: 'Only the sender can delete message for everyone'
        });
      }
      // Mark message as deleted for everyone
      message.isDeleted = true;
      message.deletedAt = new Date();
      message.deletedBy = currentUserId;
      message.deletedForEveryone = true;
    } else {
      // Delete for me only - create a user-specific delete record
      if (!message.deletedForUsers) {
        message.deletedForUsers = [];
      }
      const alreadyDeletedForUser = message.deletedForUsers.some(
        entry => entry.user && entry.user.toString() === currentUserId.toString()
      );
      if (!alreadyDeletedForUser) {
        message.deletedForUsers.push({
          user: currentUserId,
          deletedAt: new Date()
        });
      }
    }
    
    await message.save();

    if (deleteType === 'forEveryone' && io) {
      const payload = { messageId: message._id, deleteType: 'forEveryone' };
      io.to(`user-${message.sender}`).emit('message_deleted', payload);
      io.to(`user-${message.recipient}`).emit('message_deleted', payload);
    }

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully'
    });

  } catch (error) {
    log.error('Error deleting direct message:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to delete message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete group message
const deleteGroupMessage = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const { messageId, deleteType = 'forMe' } = req.body || {};
    const currentUserId = req.user._id;

    // Find the chat room
    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom) {
      return res.status(404).json({
        success: false,
        message: 'Chat room not found'
      });
    }

    // Check if user is a member of the chat room
    const isMember = chatRoom.members.some(member => 
      member.user.toString() === currentUserId.toString()
    );
    
    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'You are not a member of this chat room'
      });
    }

    // Find the message
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    // Check if user is the sender or an admin
    const isSender = message.sender.toString() === currentUserId.toString();
    const isAdmin = chatRoom.members.some(member => 
      member.user.toString() === currentUserId.toString() && member.role === 'admin'
    );
    
    if (!isSender && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own messages or be an admin'
      });
    }

    if (deleteType === 'forEveryone') {
      // Only sender or admin can delete for everyone
      if (!isSender && !isAdmin) {
        return res.status(403).json({
          success: false,
          message: 'Only the sender or admin can delete message for everyone'
        });
      }
      // Mark message as deleted for everyone
      message.isDeleted = true;
      message.deletedAt = new Date();
      message.deletedBy = currentUserId;
      message.deletedForEveryone = true;
    } else {
      // Delete for me only - create a user-specific delete record
      if (!message.deletedForUsers) {
        message.deletedForUsers = [];
      }
      const alreadyDeletedForUser = message.deletedForUsers.some(
        entry => entry.user && entry.user.toString() === currentUserId.toString()
      );
      if (!alreadyDeletedForUser) {
        message.deletedForUsers.push({
          user: currentUserId,
          deletedAt: new Date()
        });
      }
    }
    
    await message.save();

    if (deleteType === 'forEveryone' && io) {
      io.to(`chat-${chatRoomId}`).emit('message_deleted', {
        messageId: message._id,
        deleteType: 'forEveryone',
        chatRoomId
      });
    }

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully'
    });

  } catch (error) {
    log.error('Error deleting group message:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to delete message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};


// Leave a group chat room
const leaveGroup = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findById(chatRoomId).populate('members.user', 'username profile.displayName');
    if (!chatRoom) {
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    const memberIndex = chatRoom.members.findIndex(m => m.user._id.toString() === userId.toString());
    if (memberIndex === -1) {
      return res.status(400).json({ success: false, message: 'You are not a member of this group' });
    }

    const leavingMember = chatRoom.members[memberIndex];
    const isAdmin = leavingMember.role === 'admin';

    // If admin and no other admin exists, block leave
    if (isAdmin) {
      const otherAdmins = chatRoom.members.filter(
        m => m.user._id.toString() !== userId.toString() && m.role === 'admin'
      );
      if (otherAdmins.length === 0 && chatRoom.members.length > 1) {
        return res.status(400).json({
          success: false,
          message: 'You must assign another admin before leaving',
          code: 'ADMIN_MUST_ASSIGN'
        });
      }
    }

    // Get display name for system message
    const displayName = leavingMember.user.profile?.displayName || leavingMember.user.username || 'Someone';

    // Remove member
    chatRoom.members.splice(memberIndex, 1);
    await chatRoom.save();

    // Send system message: "xyz left the group"
    const systemMessage = new Message({
      sender: userId,
      chatRoom: chatRoomId,
      messageType: 'group',
      content: { text: `${displayName} left the group` }
    });
    await systemMessage.save();
    await systemMessage.populate('sender', 'username profile.displayName profile.avatar');

    // Emit to room
    if (io) {
      io.to(`chat-${chatRoomId}`).emit('newMessage', {
        chatId: chatRoomId,
        message: systemMessage
      });
      io.to(`chat-${chatRoomId}`).emit('memberLeft', { chatRoomId, userId: userId.toString() });
    }

    res.status(200).json({ success: true, message: 'Left group successfully' });
  } catch (error) {
    log.error('Error leaving group:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to leave group' });
  }
};

// Create a call summary message after a call ends
const createCallSummary = async (req, res) => {
  try {
    const { callType, outcome, durationSeconds, participantCount, recipientId, chatRoomId } = req.body;
    const senderId = req.user._id;

    if (!callType || !outcome) {
      return res.status(400).json({ success: false, message: 'callType and outcome are required' });
    }

    if (!recipientId && !chatRoomId) {
      return res.status(400).json({ success: false, message: 'recipientId or chatRoomId is required' });
    }

    const baseSummaryText = outcome === 'answered'
      ? `${callType === 'video' ? 'Video' : 'Voice'} call ended`
      : outcome === 'missed'
        ? `${callType === 'video' ? 'Video' : 'Voice'} call missed`
        : `${callType === 'video' ? 'Video' : 'Voice'} call declined`;
    const summaryText = (baseSummaryText && String(baseSummaryText).trim()) || 'Call update';

    const messageData = {
      sender: senderId,
      messageType: 'call',
      content: { text: summaryText, media: [] },
      callSummary: {
        callType,
        outcome,
        durationSeconds: durationSeconds || 0,
        participantCount: participantCount || 0
      }
    };

    if (recipientId) {
      messageData.recipient = recipientId;
    } else {
      messageData.chatRoom = chatRoomId;
    }

    const message = await Message.create(messageData);
    await message.populate('sender', 'username profile.displayName profile.avatar');

    // Emit real-time update to the relevant room
    if (io) {
      if (recipientId) {
        io.to(`user-${String(recipientId)}`).emit('newMessage', {
          chatId: `direct_${senderId}`,
          message
        });
      } else {
        io.to(`chat-${chatRoomId}`).emit('newMessage', {
          chatId: chatRoomId,
          message
        });
      }
    }

    res.status(201).json({ success: true, data: { message } });
  } catch (error) {
    log.error('createCallSummary error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to create call summary',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Toggle mute for a DM chat
const toggleMuteChat = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = await User.findById(req.user._id);
    if (!currentUser) return res.status(404).json({ success: false, message: 'User not found' });

    const mutedSet = new Set((currentUser.mutedChats || []).map(id => id.toString()));
    if (mutedSet.has(userId)) {
      mutedSet.delete(userId);
    } else {
      mutedSet.add(userId);
    }
    currentUser.mutedChats = Array.from(mutedSet);
    await currentUser.save();

    res.json({ success: true, muted: mutedSet.has(userId), mutedChats: currentUser.mutedChats });
  } catch (error) {
    log.error('toggleMuteChat error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to toggle mute' });
  }
};

// Toggle mute for a group chat room
const toggleMuteGroup = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const currentUser = await User.findById(req.user._id);
    if (!currentUser) return res.status(404).json({ success: false, message: 'User not found' });

    const mutedSet = new Set((currentUser.mutedChats || []).map(id => id.toString()));
    if (mutedSet.has(chatRoomId)) {
      mutedSet.delete(chatRoomId);
    } else {
      mutedSet.add(chatRoomId);
    }
    currentUser.mutedChats = Array.from(mutedSet);
    await currentUser.save();

    res.json({ success: true, muted: mutedSet.has(chatRoomId), mutedChats: currentUser.mutedChats });
  } catch (error) {
    log.error('toggleMuteGroup error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to toggle group mute' });
  }
};

// Toggle pin for a DM chat
const togglePinChat = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUser = await User.findById(req.user._id);
    if (!currentUser) return res.status(404).json({ success: false, message: 'User not found' });

    const pinnedSet = new Set((currentUser.pinnedChats || []).map(id => id.toString()));
    if (pinnedSet.has(userId)) {
      pinnedSet.delete(userId);
    } else {
      pinnedSet.add(userId);
    }
    currentUser.pinnedChats = Array.from(pinnedSet);
    await currentUser.save();

    res.json({ success: true, pinned: pinnedSet.has(userId), pinnedChats: currentUser.pinnedChats });
  } catch (error) {
    log.error('togglePinChat error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to toggle pin' });
  }
};

// Toggle pin for a group chat
const togglePinGroup = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const currentUser = await User.findById(req.user._id);
    if (!currentUser) return res.status(404).json({ success: false, message: 'User not found' });

    const pinnedSet = new Set((currentUser.pinnedGroups || []).map(id => id.toString()));
    if (pinnedSet.has(chatRoomId)) {
      pinnedSet.delete(chatRoomId);
    } else {
      pinnedSet.add(chatRoomId);
    }
    currentUser.pinnedGroups = Array.from(pinnedSet);
    await currentUser.save();

    res.json({ success: true, pinned: pinnedSet.has(chatRoomId), pinnedGroups: currentUser.pinnedGroups });
  } catch (error) {
    log.error('togglePinGroup error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to toggle group pin' });
  }
};

// Get muted/pinned chat preferences
const getChatPreferences = async (req, res) => {
  try {
    const currentUser = await User.findById(req.user._id).select('mutedChats pinnedChats pinnedGroups');
    if (!currentUser) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({
      success: true,
      mutedChats: currentUser.mutedChats || [],
      pinnedChats: currentUser.pinnedChats || [],
      pinnedGroups: currentUser.pinnedGroups || []
    });
  } catch (error) {
    log.error('getChatPreferences error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to get preferences' });
  }
};

// PUT /rooms/:chatRoomId/permissions — admin only
const updateGroupPermissions = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const { editGroupSettings, sendMessages, addMembers } = req.body;
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom || !chatRoom.isActive) {
      return res.status(404).json({ success: false, message: 'Chat room not found' });
    }

    const isAdmin = chatRoom.creator.toString() === userId.toString() ||
      chatRoom.members.some(m => m.user.toString() === userId.toString() && m.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Only admins can change group permissions' });
    }

    if (!chatRoom.memberPermissions) chatRoom.memberPermissions = {};
    if (typeof editGroupSettings === 'boolean') chatRoom.memberPermissions.editGroupSettings = editGroupSettings;
    if (typeof sendMessages === 'boolean') chatRoom.memberPermissions.sendMessages = sendMessages;
    if (typeof addMembers === 'boolean') chatRoom.memberPermissions.addMembers = addMembers;
    chatRoom.markModified('memberPermissions');
    await chatRoom.save();

    // Emit socket event so all members get updated permissions in real-time
    if (io) {
      io.to(`chat-${chatRoom._id}`).emit('groupPermissionsUpdated', {
        chatRoomId: chatRoom._id,
        memberPermissions: chatRoom.memberPermissions
      });
    }

    // System message for sendMessages change
    if (typeof sendMessages === 'boolean') {
      const adminUser = await User.findById(userId).select('username profile.displayName').lean();
      const adminName = adminUser?.profile?.displayName || adminUser?.username || 'Admin';
      const systemText = sendMessages
        ? `${adminName} allowed all members to send messages`
        : `${adminName} changed this group so only admins can send messages`;
      const systemMsg = await Message.create({
        sender: userId,
        chatRoom: chatRoom._id,
        messageType: 'group',
        content: { text: systemText }
      });
      chatRoom.lastMessage = systemMsg._id;
      chatRoom.lastActivity = new Date();
      await chatRoom.save();
      if (io) {
        io.to(`chat-${chatRoom._id}`).emit('newMessage', { chatId: chatRoom._id.toString(), message: systemMsg });
      }
    }

    res.json({ success: true, memberPermissions: chatRoom.memberPermissions });
  } catch (err) {
    log.error('updateGroupPermissions error:', { error: String(err) });
    res.status(500).json({ success: false, message: 'Failed to update permissions' });
  }
};

// GET /join/:inviteToken/preview — public, no auth needed
const getGroupInvitePreview = async (req, res) => {
  try {
    const { inviteToken } = req.params;
    const chatRoom = await ChatRoom.findOne({ inviteToken, isActive: true })
      .select('name avatar members')
      .lean();
    if (!chatRoom) {
      return res.status(404).json({ success: false, message: 'Invalid or expired invite link' });
    }
    res.json({
      success: true,
      group: {
        name: chatRoom.name,
        avatar: chatRoom.avatar || null,
        memberCount: chatRoom.members.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch group info' });
  }
};

// ─── Group Invite Link ───────────────────────────────────────────────────────

const crypto = require('crypto');

// GET /rooms/:chatRoomId/invite-link  — admin only, generates token if missing
const getGroupInviteLink = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom || !chatRoom.isActive) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const isAdmin = chatRoom.creator.toString() === userId.toString() ||
      chatRoom.members.some(m => m.user.toString() === userId.toString() && m.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Only admins can manage invite links' });
    }

    if (!chatRoom.inviteToken) {
      chatRoom.inviteToken = crypto.randomBytes(16).toString('hex');
      await chatRoom.save();
    }

    const baseUrl = process.env.CLIENT_URL || 'https://arc.squadhunt.com';
    const inviteLink = `${baseUrl}/join/${chatRoom.inviteToken}`;

    res.json({ success: true, inviteLink, token: chatRoom.inviteToken });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to get invite link' });
  }
};

// POST /rooms/:chatRoomId/reset-invite-link  — admin only
const resetGroupInviteLink = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom || !chatRoom.isActive) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    const isAdmin = chatRoom.creator.toString() === userId.toString() ||
      chatRoom.members.some(m => m.user.toString() === userId.toString() && m.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Only admins can reset invite links' });
    }

    chatRoom.inviteToken = crypto.randomBytes(16).toString('hex');
    await chatRoom.save();

    const baseUrl = process.env.CLIENT_URL || 'https://arc.squadhunt.com';
    const inviteLink = `${baseUrl}/join/${chatRoom.inviteToken}`;

    res.json({ success: true, inviteLink, token: chatRoom.inviteToken });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to reset invite link' });
  }
};

// POST /join/:inviteToken  — any authenticated user
const joinGroupViaInvite = async (req, res) => {
  try {
    const { inviteToken } = req.params;
    const userId = req.user._id;

    const chatRoom = await ChatRoom.findOne({ inviteToken, isActive: true });
    if (!chatRoom) {
      return res.status(404).json({ success: false, message: 'Invalid or expired invite link' });
    }

    // Already a member?
    if (chatRoom.members.some(m => m.user.toString() === userId.toString())) {
      return res.json({ success: true, alreadyMember: true, chatRoomId: chatRoom._id });
    }

    // Add member
    chatRoom.members.push({ user: userId, role: 'member', joinedAt: new Date() });
    if (chatRoom.removedMembers) {
      chatRoom.removedMembers = chatRoom.removedMembers.filter(m => m.user.toString() !== userId.toString());
    }
    await chatRoom.save();

    // System message
    const joiningUser = await User.findById(userId).select('username profile.displayName').lean();
    const joinName = joiningUser?.profile?.displayName || joiningUser?.username || 'Someone';
    const systemMsg = await Message.create({
      sender: userId,
      chatRoom: chatRoom._id,
      messageType: 'group',
      content: { text: `${joinName} joined via invite link` }
    });
    chatRoom.lastMessage = systemMsg._id;
    chatRoom.lastActivity = new Date();
    await chatRoom.save();

    if (io) {
      io.to(`chat-${chatRoom._id}`).emit('newMessage', { chatId: chatRoom._id.toString(), message: systemMsg });
    }

    res.json({ success: true, chatRoomId: chatRoom._id, groupName: chatRoom.name });
  } catch (err) {
    log.error('joinGroupViaInvite error:', { error: String(err) });
    res.status(500).json({ success: false, message: 'Failed to join group' });
  }
};

// POST /rooms/:chatRoomId/send-invite-dm  — any group member
const sendGroupInviteDM = async (req, res) => {
  try {
    const { chatRoomId } = req.params;
    const { targetUserId } = req.body;
    const callerId = req.user._id;

    // Verify group exists and is active
    const chatRoom = await ChatRoom.findById(chatRoomId);
    if (!chatRoom || !chatRoom.isActive) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    // Verify caller is a member
    const isMember = chatRoom.creator.toString() === callerId.toString() ||
      chatRoom.members.some(m => m.user.toString() === callerId.toString());
    if (!isMember) {
      return res.status(403).json({ success: false, message: 'You are not a member of this group' });
    }

    // Verify target user exists and is active
    const targetUser = await User.findById(targetUserId).select('username isActive privacySettings following');
    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // DM privacy check — respect whoCanMessage even for invite DMs
    const dmPrivacy = targetUser.privacySettings?.whoCanMessage || 'anyone';
    if (dmPrivacy === 'nobody') {
      return res.status(403).json({
        success: false,
        reason: 'dm_privacy_blocked',
        message: `${targetUser.username} doesn't accept messages from anyone.`
      });
    }
    if (dmPrivacy === 'people_you_follow') {
      const followsCaller = targetUser.following &&
        targetUser.following.some(id => id.toString() === callerId.toString());
      if (!followsCaller) {
        return res.status(403).json({
          success: false,
          reason: 'dm_privacy_blocked',
          message: `${targetUser.username} only accepts messages from people they follow.`
        });
      }
    }

    // Retrieve or generate invite token
    if (!chatRoom.inviteToken) {
      chatRoom.inviteToken = crypto.randomBytes(16).toString('hex');
      await chatRoom.save();
    }

    // Create the invite DM
    const message = await Message.create({
      messageType: 'direct',
      sender: callerId,
      recipient: targetUserId,
      content: { text: 'Sent you a group invite' },
      inviteData: {
        type: 'group_invite',
        groupId: chatRoom._id,
        groupName: chatRoom.name,
        groupAvatar: chatRoom.avatar || '',
        inviteToken: chatRoom.inviteToken
      }
    });

    // Populate sender and recipient fields
    await message.populate([
      { path: 'sender', select: 'username profile.displayName profile.avatar' },
      { path: 'recipient', select: 'username profile.displayName profile.avatar' }
    ]);

    // Emit real-time message to target user
    if (io) {
      io.to(`user-${targetUserId}`).emit('newMessage', {
        chatId: `direct_${callerId}`,
        message: message.toObject ? message.toObject() : message
      });
    }

    await createMessageNotification(targetUserId, callerId, message._id, {
      conversationId: `direct_${callerId}`,
      chatId: `direct_${callerId}`,
      muteKey: callerId,
      messageKind: 'invite',
      groupName: chatRoom.name,
      title: 'Group Invitation',
      message: `${req.user.profile?.displayName || req.user.username} invited you to ${chatRoom.name}`,
      hasMedia: false,
      deepLink: `/conversation/direct_${callerId}`
    });

    return res.status(201).json({ success: true, data: { message } });
  } catch (err) {
    log.error('sendGroupInviteDM error:', { error: String(err) });
    res.status(500).json({ success: false, message: 'Failed to send group invite' });
  }
};

// Report a message
const reportMessage = async (req, res) => {
  try {
    const { messageId, reason } = req.body;
    const reporterId = req.user._id;

    if (!messageId || !reason) {
      return res.status(400).json({ success: false, message: 'messageId and reason are required' });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ success: false, message: 'Message not found' });
    }

    if (!message.reports) message.reports = [];
    // Avoid duplicate reports from the same user
    const alreadyReported = message.reports.some(r => r.reportedBy && r.reportedBy.toString() === reporterId.toString());
    if (!alreadyReported) {
      message.reports.push({ reportedBy: reporterId, reason, reportedAt: new Date() });
      await message.save();
    }

    res.json({ success: true, message: 'Message reported successfully' });
  } catch (error) {
    log.error('reportMessage error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to report message' });
  }
};

module.exports = {
  sendDirectMessage,
  getDirectMessages,
  createChatRoom,
  getChatRooms,
  getRecentConversations,
  sendGroupMessage,
  getGroupMessages,
  addReaction,
  updateChatRoom,
  addMemberToChatRoom,
  removeMemberFromChatRoom,
  updateMemberRole,
  handleInviteResponse,
  markMessagesAsRead,
  deleteDirectMessage,
  deleteGroupMessage,
  leaveGroup,
  createCallSummary,
  toggleMuteChat,
  toggleMuteGroup,
  togglePinChat,
  togglePinGroup,
  getChatPreferences,
  getGroupInviteLink,
  resetGroupInviteLink,
  joinGroupViaInvite,
  getGroupInvitePreview,
  updateGroupPermissions,
  sendGroupInviteDM,
  reportMessage,
  setIoInstance
};
