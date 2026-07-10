'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isSocialPreviewRequest, markSocialPreviewRequest } = require('./socialPreviewRequest');

test('recognizes only the dedicated server-routed social-preview flag', () => {
  const req = { headers: { 'x-squadhunt-purpose': 'social-preview' } };
  assert.equal(isSocialPreviewRequest(req), false, 'a client header must not bypass view tracking');
  let continued = false;
  markSocialPreviewRequest(req, {}, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(isSocialPreviewRequest(req), true);
});

test('recruitment preview routes preserve DTO/privacy reads without incrementing views', () => {
  const controller = fs.readFileSync(path.join(__dirname, '../controllers/recruitmentController.js'), 'utf8');
  const legacyRoutes = fs.readFileSync(path.join(__dirname, '../routes/recruitment.js'), 'utf8');
  const modularRoutes = fs.readFileSync(path.join(__dirname, '../../modules/recruitment/recruitment.routes.ts'), 'utf8');
  assert.equal((controller.match(/!isOwner && !isSocialPreviewRequest\(req\)/g) || []).length, 2);
  for (const source of [legacyRoutes, modularRoutes]) {
    assert.match(source, /recruitment\/:code\/preview/);
    assert.match(source, /profile\/:code\/preview/);
    assert.match(source, /markSocialPreviewRequest[^\n]*publicOptionalAuth[^\n]*(getTeamRecruitment|recruitmentController\.getTeamRecruitment)/);
  }
});
