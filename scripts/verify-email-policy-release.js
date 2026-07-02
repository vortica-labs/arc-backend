#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePolicy = require(path.join(root, 'src', 'legacy-src', 'utils', 'notificationChannelPolicy.js'));
const builtPolicy = require(path.join(root, 'dist', 'legacy-src', 'utils', 'notificationChannelPolicy.js'));

const serializeAllowlist = (policy) => Object.fromEntries(
  Object.entries(policy.ALLOWED_EMAIL_EVENTS).map(([intent, events]) => [intent, [...events]])
);

assert.deepEqual(
  serializeAllowlist(builtPolicy),
  serializeAllowlist(sourcePolicy),
  'generated and canonical email allowlists differ'
);

for (const [intent, events] of Object.entries(sourcePolicy.ALLOWED_EMAIL_EVENTS)) {
  assert(events.length > 0, `${intent} has no registered transactional events`);
  assert.equal(sourcePolicy.evaluateEmailPolicy({ intent }).allowed, false);
  assert.equal(sourcePolicy.evaluateEmailPolicy({ intent, eventType: 'unknown_activity_event' }).allowed, false);
  for (const eventType of events) {
    assert.equal(
      sourcePolicy.evaluateEmailPolicy({ intent, eventType }).allowed,
      true,
      `${intent}/${eventType} must remain authorized`
    );
  }
}

const routineEvents = [
  'post_like',
  'clip_like',
  'story_like',
  'post_comment',
  'comment_reply',
  'follow_request',
  'follow_acceptance',
  'post_share',
  'saved_post',
  'mention',
  'new_message',
  'voice_message',
  'image_message',
  'video_message',
  'group_message',
  'story_reply',
  'story_reaction',
  'story_view',
  'clip_comment',
  'clip_share',
  'tournament_registration',
  'tournament_match_update',
  'recruitment_application',
  'recruitment_application_accepted',
  'incoming_call',
  'missed_call',
  'random_connect_match_found'
];
for (const eventType of routineEvents) {
  for (const intent of Object.values(sourcePolicy.EMAIL_INTENTS)) {
    const result = sourcePolicy.evaluateEmailPolicy({ intent, eventType });
    assert.equal(result.allowed, false, `${eventType} escaped through ${intent}`);
  }
}

const transportPattern = /\b(?:enqueueEmail|sendNotificationEmail|sendTransactionalEmail|sendOTPEmail)\s*\(|\.sendMail\s*\(|require\(['"]nodemailer['"]\)/;
const socialFiles = [
  'controllers/postController.js',
  'controllers/messageController.js',
  'controllers/storyController.js',
  'controllers/userController.js',
  'controllers/tournamentController.js',
  'controllers/recruitmentController.js',
  'controllers/callController.js',
  'controllers/callSessionController.js',
  'controllers/randomConnectController.js',
  'services/callSessionService.js',
  'utils/notificationService.js'
];
for (const tree of ['src/legacy-src', 'dist/legacy-src']) {
  for (const relative of socialFiles) {
    const source = fs.readFileSync(path.join(root, tree, relative), 'utf8');
    assert.equal(
      transportPattern.test(source),
      false,
      `${tree}/${relative} unexpectedly owns email transport capability`
    );
  }
}

const builtQueue = fs.readFileSync(path.join(root, 'dist', 'infrastructure', 'jobs', 'queue.js'), 'utf8');
assert(builtQueue.includes('emailPolicy.evaluateEmailPolicy(context || {})'), 'email worker policy gate is missing');
assert(builtQueue.includes('emailPolicy.evaluateEmailPolicy(typedContext)'), 'email producer policy gate is missing');
assert(builtQueue.includes('backendRootPath'), 'compiled workers must use the canonical legacy source tree');
assert(!builtQueue.includes('path.resolve(__dirname, "..", "..", "legacy-src")'));

console.log('Email policy release artifact verification passed');
