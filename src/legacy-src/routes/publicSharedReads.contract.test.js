const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { publicOptionalAuth } = require('../middleware/auth');

const read = (name) => readFileSync(path.join(__dirname, name), 'utf8');

test('anonymous public-read middleware advances without fabricating a user', async () => {
  const request = { headers: {}, cookies: {} };
  let advanced = false;
  await publicOptionalAuth(request, {}, () => { advanced = true; });
  assert.equal(advanced, true);
  assert.equal(request.user, undefined);
});

test('an expired or invalid public-read token falls back to anonymous visibility', async () => {
  const request = { headers: { authorization: 'Bearer expired-token' }, cookies: {} };
  let advanced = false;
  await publicOptionalAuth(request, {}, () => { advanced = true; });
  assert.equal(advanced, true);
  assert.equal(request.user, undefined);
});

test('public shared reads use optional authentication but writes remain protected', () => {
  const posts = read('posts.js');
  const users = read('users.js');
  const stories = read('stories.js');
  for (const route of ['/:id', '/:id/comments', '/:id/likes']) {
    assert.ok(posts.includes(`router.get('${route}', publicOptionalAuth`));
  }
  assert.match(posts, /router\.post\('\/:id\/like', protect/);
  assert.match(posts, /router\.post\('\/:id\/comment', protect/);
  assert.match(users, /router\.get\('\/:identifier', publicOptionalAuth/);
  assert.match(users, /router\.post\('\/:id\/follow', protect/);
  assert.match(stories, /router\.get\('\/:storyId', publicOptionalAuth/);
  assert.match(stories, /router\.post\('\/:storyId\/view', protect/);
  assert.match(stories, /router\.delete\('\/:storyId', protect/);
  const modularPosts = read('../../modules/posts/posts.routes.ts');
  const modularUsers = read('../../modules/users/users.routes.ts');
  const modularStories = read('../../modules/stories/stories.routes.ts');
  assert.ok(modularPosts.includes('router.get("/:id", publicOptionalAuth'));
  assert.ok(modularPosts.includes('router.get("/:id/comments", publicOptionalAuth'));
  assert.ok(modularPosts.includes('router.post("/:id/like", protect'));
  assert.ok(modularUsers.includes('router.get("/:identifier", publicOptionalAuth'));
  assert.ok(modularUsers.includes('router.post("/:id/follow", protect'));
  assert.ok(modularStories.includes('router.get("/:storyId", publicOptionalAuth'));
  assert.ok(modularStories.includes('router.post("/:storyId/view", protect'));
});

test('public story reads omit the raw viewer array', () => {
  const controller = read('../controllers/storyController.js');
  assert.match(controller, /buildActiveStoryQuery\(\{[\s\S]*?\}\)\)\.select\('-views'\)\.populate/);
  assert.match(controller, /const query = Story\.find\(buildActiveStoryQuery\(\{[\s\S]*?\}\)\)\.select\('-views'\)/);
});

test('anonymous feed and clip reads use the guest-safe post DTO', () => {
  const recommendations = read('../services/recommendationService.js');
  assert.match(recommendations, /const isGuest = !user \|\| user\.userType === 'guest';[\s\S]*?formatPostDTO\([\s\S]*?isGuest/);
});
