'use strict';

// Social preview crawlers resolve metadata through the public read endpoints.
// Those internal reads must not inflate user-facing profile/recruitment views.
const markSocialPreviewRequest = (req, _res, next) => {
  // This flag is assigned by a dedicated server route, never from a
  // client-controlled request header.
  req.socialPreviewRequest = true;
  next();
};

const isSocialPreviewRequest = req => req?.socialPreviewRequest === true;

module.exports = { isSocialPreviewRequest, markSocialPreviewRequest };
