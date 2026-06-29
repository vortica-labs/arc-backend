/**
 * Data Transfer Object formatting utilities
 * Securely strips out sensitive data before sending it to the client.
 */

const formatUserDTO = (user, isGuest = false, isSelf = false) => {
  if (!user) return null;
  
  // If we receive a mongoose model, convert to plain object
  const dto = typeof user.toObject === 'function' 
    ? user.toObject({ virtuals: true }) 
    : JSON.parse(JSON.stringify(user));

  // ALWAYS remove these highly sensitive fields from ANY response
  delete dto.password;
  delete dto.email;
  delete dto.googleId;
  delete dto.isSuperUser;

  // Prevent leaking who blocklists who unless requested by self
  if (!isSelf) {
    delete dto.blockedUsers;
  }

  if (isGuest) {
    // For guests, provide even stricter minimization
    // Compute lengths before deleting
    if (Array.isArray(dto.followers)) dto.followersCount = dto.followers.length;
    if (Array.isArray(dto.following)) dto.followingCount = dto.following.length;
    
    // We delete the actual arrays to save bandwidth and prevent scraping
    delete dto.followers;
    delete dto.following;
    delete dto.blockedUsers; 
    
    // Hide detailed team info from guests (they can just see public profile)
    if (dto.teamInfo && dto.teamInfo.members) {
       dto.teamInfo.membersCount = dto.teamInfo.members.length;
       delete dto.teamInfo.members;
    }
    
    if (dto.playerInfo && dto.playerInfo.joinedTeams) {
        delete dto.playerInfo.joinedTeams;
    }
  }

  return dto;
};

const getLikeUserId = (like) => {
  const user = like && (like.user?._id || like.user);
  return user ? String(user) : '';
};

const uniqueLikeCount = (likes) => {
  if (!Array.isArray(likes)) return 0;
  const ids = likes.map(getLikeUserId).filter(Boolean);
  return ids.length > 0 ? new Set(ids).size : likes.length;
};

const formatPostDTO = (post, isGuest = false, isAuthor = false) => {
  if (!post) return null;
  
  const dto = typeof post.toObject === 'function' 
    ? post.toObject({ virtuals: true }) 
    : JSON.parse(JSON.stringify(post));

  const rawViewCount = Number(dto.viewCount) || 0;
  const uniqueViewCount = Array.isArray(dto.viewedBy) ? dto.viewedBy.length : 0;
  const storedViewCount = Number(dto.views) || 0;
  dto.likeCount = uniqueLikeCount(dto.likes);
  dto.commentCount = Array.isArray(dto.comments) ? dto.comments.length : Number(dto.commentCount) || 0;
  dto.shareCount = Array.isArray(dto.shares) ? dto.shares.length : Number(dto.shareCount) || 0;
  dto.viewCount = Math.max(rawViewCount, storedViewCount, uniqueViewCount);

  // ALWAYS remove reports and precise viewing history unless author/admin
  delete dto.reports;
  if (!isAuthor) {
    delete dto.viewedBy;
  }

  // Populate actual author if it's an expanded object, sanitize it too
  if (dto.author && typeof dto.author === 'object' && dto.author.username) {
    dto.author = formatUserDTO(dto.author, isGuest);
  }

  if (isGuest) {
    // Keep likes/comments arrays small for guests to prevent user enumeration
    // The virtual count properties (likeCount, commentCount) remain intact via Mongoose virtuals
    if (Array.isArray(dto.likes)) {
        dto.likes = dto.likes.slice(0, 3); // Only show top 3 likes
    }
    if (Array.isArray(dto.comments)) { // Comments might contain nested user objects
        dto.comments = dto.comments.slice(0, 3).map(comment => {
            if (comment.user && typeof comment.user === 'object') {
                comment.user = formatUserDTO(comment.user, true);
            }
            return comment;
        }); 
    }
  } else {
      // Clean up extended user info in comments even for logged in users
      if (Array.isArray(dto.comments)) {
        dto.comments = dto.comments.map(comment => {
            if (comment.user && typeof comment.user === 'object') {
                comment.user = formatUserDTO(comment.user, false);
            }
            return comment;
        });
      }
      if (Array.isArray(dto.likes)) {
        dto.likes = dto.likes.map(like => {
            if (like.user && typeof like.user === 'object') {
                like.user = formatUserDTO(like.user, false);
            }
            return like;
        });
      }
  }

  return dto;
};

module.exports = {
  formatUserDTO,
  formatPostDTO
};
