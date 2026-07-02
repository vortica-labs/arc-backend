const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourceRoot = path.resolve(__dirname, '..', '..');
const allowedEmailCapabilityFiles = new Set([
  'server.ts',
  'infrastructure/jobs/queue.ts',
  'legacy-src/controllers/authController.js',
  'legacy-src/services/premiumMembershipService.js',
  'legacy-src/utils/email.js',
  'legacy-src/utils/jobQueue.js',
  'legacy-src/utils/notificationEmitter.js',
  'legacy-src/utils/securityEmail.js'
]);

const emailCapabilityPatterns = [
  /require\(['"]nodemailer['"]\)/,
  /\bcreateTransport\s*\(/,
  /\.sendMail\s*\(/,
  /\benqueueEmail\s*\(/,
  /\bsendOTPEmail\s*\(/,
  /\bsendNotificationEmail\s*\(/,
  /\bsendTransactionalEmail\s*\(/,
  /\bemailQueue\.add\s*\(/
];

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) return walk(absolute);
  if (!/\.(?:js|ts)$/.test(entry.name) || /\.test\.(?:js|ts)$/.test(entry.name)) return [];
  return [absolute];
});

const violations = [];
for (const absolute of walk(sourceRoot)) {
  const relative = path.relative(sourceRoot, absolute).split(path.sep).join('/');
  const source = fs.readFileSync(absolute, 'utf8');
  if (emailCapabilityPatterns.some((pattern) => pattern.test(source)) && !allowedEmailCapabilityFiles.has(relative)) {
    violations.push(relative);
  }
}
assert.deepEqual(
  violations,
  [],
  `new email-capable files require an explicit transactional review: ${violations.join(', ')}`
);

const socialProducerFiles = [
  'legacy-src/controllers/postController.js',
  'legacy-src/controllers/messageController.js',
  'legacy-src/controllers/storyController.js',
  'legacy-src/controllers/userController.js',
  'legacy-src/controllers/tournamentController.js',
  'legacy-src/controllers/recruitmentController.js',
  'legacy-src/controllers/callController.js',
  'legacy-src/controllers/callSessionController.js',
  'legacy-src/controllers/randomConnectController.js',
  'legacy-src/controllers/randomConnectionController.js',
  'legacy-src/controllers/randomConnectionControllerNew.js',
  'legacy-src/services/callSessionService.js',
  'legacy-src/utils/notificationService.js'
];
for (const relative of socialProducerFiles) {
  const source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
  assert(
    !emailCapabilityPatterns.some((pattern) => pattern.test(source)),
    `${relative} must remain in-app/push only and cannot own email transport capability`
  );
}

const socialTemplateName = /(?:like|comment|reply|follow|message|story|mention|clip|recruitment|tournament|random.connect|call).*(?:email|mail)|(?:email|mail).*(?:like|comment|reply|follow|message|story|mention|clip|recruitment|tournament|random.connect|call)/i;
const socialTemplateFiles = walk(sourceRoot)
  .map((absolute) => path.relative(sourceRoot, absolute).split(path.sep).join('/'))
  .filter((relative) => socialTemplateName.test(path.basename(relative)) && !relative.endsWith('.test.js'));
assert.deepEqual(socialTemplateFiles, [], 'social email templates must remain removed');

console.log('Source-wide social email trigger audit passed');
