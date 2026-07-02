const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.resolve(root, relative), 'utf8');

const user = read('controllers/userController.js');
const post = read('controllers/postController.js');
const story = read('controllers/storyController.js');
const message = read('controllers/messageController.js');
const call = read('controllers/callController.js');
const recommendation = read('services/recommendationService.js');
const recruitment = read('controllers/recruitmentController.js');
const dto = read('utils/dto.js');
const followModel = read('models/Follow.js');
const modularRoutes = fs.readFileSync(path.resolve(root, '../modules/users/users.routes.ts'), 'utf8');
const legacySocket = fs.readFileSync(path.resolve(root, '../modules/legacy/legacy.socket.ts'), 'utf8');
const chatService = fs.readFileSync(path.resolve(root, '../modules/chat/chat.service.ts'), 'utf8');
const migration = fs.readFileSync(path.resolve(root, '../../scripts/migrate-privacy-settings.js'), 'utf8');
const auth = read('controllers/authController.js');
const admin = read('controllers/adminController.js');
const profileCache = read('utils/profileCache.js');
const presencePrivacy = read('utils/presencePrivacy.js');
const presence = fs.readFileSync(path.resolve(root, '../modules/presence/presence.socket.ts'), 'utf8');
const socket = fs.readFileSync(path.resolve(root, '../infrastructure/websocket/socket.ts'), 'utf8');
const legacyMiddleware = fs.readFileSync(path.resolve(root, '../modules/legacy/legacy.middleware.ts'), 'utf8');

for (const field of ['profileVisibility', 'allowMessageFrom', 'showOnlineStatus', 'allowFollowRequests', 'showPostsToFollowers']) {
  assert(user.includes(`'${field}'`) || user.includes(`.${field}`), `privacy endpoint must accept ${field}`);
}
assert(presencePrivacy.includes("'privacy-settings-updated'"));
assert(user.includes('invalidateUserCache(req.user._id)'));
assert(user.includes('FollowRequest.updateMany'));
assert(user.includes('Follow.deleteMany'));
assert(user.includes("followStatus: 'pending'"));
assert(user.includes('privacyAccess: privacyRelationship.access') || user.includes('...privacyRelationship.access'));
assert(user.includes('req.body.profileVisibility !== undefined\n        ? { profileVisibility: req.body.profileVisibility }'));
assert(user.includes('req.body.allowMessageFrom !== undefined\n        ? { allowMessageFrom: req.body.allowMessageFrom }'));

for (const endpoint of [
  '/follow-requests/incoming',
  '/follow-requests/:requestId/accept',
  '/follow-requests/:requestId/reject'
]) assert(modularRoutes.includes(endpoint));

for (const functionName of [
  'recordClipView', 'getPost', 'toggleLike', 'addComment', 'recordShare',
  'toggleSave', 'getSavedPosts', 'getLikedPosts', 'reportPost', 'trackInteraction'
]) assert(post.includes(`const ${functionName}`), `${functionName} must remain mounted`);
assert((post.match(/requireVisiblePost\(req, res/g) || []).length >= 8, 'post reads and mutations must share server authorization');
assert(post.includes('filterPostsForViewer(posts, req.user)'));
assert(post.includes('filterPostsForViewer(candidatePosts, req.user)'));

assert(recommendation.includes("'privacySettings.profileVisibility': { $exists: true, $ne: 'public' }"));
assert(recommendation.includes("'privacySettings.showPostsToFollowers': { $exists: true, $ne: true }"));
assert(recommendation.includes("'privacySettings.accountType': { $exists: true, $ne: 'public' }"));
assert(story.includes('resolvePrivacyAccess({ viewer'));
assert(story.includes('rejectStoryPrivacy'));
assert(message.includes('resolvePostAccess({ post, viewer: req.user })'));
assert(message.includes('RECIPIENT_POST_PRIVACY_RESTRICTED'));
assert(message.includes('GROUP_POST_PRIVACY_RESTRICTED'));
assert(message.includes('filterPostsForViewer(sharedPosts, req.user)'));
assert(message.includes('MESSAGE_ACCESS_DENIED'));
assert(message.includes('existingConversation'));
assert(message.includes("reason: 'not_follower'") || message.includes("? 'not_follower'"));
assert(call.includes('CALL_PRIVACY_RESTRICTED'));
assert(legacySocket.includes('CALL_PRIVACY_RESTRICTED'));
assert(recruitment.includes('viewerId: req.user?._id'));
assert(recruitment.includes('const teamPrivacy = await resolvePrivacyAccess'));
assert(recruitment.includes('const playerPrivacy = await resolvePrivacyAccess'));
assert(chatService.includes('assertParticipant'));
assert(dto.includes('delete dto.lastSeen'));
assert(dto.includes('delete dto.privacySettings'));
assert(followModel.includes("privacySettings: '$user.privacySettings'"));
assert(followModel.includes("{ $match: { 'user.isActive': true } }"));
assert(migration.includes("process.argv.includes('--apply')"));
assert(migration.includes("process.argv.includes('--verify')"));
assert(migration.includes('inconsistent canonical and legacy privacy fields'));
assert(migration.includes('auditAcceptedFollowRelationships'));
assert(migration.includes('reciprocal legacy relationships'));
assert(migration.includes('await verifyIndexes(Follow)'));
assert(profileCache.includes('invalidateProfileCache'));
assert(auth.includes('invalidateProfileCache(userId, req.user.username, user.username)'));
assert(admin.includes('invalidateProfileCache(userId, user.username)'));
assert(presence.includes('resolvePrivacyAccess'));
assert(presence.includes('presence:subscribe'));
assert(presence.includes('canSeeOnlineStatus'));
assert(socket.includes('registerPresenceSocketHandlers'));
assert(legacyMiddleware.includes('privacyResponseHeaders'));
assert(legacyMiddleware.includes('private, no-store, no-cache, must-revalidate'));
assert(legacyMiddleware.includes('res.vary("Authorization")'));
assert(user.includes('evictPresenceAudience(io, req.user._id)'));
assert(user.includes('publishPrivacySettingsUpdate(io, req.user._id)'));
assert(!user.includes("io?.emit?.('privacy-settings-updated'"));
assert(presencePrivacy.includes("io.to?.(userRoom(userId)).emit('privacy-settings-updated'"));
assert(presencePrivacy.includes("io.to?.(presenceRoom(userId)).emit('privacy-settings-updated'"));
assert(presencePrivacy.includes('socketsLeave?.(room)'));
assert(presencePrivacy.includes("io.to?.(viewerRoom).emit('presence:updated'"));
assert(presencePrivacy.includes('socketsLeave?.(presenceRoom(targetId))'));
assert(presencePrivacy.includes('hidden: true'));
assert(user.includes('findOneAndUpdate({') && user.includes("$set: { status, resolvedAt }"));

const addCommentStart = post.indexOf('const addComment');
const addCommentEnd = post.indexOf('const recordShare', addCommentStart);
const addCommentBody = post.slice(addCommentStart, addCommentEnd);
assert(addCommentBody.indexOf('requireVisiblePost') < addCommentBody.indexOf('Post.findOneAndUpdate'), 'comments must authorize before mutation');

console.log('privacy enforcement contract tests passed');
