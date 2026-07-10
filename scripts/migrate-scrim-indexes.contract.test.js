const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'migrate-scrim-indexes.js'), 'utf8');

assert.match(source, /process\.argv\.includes\('--apply'\)/, 'index creation must require an explicit apply flag');
assert.match(source, /process\.argv\.includes\('--apply-cleanup'\)/, 'reference cleanup must require a separate explicit flag');
assert.match(source, /Scrim\.createIndexes\(\)/);
assert.match(source, /registeredTeams:\s*normalizedParticipants/);
assert.match(source, /\['Open', 'Full'\]\.includes\(scrim\.status\)/, 'historical/in-progress entrant lists must not be rewritten');
assert.match(source, /participant\.userType === 'team'/);
assert.match(source, /duplicateParticipants/);
assert.match(source, /missingParticipantArrays/);
assert.match(source, /invalidHostReferences/);
assert.match(source, /invalidParticipantReferences/);
assert.match(source, /overCapacity/);
assert.match(source, /invalidPrizeConfigurations/);
assert.match(source, /invalidBroadcastEntries/);
assert.match(source, /invalidDescriptions/);
assert.match(source, /strict-integrity/);
assert.doesNotMatch(source, /findOneAndUpdate\([\s\S]{0,600}?\n\s*\[/, 'migration mutations must remain DocumentDB-compatible');

console.log('Scrim index/integrity migration contracts passed');
