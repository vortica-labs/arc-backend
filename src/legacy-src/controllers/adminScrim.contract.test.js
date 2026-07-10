const assert = require('assert');
const fs = require('fs');
const path = require('path');

const controllerSource = fs.readFileSync(path.join(__dirname, 'adminController.js'), 'utf8');
const routesSource = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'modules', 'admin', 'admin.routes.ts'),
  'utf8'
);

assert.match(controllerSource, /const Scrim = require\('\.\.\/models\/Scrim'\)/);
assert.match(controllerSource, /const getScrims = async \(req, res\)/);
assert.match(controllerSource, /Scrim\.find\(query\)[\s\S]*Scrim\.countDocuments\(query\)[\s\S]*Scrim\.aggregate/);
assert.match(controllerSource, /registeredTeams: Array\.isArray\(scrim\.registeredTeams\)/);
assert.match(controllerSource, /const deleteScrim = async \(req, res\)/);
assert.match(controllerSource, /Scrim\.deleteOne\(\{ _id: scrimId \}\)/);
assert.match(controllerSource, /res\.locals\.auditBefore = scrim/);

assert.match(routesSource, /"scrimId"/);
assert.match(
  routesSource,
  /router\.get\("\/scrims", auditLog\("VIEW_SCRIMS"\), requireAdminPermission\("tournaments:manage"\), adminController\.getScrims\)/
);
assert.match(
  routesSource,
  /router\.delete\("\/scrims\/:scrimId", auditLog\("DELETE_SCRIM"\), requireAdminPermission\("tournaments:manage"\), adminController\.deleteScrim\)/
);

console.log('Admin Scrim visibility and moderation contracts passed');
