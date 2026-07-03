/**
 * Drop-in replacement for the old Cloudinary utils.
 * All functions keep the same signatures and return shapes.
 * Actual uploads go to AWS S3 via src/infrastructure/storage/s3.ts
 */
const path = require('path');
// __dirname = src/legacy-src/utils — go 3 levels up to /app/, then into dist/infrastructure/storage/s3
const s3 = require(path.join(__dirname, '../../../dist/infrastructure/storage/s3'));

const uploadImage = (file, folder = 'gaming-social', options) =>
  s3.uploadImage(file, folder, options);

const uploadVideo = (file, folder = 'gaming-social') =>
  s3.uploadVideo(file, folder);

const uploadAudio = (file, folder = 'gaming-social/audio') =>
  s3.uploadAudio(file, folder);

const uploadAvatar = (file, folder = 'gaming-social/avatars') =>
  s3.uploadAvatar(file, folder);

const uploadAvatarFromUrl = (imageUrl, folder = 'gaming-social/avatars') =>
  s3.uploadAvatarFromUrl(imageUrl, folder);

const deleteFile = (publicId) =>
  s3.deleteFile(publicId);

const uploadMultipleFiles = (files, folder = 'gaming-social') =>
  s3.uploadMultipleFiles(files, folder);

module.exports = {
  uploadImage,
  uploadVideo,
  uploadAudio,
  uploadAvatar,
  uploadAvatarFromUrl,
  deleteFile,
  uploadMultipleFiles,
};
