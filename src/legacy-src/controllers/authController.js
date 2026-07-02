const User = require('../models/User');
const OtpVerification = require('../models/OtpVerification');
const Follow = require('../models/Follow');
const { generateToken, generateRefreshToken } = require('../utils/jwt');
const { uploadAvatar, uploadImage } = require('../utils/cloudinary');
const { sendOTPEmail } = require('../utils/email');
const log = require('../utils/logger');
const { invalidateUserCache } = require('../middleware/auth');
const { validateOnboardingProfile } = require('../utils/onboardingValidation');
const { recordSuccessfulLogin } = require('../utils/userLoginAudit');

const INVALID_LOGIN_MESSAGE = 'Invalid email or password.';

const sendAuthRateLimit = (res, limit) => {
  res.setHeader('Retry-After', String(limit.retryAfter));
  return res.status(429).json({
    success: false,
    message: limit.message,
    error: 'RATE_LIMIT_EXCEEDED',
    retryAfter: limit.retryAfter
  });
};

const sendInvalidLoginResponse = async (res) => {
  try {
    const limiter = res.locals?.progressiveAuthLimiter;
    if (limiter?.recordFailure) {
      const limit = await limiter.recordFailure();
      if (limit) {
        return sendAuthRateLimit(res, limit);
      }
    }
  } catch (error) {
    log.error('Login rate-limit failure tracking error:', { error: String(error) });
  }

  return res.status(401).json({
    success: false,
    message: INVALID_LOGIN_MESSAGE
  });
};

const resetLoginFailureCounters = async (res) => {
  try {
    await res.locals?.progressiveAuthLimiter?.reset?.();
  } catch (error) {
    log.error('Login rate-limit reset error:', { error: String(error) });
  }
};

const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'api',
  'app',
  'arc',
  'auth',
  'help',
  'login',
  'moderator',
  'official',
  'profile',
  'register',
  'root',
  'settings',
  'squadhunt',
  'support',
  'system',
  'team',
  'teams',
  'user',
  'users',
]);

const normalizeUsernameInput = (username) => String(username || '').replace(/\s/g, '').trim();

const validateUsernameCandidate = (username) => {
  if (!username) return 'Username is required';
  if (username.length < 3 || username.length > 20) return 'Username must be between 3 and 20 characters';
  if (!USERNAME_PATTERN.test(username)) return 'Username can only contain letters, numbers and underscores';
  if (RESERVED_USERNAMES.has(username.toLowerCase())) return 'This username is reserved';
  return '';
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildUsernameLookup = (username, excludeUserId) => {
  const query = {
    username: { $regex: `^${escapeRegex(username)}$`, $options: 'i' },
  };
  if (excludeUserId) query._id = { $ne: excludeUserId };
  return query;
};

const findExistingUsername = (username, excludeUserId) => {
  return User.findOne(buildUsernameLookup(username, excludeUserId)).select('_id username');
};

const isUsernameDuplicateError = (error) => {
  return error?.code === 11000 && (error?.keyPattern?.username || error?.keyValue?.username);
};

const sendUsernameDuplicate = (res) => {
  return res.status(400).json({
    success: false,
    message: 'Username is already taken'
  });
};

// Check username availability
const checkUsernameAvailability = async (req, res) => {
  try {
    const { username } = req.query;
    const cleanUsername = normalizeUsernameInput(username);
    const validationError = validateUsernameCandidate(cleanUsername);

    if (validationError) {
      return res.status(400).json({
        success: false,
        available: false,
        message: validationError
      });
    }

    // Check if username exists
    const existingUser = await findExistingUsername(cleanUsername);
    
    if (existingUser) {
      return res.json({
        success: true,
        available: false,
        message: 'Username is already taken'
      });
    }

    return res.json({
      success: true,
      available: true,
      message: 'Username is available'
    });
  } catch (error) {
    log.error('Username availability check error:', { error: String(error) });
    return res.status(500).json({
      success: false,
      available: false,
      message: 'Error checking username availability'
    });
  }
};

// Check email availability
const checkEmailAvailability = async (req, res) => {
  try {
    const { email } = req.query;

    if (!email || email.trim().length === 0) {
      return res.status(400).json({
        success: false,
        available: false,
        message: 'Email is required'
      });
    }

    const cleanEmail = email.toLowerCase();

    const existingUser = await User.findOne({ email: cleanEmail });

    if (existingUser) {
      return res.json({
        success: true,
        available: false,
        message: 'Email is already in use'
      });
    }

    return res.json({
      success: true,
      available: true,
      message: 'Email is available'
    });
  } catch (error) {
    log.error('Email availability check error:', { error: String(error) });
    return res.status(500).json({
      success: false,
      available: false,
      message: 'Error checking email availability'
    });
  }
};

// Register new user
const register = async (req, res) => {
  try {
    let { username, email, password, userType, displayName, bio, gender, dob, location, website, otp } = req.body;
    
    username = normalizeUsernameInput(username);
    email = String(email || '').trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid email'
      });
    }

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    const usernameValidationError = validateUsernameCandidate(username);
    if (usernameValidationError) {
      return res.status(400).json({
        success: false,
        message: usernameValidationError
      });
    }

    const onboardingProfile = validateOnboardingProfile({ userType, displayName, gender, dob, bio });
    if (onboardingProfile.error) {
      return res.status(400).json({
        success: false,
        message: onboardingProfile.error
      });
    }

    ({ userType, displayName, gender, dob, bio } = onboardingProfile.value);

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, buildUsernameLookup(username)]
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email or username already exists'
      });
    }

    // Verify email OTP for registration
    if (!otp || String(otp).trim().length !== 6) {
      return res.status(400).json({
        success: false,
        message: 'Please verify your email with the 6-digit OTP'
      });
    }

    const otpRecord = await OtpVerification.findOne({
      email: email.toLowerCase(),
      otp: String(otp).trim(),
      purpose: 'register',
      used: false,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (!otpRecord) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP for this email'
      });
    }

    otpRecord.used = true;
    await otpRecord.save();

    // Handle avatar upload if provided
    let avatarData = {};
    if (req.file) {
      try {
        const uploadResult = await uploadAvatar(req.file);
        avatarData.avatar = uploadResult.url;
      } catch (uploadError) {
        return res.status(400).json({
          success: false,
          message: 'Failed to upload avatar',
          error: uploadError.message
        });
      }
    }

    // Create new user
    const userData = {
      username,
      email,
      password,
      userType,
      profile: {
        displayName,
        bio,
        gender,
        dob,
        location: location || '',
        website: website || '',
        ...avatarData
      }
    };

    // Initialize type-specific fields
    if (userType === 'player') {
      userData.playerInfo = {
        games: [],
        achievements: [],
        lookingForTeam: false,
        preferredRoles: [],
        skillLevel: 'beginner'
      };
    } else if (userType === 'team') {
      userData.teamInfo = {
        teamSize: 0,
        recruitingFor: [],
        requirements: '',
        teamType: 'casual',
        members: []
      };
    }

    const user = await User.create(userData);

    // Generate tokens
    const token = generateToken({ id: user._id, username: user.username, userType: user.userType });
    const refreshToken = generateRefreshToken({ id: user._id });

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        user: userResponse,
        token,
        refreshToken
      }
    });

  } catch (error) {
    if (isUsernameDuplicateError(error)) {
      return sendUsernameDuplicate(res);
    }
    res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Check if new password matches old password (for forgot password flow)
const checkPasswordSame = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        isSame: false,
        message: 'Email and password are required'
      });
    }

    const cleanEmail = email.toLowerCase();
    const user = await User.findOne({ email: cleanEmail }).select('+password');

    if (!user || !user.password) {
      // User not found or no password set (e.g. Google-only user)
      return res.json({
        success: true,
        isSame: false
      });
    }

    const isSame = await user.comparePassword(password);

    return res.json({
      success: true,
      isSame
    });
  } catch (error) {
    log.error('Check password same error:', { error: String(error) });
    return res.status(500).json({
      success: false,
      isSame: false,
      message: 'Failed to check password'
    });
  }
};

// Reset password using email + OTP (forgot password flow)
const resetPasswordWithOtp = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Email, OTP and new password are required'
      });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    const cleanEmail = email.toLowerCase();
    const user = await User.findOne({ email: cleanEmail }).select('+password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email'
      });
    }

    const record = await OtpVerification.findOne({
      email: cleanEmail,
      otp: String(otp).trim(),
      purpose: 'forgot_password',
      used: false,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (!record) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP'
      });
    }

    // Prevent using the same password again
    if (user.password) {
      try {
        const isSamePassword = await user.comparePassword(newPassword);
        if (isSamePassword) {
          return res.status(400).json({
            success: false,
            message: 'New password must be different from your previous password'
          });
        }
      } catch (compareError) {
        log.error('Password compare error (resetPasswordWithOtp):', { error: String(compareError) });
        return res.status(500).json({
          success: false,
          message: 'Failed to reset password. Please try again.'
        });
      }
    }

    // mark OTP as used
    record.used = true;
    await record.save();

    // update password (pre-save hook will hash it)
    user.password = newPassword;
    await user.save();

    return res.status(200).json({
      success: true,
      message: 'Password reset successfully. You can now login with your new password.'
    });
  } catch (error) {
    log.error('Reset password with OTP error:', { error: String(error) });
    return res.status(500).json({
      success: false,
      message: 'Failed to reset password',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Login user
const login = async (req, res) => {
  try {
    const { email, username, password } = req.body;
    
    // Log mobile device info for debugging
    const userAgent = req.headers['user-agent'] || '';
    const isMobile = /Mobile|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
    const origin = req.headers.origin || 'no-origin';
    
    if (process.env.NODE_ENV === 'development') { console.log(`Login attempt - Mobile: ${isMobile}, Origin: ${origin}, User-Agent: ${userAgent.substring(0, 50)}...`);
}
    // Validate input - either email or username must be provided
    if ((!email && !username) || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email or username and password'
      });
    }

    // Check database connection
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      console.error('Database not connected. Ready state:', mongoose.connection.readyState);
      return res.status(500).json({
        success: false,
        message: 'Database connection error. Please try again later.'
      });
    }

    // Find user by email or username and include password for comparison
    const query = email ? { email } : { username };
    const user = await User.findOne(query).select('+password');

    if (!user) {
      return sendInvalidLoginResponse(res);
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated. Please contact support.'
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return sendInvalidLoginResponse(res);
    }

    await resetLoginFailureCounters(res);

    // Update last seen
    user.lastSeen = new Date();
    await user.save();

    // Generate tokens
    const token = generateToken({ id: user._id, username: user.username, userType: user.userType });
    const refreshToken = generateRefreshToken({ id: user._id });

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    void recordSuccessfulLogin({ user, authMethod: 'password', request: req });

    // Log successful login
    if (process.env.NODE_ENV === 'development') { console.log(`Login successful - User: ${user.username}, Mobile: ${isMobile}, Origin: ${origin}`);
}
    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: userResponse,
        token,
        refreshToken
      }
    });

  } catch (error) {
    log.error('Login error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

// Get current user profile
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('followers', 'username profile.displayName profile.avatar')
      .populate('following', 'username profile.displayName profile.avatar');

    const userResponse = user.toObject();
    userResponse.followersCount = await Follow.getFollowerCount(user._id).catch(() => user.followers?.length || 0);
    userResponse.followingCount = await Follow.getFollowingCount(user._id).catch(() => user.following?.length || 0);

    res.status(200).json({
      success: true,
      data: {
        user: userResponse
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get user profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update user profile
const updateProfile = async (req, res) => {
  try {
    const updates = req.body;
    const userId = req.user._id;

    ['gamingPreferences', 'socialLinks', 'playerInfo', 'teamInfo'].forEach((key) => {
      if (typeof updates[key] !== 'string') return;
      try {
        updates[key] = JSON.parse(updates[key]);
      } catch {
        // Keep the original scalar value so existing clients are not broken.
      }
    });
    
    // Normalize and validate username if provided.
    if (updates.username !== undefined) {
      updates.username = normalizeUsernameInput(updates.username);
      if (updates.username !== req.user.username) {
        const usernameValidationError = validateUsernameCandidate(updates.username);
        if (usernameValidationError) {
          return res.status(400).json({
            success: false,
            message: usernameValidationError
          });
        }
      }
    }

    // Handle avatar upload if provided
    if (req.file) {
      try {
        const uploadResult = await uploadAvatar(req.file);
        updates['profile.avatar'] = uploadResult.url;
      } catch (uploadError) {
        return res.status(400).json({
          success: false,
          message: 'Failed to upload avatar',
          error: uploadError.message
        });
      }
    }

    // Build update object for nested fields
    const updateObject = {};
    
    // Handle username update with uniqueness check
    if (updates.username && updates.username !== req.user.username) {
      // Check if username is already taken
      const existingUser = await findExistingUsername(updates.username, userId);
      if (existingUser) {
        return sendUsernameDuplicate(res);
      }
      updateObject.username = updates.username;
    }
    
    // Handle profile updates
    if (updates.displayName) updateObject['profile.displayName'] = updates.displayName;
    if (updates.bio !== undefined) updateObject['profile.bio'] = updates.bio;
    if (updates.gender !== undefined) updateObject['profile.gender'] = updates.gender;
    if (updates.dob !== undefined) updateObject['profile.dob'] = updates.dob ? new Date(updates.dob) : null;
    if (updates.location !== undefined) updateObject['profile.location'] = updates.location;
    if (updates.website !== undefined) updateObject['profile.website'] = updates.website;
    if (updates['profile.avatar']) updateObject['profile.avatar'] = updates['profile.avatar'];
    if (updates.banner !== undefined) updateObject['profile.banner'] = updates.banner;
    if (updates.gamingPreferences !== undefined) updateObject['profile.gamingPreferences'] = updates.gamingPreferences;
    if (updates.socialLinks !== undefined) updateObject['profile.socialLinks'] = updates.socialLinks;

    // Handle player-specific updates
    if (req.user.userType === 'player' && updates.playerInfo) {
      Object.keys(updates.playerInfo).forEach(key => {
        updateObject[`playerInfo.${key}`] = updates.playerInfo[key];
      });
    }

    // Handle team-specific updates
    if (req.user.userType === 'team' && updates.teamInfo) {
      Object.keys(updates.teamInfo).forEach(key => {
        updateObject[`teamInfo.${key}`] = updates.teamInfo[key];
      });
    }

    const user = await User.findByIdAndUpdate(
      userId,
      updateObject,
      { new: true, runValidators: true }
    ).populate('followers', 'username profile.displayName profile.avatar')
     .populate('following', 'username profile.displayName profile.avatar');

    const userResponse = user.toObject();
    userResponse.followersCount = await Follow.getFollowerCount(user._id).catch(() => user.followers?.length || 0);
    userResponse.followingCount = await Follow.getFollowingCount(user._id).catch(() => user.following?.length || 0);

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: userResponse
      }
    });

  } catch (error) {
    if (isUsernameDuplicateError(error)) {
      return sendUsernameDuplicate(res);
    }
    res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Change password
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide current password and new password'
      });
    }

    // Get user with password
    const user = await User.findById(req.user._id).select('+password');

    // Verify current password
    const isCurrentPasswordValid = await user.comparePassword(currentPassword);

    if (!isCurrentPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to change password',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Upload profile picture
const uploadProfilePicture = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }

    // Upload image to cloudinary
    const uploadResult = await uploadAvatar(req.file);

    // Update user's profile with new avatar
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { 'profile.avatar': uploadResult.url },
      { new: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      message: 'Profile picture uploaded successfully',
      data: {
        imageUrl: uploadResult.url,
        user
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to upload profile picture',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Upload banner
const uploadBanner = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }

    // Upload banner to cloudinary with different settings
    const uploadResult = await uploadImage(req.file, 'gaming-social/banners');

    // Update user's profile with new banner
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { 'profile.banner': uploadResult.url },
      { new: true }
    ).select('-password');

    res.status(200).json({
      success: true,
      message: 'Banner uploaded successfully',
      data: {
        imageUrl: uploadResult.url,
        user
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to upload banner',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete user account
const deleteAccount = async (req, res) => {
  try {
    const userId = req.user._id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'Password is required to delete account'
      });
    }

    // Get user with password for verification
    const user = await User.findById(userId).select('+password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid password'
      });
    }

    // Mark user as inactive instead of hard delete to preserve data integrity
    user.isActive = false;
    user.deletedAt = new Date();
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete account',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Logout user (client-side token removal)
const logout = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Logout failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Complete the provider-neutral onboarding profile for an OAuth account.
const completeProfile = async (req, res) => {
  try {
    const userId = req.user._id;
    let { userType, username, displayName, gender, dob, bio } = req.body;
    username = normalizeUsernameInput(username);

    // Get user
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if user needs profile completion
    if (!user.needsProfileCompletion) {
      return res.status(400).json({
        success: false,
        message: 'Profile already completed'
      });
    }

    const onboardingProfile = validateOnboardingProfile({ userType, displayName, gender, dob, bio });
    if (onboardingProfile.error) {
      return res.status(400).json({
        success: false,
        message: onboardingProfile.error
      });
    }

    ({ userType, displayName, gender, dob, bio } = onboardingProfile.value);

    // Validate username
    const usernameValidationError = validateUsernameCandidate(username);
    if (usernameValidationError) {
      return res.status(400).json({
        success: false,
        message: usernameValidationError
      });
    }

    // Check if username is already taken by another user
    const existingUser = await findExistingUsername(username, userId);

    if (existingUser) {
      return sendUsernameDuplicate(res);
    }

    // Authentication providers establish identity. Profile completion only
    // applies the same profile fields collected during OTP registration.
    user.userType = userType;
    user.username = username;
    user.profile = user.profile || {};
    user.profile.displayName = displayName;
    user.profile.gender = gender;
    user.profile.dob = dob;
    user.profile.bio = bio;
    user.needsProfileCompletion = false;

    // Initialize type-specific fields if not already set
    if (userType === 'player' && !user.playerInfo) {
      user.playerInfo = {
        games: [],
        achievements: [],
        lookingForTeam: false,
        preferredRoles: [],
        skillLevel: 'beginner'
      };
    } else if (userType === 'team' && !user.teamInfo) {
      user.teamInfo = {
        teamSize: 0,
        recruitingFor: [],
        requirements: '',
        teamType: 'casual',
        members: []
      };
    }

    await user.save();
    await invalidateUserCache(userId);

    // Generate new token with updated username
    const token = generateToken({ id: user._id, username: user.username, userType: user.userType });
    const refreshToken = generateRefreshToken({ id: user._id });

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(200).json({
      success: true,
      message: 'Profile completed successfully',
      profileComplete: true,
      data: {
        user: userResponse,
        token,
        refreshToken
      }
    });

  } catch (error) {
    if (isUsernameDuplicateError(error)) {
      return sendUsernameDuplicate(res);
    }
    res.status(500).json({
      success: false,
      message: 'Failed to complete profile',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Compatibility wrapper for deployed clients that predate the shared
// onboarding form. Their OAuth account already has a provider display name.
const completeGoogleProfile = (req, res) => {
  if (!String(req.body?.displayName || '').trim()) {
    req.body = {
      ...req.body,
      displayName: req.user?.profile?.displayName || ''
    };
  }
  return completeProfile(req, res);
};

// Send OTP to email (for login / forgot password / register verification)
const sendOtp = async (req, res) => {
  try {
    const { email, purpose = 'login' } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Valid email is required' });
    }
    const allowedPurposes = ['login', 'register', 'forgot_password'];
    if (!allowedPurposes.includes(purpose)) {
      return res.status(400).json({ success: false, message: 'Invalid purpose' });
    }
    if (purpose === 'login') {
      const user = await User.findOne({ email: normalizedEmail });
      if (!user) {
        return res.status(404).json({ success: false, message: 'No account found with this email' });
      }
    }
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    await OtpVerification.deleteMany({ email: normalizedEmail, purpose });
    await OtpVerification.create({
      email: normalizedEmail,
      otp,
      purpose,
      expiresAt
    });
    const result = await sendOTPEmail(normalizedEmail, otp, purpose);
    if (!result.sent) {
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please check email config or try again.'
      });
    }
    res.status(200).json({
      success: true,
      message: 'OTP sent to your email. Valid for 10 minutes.'
    });
  } catch (error) {
    log.error('Send OTP error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Verify OTP for register (no login)
const verifyOtpForRegister = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Email is already in use' });
    }

    const record = await OtpVerification.findOne({
      email: email.toLowerCase(),
      otp: String(otp).trim(),
      purpose: 'register',
      used: false,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (!record) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    return res.status(200).json({
      success: true,
      message: 'Email verified successfully'
    });
  } catch (error) {
    log.error('Verify OTP register error:', { error: String(error) });
    return res.status(500).json({
      success: false,
      message: 'Verification failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Verify OTP and login (returns token if purpose is login and email exists)
const verifyOtpAndLogin = async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP are required' });
    }
    const record = await OtpVerification.findOne({
      email: email.toLowerCase(),
      otp: String(otp).trim(),
      used: false,
      expiresAt: { $gt: new Date() }
    }).sort({ createdAt: -1 });
    if (!record) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }
    record.used = true;
    await record.save();
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found. Please register first.' });
    }
    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Account is deactivated.' });
    }
    user.lastSeen = new Date();
    await user.save();
    const token = generateToken({ id: user._id, username: user.username, userType: user.userType });
    const refreshToken = generateRefreshToken({ id: user._id });
    const userResponse = user.toObject();
    delete userResponse.password;
    void recordSuccessfulLogin({ user, authMethod: 'otp', request: req });
    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        user: userResponse,
        token,
        refreshToken
      }
    });
  } catch (error) {
    log.error('Verify OTP error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Verification failed',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Generate Guest Token
const generateGuestToken = async (req, res) => {
  try {
    const { v4: uuidv4 } = require('uuid');
    const guestId = `guest_${uuidv4()}`;
    
    // Generate token with role guest (userType: 'guest')
    // The id is also pseudo-random to track specific guest sessions if needed
    const token = generateToken({ id: guestId, username: 'Guest', userType: 'guest' });

    res.status(200).json({
      success: true,
      message: 'Guest token generated successfully',
      data: {
        token,
        guestId
      }
    });
  } catch (error) {
    log.error('Guest token generation error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to generate guest token'
    });
  }
};

const googleTokenLogin = async (req, res) => {
  try {
    const { access_token } = req.body;
    if (!access_token) {
      return res.status(400).json({ success: false, message: 'access_token is required' });
    }

    const axios = require('axios');
    const { data: profile } = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const email = profile.email?.toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email not provided by Google' });
    }

    let user = await User.findOne({ email });

    if (user?.userType === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin accounts must sign in through the dedicated Admin Portal.'
      });
    }

    if (user && !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account is deactivated.'
      });
    }

    if (!user) {
      const { uploadAvatarFromUrl } = require('../utils/cloudinary');
      let avatarUrl = profile.picture || '';
      if (profile.picture) {
        try {
          const uploaded = await uploadAvatarFromUrl(profile.picture);
          avatarUrl = uploaded.url;
        } catch (_) {
          avatarUrl = profile.picture;
        }
      }

      const randomStr = Math.random().toString(36).substring(2, 10) + Date.now().toString(36).substring(2, 10);
      let baseUsername = `g_${randomStr.substring(0, 14)}`;
      let checkUser = await User.findOne({ username: baseUsername });
      let finalUsername = baseUsername;
      let counter = 1;
      while (checkUser && counter < 1000) {
        const maxLen = 18 - counter.toString().length;
        finalUsername = `g_${randomStr.substring(0, maxLen)}${counter}`;
        if (finalUsername.length > 20) finalUsername = finalUsername.substring(0, 20);
        checkUser = await User.findOne({ username: finalUsername });
        counter++;
      }

      user = await User.create({
        email,
        googleId: profile.sub,
        username: finalUsername,
        password: require('crypto').randomBytes(32).toString('hex'),
        userType: 'player',
        profile: {
          displayName: profile.name || email.split('@')[0],
          avatar: avatarUrl
        },
        needsProfileCompletion: true,
        isActive: true
      });
    } else {
      user.lastSeen = new Date();
      await user.save();
    }

    const token = generateToken({ id: user._id, username: user.username, userType: user.userType });
    const refreshToken = generateRefreshToken({ id: user._id });

    const userResponse = user.toObject();
    delete userResponse.password;

    void recordSuccessfulLogin({ user, authMethod: 'google_token', request: req });

    return res.json({
      success: true,
      token,
      refreshToken,
      user: userResponse,
      data: {
        token,
        refreshToken,
        user: userResponse
      },
      profileComplete: !user.needsProfileCompletion
    });
  } catch (error) {
    log.error('Google token login error:', { error: String(error) });
    return res.status(500).json({ success: false, message: 'Google login failed' });
  }
};

const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
let appleKeyCache = {
  expiresAt: 0,
  keys: []
};

const getAppleSigningKey = async (kid) => {
  const now = Date.now();
  if (!appleKeyCache.keys.length || appleKeyCache.expiresAt < now) {
    const axios = require('axios');
    const { data } = await axios.get(APPLE_KEYS_URL, { timeout: 5000 });
    appleKeyCache = {
      keys: Array.isArray(data.keys) ? data.keys : [],
      expiresAt: now + 60 * 60 * 1000
    };
  }

  const jwk = appleKeyCache.keys.find((key) => key.kid === kid);
  if (!jwk) {
    throw new Error('Apple signing key not found');
  }

  const crypto = require('crypto');
  return crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({
    type: 'spki',
    format: 'pem'
  });
};

const verifyAppleIdentityToken = async (identityToken) => {
  const jwt = require('jsonwebtoken');
  const decoded = jwt.decode(identityToken, { complete: true });
  const kid = decoded?.header?.kid;
  if (!kid) {
    throw new Error('Invalid Apple identity token header');
  }

  const publicKey = await getAppleSigningKey(kid);
  const audience = process.env.APPLE_BUNDLE_ID || process.env.IOS_BUNDLE_ID || 'com.arcSquadHunt';

  return jwt.verify(identityToken, publicKey, {
    algorithms: ['RS256'],
    issuer: 'https://appleid.apple.com',
    audience
  });
};

const appleMobileLogin = async (req, res) => {
  try {
    const { identityToken, displayName, nonce } = req.body;
    if (!identityToken) {
      return res.status(400).json({ success: false, message: 'identityToken is required' });
    }

    const profile = await verifyAppleIdentityToken(identityToken);
    if (nonce && profile.nonce !== nonce) {
      return res.status(401).json({ success: false, message: 'Apple login failed' });
    }

    const appleId = profile.sub;
    const tokenEmail = typeof profile.email === 'string' ? profile.email.toLowerCase() : '';
    const emailVerified = profile.email_verified === true || profile.email_verified === 'true' || !tokenEmail;

    if (!appleId) {
      return res.status(400).json({ success: false, message: 'Apple identity token is missing a subject' });
    }

    if (!emailVerified) {
      return res.status(400).json({ success: false, message: 'Apple email is not verified' });
    }

    let user = await User.findOne({ appleId });
    if (!user && tokenEmail) {
      user = await User.findOne({ email: tokenEmail });
    }

    if (user?.userType === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin accounts must sign in through the dedicated Admin Portal.'
      });
    }

    if (!user && !tokenEmail) {
      return res.status(400).json({
        success: false,
        message: 'Apple did not provide an email for this account. Please sign in with the same Apple account again or use another login method.'
      });
    }

    if (!user) {
      const randomStr = Math.random().toString(36).substring(2, 10) + Date.now().toString(36).substring(2, 10);
      let finalUsername = `a_${randomStr.substring(0, 14)}`;
      let checkUser = await User.findOne({ username: finalUsername });
      let counter = 1;
      while (checkUser && counter < 1000) {
        const maxLen = 18 - counter.toString().length;
        finalUsername = `a_${randomStr.substring(0, maxLen)}${counter}`;
        if (finalUsername.length > 20) finalUsername = finalUsername.substring(0, 20);
        checkUser = await User.findOne({ username: finalUsername });
        counter++;
      }

      try {
        user = await User.create({
          email: tokenEmail,
          appleId,
          username: finalUsername,
          password: require('crypto').randomBytes(32).toString('hex'),
          userType: 'player',
          profile: {
            displayName: displayName || tokenEmail.split('@')[0],
            avatar: ''
          },
          needsProfileCompletion: true,
          isActive: true
        });
      } catch (createError) {
        const duplicateAppleOrEmail =
          createError?.code === 11000 &&
          (createError?.keyPattern?.appleId ||
            createError?.keyPattern?.email ||
            createError?.keyValue?.appleId ||
            createError?.keyValue?.email);

        if (!duplicateAppleOrEmail) throw createError;

        user = await User.findOne({
          $or: [
            { appleId },
            ...(tokenEmail ? [{ email: tokenEmail }] : [])
          ]
        });
        if (!user) throw createError;
        if (user.userType === 'admin') {
          return res.status(403).json({
            success: false,
            message: 'Admin accounts must sign in through the dedicated Admin Portal.'
          });
        }
        if (!user.appleId) user.appleId = appleId;
        user.lastSeen = new Date();
        await user.save();
      }
    } else {
      if (!user.appleId) user.appleId = appleId;
      user.lastSeen = new Date();
      await user.save();
    }

    // Re-check after duplicate-key recovery in case a concurrent request linked
    // this provider identity to an admin account.
    if (user.userType === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Admin accounts must sign in through the dedicated Admin Portal.'
      });
    }

    if (!user.isActive) {
      return res.status(401).json({ success: false, message: 'Account is deactivated.' });
    }

    const token = generateToken({ id: user._id, username: user.username, userType: user.userType });
    const refreshToken = generateRefreshToken({ id: user._id });
    const userResponse = user.toObject();
    delete userResponse.password;

    void recordSuccessfulLogin({ user, authMethod: 'apple_mobile', request: req });

    return res.json({
      success: true,
      token,
      refreshToken,
      user: userResponse,
      data: {
        token,
        refreshToken,
        user: userResponse
      },
      profileComplete: !user.needsProfileCompletion
    });
  } catch (error) {
    log.error('Apple mobile login error:', { error: String(error) });
    return res.status(401).json({ success: false, message: 'Apple login failed' });
  }
};

module.exports = {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  deleteAccount,
  logout,
  uploadProfilePicture,
  uploadBanner,
  completeProfile,
  completeGoogleProfile,
  checkUsernameAvailability,
  checkEmailAvailability,
  sendOtp,
  verifyOtpForRegister,
  verifyOtpAndLogin,
  resetPasswordWithOtp,
  checkPasswordSame,
  generateGuestToken,
  googleTokenLogin,
  appleMobileLogin
};
