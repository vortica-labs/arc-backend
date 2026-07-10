const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../../..');

const unwrapDefault = (module) => module?.default?.default || module?.default || module;
const findRoute = (router, method, routePath) => router.stack.find((layer) => (
  layer.route?.path === routePath && layer.route.methods?.[method]
));

const responseRecorder = () => ({
  statusCode: 200,
  body: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const run = async () => {
  const corsPolicy = await import('../../config/cors.ts');
  const getAllowedOrigins = corsPolicy.getAllowedOrigins || corsPolicy.default?.getAllowedOrigins;
  assert(getAllowedOrigins().includes('https://squadhunt.in'));
  assert(getAllowedOrigins().includes('https://www.squadhunt.in'));
  assert(getAllowedOrigins().includes('https://admin.squadhunt.in'));

  const knowledgeRouter = unwrapDefault(await import('../knowledge/knowledge.routes.ts'));
  const feedbackRouter = unwrapDefault(await import('../feedback/feedback.routes.ts'));

  for (const [method, routePath] of [['post', '/test-retrieval'], ['get', '/stats']]) {
    const route = findRoute(knowledgeRouter, method, routePath);
    assert(route, `Missing knowledge route ${method.toUpperCase()} ${routePath}`);
    assert.strictEqual(
      route.route.stack[0]?.name,
      'requireHardcodedAdminAuth',
      `${method.toUpperCase()} ${routePath} must be admin-authenticated`
    );
  }

  const feedbackSubmission = findRoute(feedbackRouter, 'post', '/');
  assert(feedbackSubmission, 'Missing public feedback submission route');
  assert(
    feedbackSubmission.route.stack.some((layer) => (
      typeof layer.handle?.resetKey === 'function' && typeof layer.handle?.getKey === 'function'
    )),
    'Public feedback submission must be rate limited'
  );

  const usersRouter = unwrapDefault(await import('../users/users.routes.ts'));
  const avatarRoute = findRoute(usersRouter, 'get', '/avatar/:userId');
  assert(avatarRoute, 'Missing avatar proxy route');
  assert(
    avatarRoute.route.stack.some((layer) => (
      typeof layer.handle?.resetKey === 'function' && typeof layer.handle?.getKey === 'function'
    )),
    'Public avatar proxy must be rate limited'
  );
  const { parseAllowedAvatarUrl } = require('../../legacy-src/utils/avatarProxyPolicy');
  assert(parseAllowedAvatarUrl('https://lh3.googleusercontent.com/avatar.png'));
  assert(parseAllowedAvatarUrl('https://res.cloudinary.com/demo/image/upload/avatar.png'));
  assert.strictEqual(parseAllowedAvatarUrl('http://169.254.169.254/latest/meta-data'), null);
  assert.strictEqual(parseAllowedAvatarUrl('https://googleusercontent.com.evil.example/avatar.png'), null);
  assert.strictEqual(parseAllowedAvatarUrl('https://user:pass@lh3.googleusercontent.com/avatar.png'), null);
  {
    const userController = require('../../legacy-src/controllers/userController');
    const res = responseRecorder();
    await userController.getAvatar({ params: { userId: 'not-an-object-id' } }, res);
    assert.strictEqual(res.statusCode, 400, 'Avatar proxy must reject invalid user IDs before querying or fetching');
  }

  const paymentRouter = unwrapDefault(await import('../payments/payments.routes.ts'));
  for (const routePath of [
    '/subscription/create-order',
    '/subscription/verify',
    '/tournament/create-order',
    '/tournament/verify',
    '/boost/create-order',
    '/boost/verify'
  ]) {
    const route = findRoute(paymentRouter, 'post', routePath);
    assert(route, `Missing payment route POST ${routePath}`);
    assert(
      route.route.stack.some((layer) => (
        typeof layer.handle?.resetKey === 'function' && typeof layer.handle?.getKey === 'function'
      )),
      `Payment mutation POST ${routePath} must be rate limited`
    );
  }

  const knowledgeController = require('../../legacy-src/controllers/knowledgeController');
  for (const handlerName of ['getKnowledgeById', 'deleteKnowledge']) {
    const res = responseRecorder();
    await knowledgeController[handlerName]({ params: { id: 'not-an-object-id' } }, res);
    assert.strictEqual(res.statusCode, 400, `${handlerName} must reject an invalid ObjectId with 400`);
  }
  {
    const res = responseRecorder();
    await knowledgeController.updateKnowledge(
      { params: { id: 'not-an-object-id' }, body: {} },
      res
    );
    assert.strictEqual(res.statusCode, 400, 'updateKnowledge must reject an invalid ObjectId with 400');
  }
  {
    const res = responseRecorder();
    await knowledgeController.addKnowledge({
      body: { question: 'Valid?', answer: 'Yes', keywords: { $ne: null }, tags: [] }
    }, res);
    assert.strictEqual(res.statusCode, 400, 'addKnowledge must reject non-array keyword input');
  }
  {
    const res = responseRecorder();
    await knowledgeController.bulkAddKnowledge({ body: { knowledgeItems: Array(101).fill({}) } }, res);
    assert.strictEqual(res.statusCode, 400, 'bulkAddKnowledge must enforce its batch limit');
  }
  {
    const res = responseRecorder();
    await knowledgeController.testRetrieval({ body: { query: 'x'.repeat(501) } }, res);
    assert.strictEqual(res.statusCode, 400, 'testRetrieval must enforce its query limit');
  }

  const feedbackController = require('../../legacy-src/controllers/feedbackController');
  for (const [handlerName, req] of [
    ['updateFeedbackStatus', { params: { id: 'bad-id' }, body: { status: 'pending' } }],
    ['deleteFeedback', { params: { id: 'bad-id' } }]
  ]) {
    const res = responseRecorder();
    await feedbackController[handlerName](req, res);
    assert.strictEqual(res.statusCode, 400, `${handlerName} must reject an invalid ObjectId with 400`);
  }
  {
    const res = responseRecorder();
    await feedbackController.getAllFeedback({ query: { sortBy: '$where' } }, res);
    assert.strictEqual(res.statusCode, 400, 'Feedback listing must reject unapproved sort fields');
  }

  const inventoryRun = spawnSync(process.execPath, ['scripts/generate-api-inventory.js'], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(inventoryRun.status, 0, inventoryRun.stderr || inventoryRun.stdout);
  const inventory = require(path.join(root, 'docs', 'api-inventory.json'));
  const endpointKeys = inventory.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
  assert.strictEqual(new Set(endpointKeys).size, endpointKeys.length, 'Mounted endpoint inventory contains duplicates');
  const routeSegments = (routePath) => routePath.split('/').filter(Boolean);
  const routeOrderHazards = [];
  const sourceMethodGroups = new Map();
  for (const endpoint of inventory.endpoints) {
    const key = `${endpoint.source} ${endpoint.method}`;
    if (!sourceMethodGroups.has(key)) sourceMethodGroups.set(key, []);
    sourceMethodGroups.get(key).push(endpoint);
  }
  for (const endpoints of sourceMethodGroups.values()) {
    endpoints.sort((left, right) => left.line - right.line);
    for (let earlierIndex = 0; earlierIndex < endpoints.length; earlierIndex += 1) {
      const earlier = endpoints[earlierIndex];
      const earlierSegments = routeSegments(earlier.path);
      for (let laterIndex = earlierIndex + 1; laterIndex < endpoints.length; laterIndex += 1) {
        const later = endpoints[laterIndex];
        const laterSegments = routeSegments(later.path);
        if (earlierSegments.length !== laterSegments.length) continue;
        let capturesLater = true;
        let capturesStaticSegment = false;
        for (let segmentIndex = 0; segmentIndex < earlierSegments.length; segmentIndex += 1) {
          if (earlierSegments[segmentIndex].startsWith(':')) {
            if (!laterSegments[segmentIndex].startsWith(':')) capturesStaticSegment = true;
          } else if (earlierSegments[segmentIndex] !== laterSegments[segmentIndex]) {
            capturesLater = false;
            break;
          }
        }
        if (capturesLater && capturesStaticSegment) {
          routeOrderHazards.push(`${earlier.method} ${earlier.path} shadows ${later.path}`);
        }
      }
    }
  }
  assert.deepStrictEqual(routeOrderHazards, [], `Static routes shadowed by dynamic routes:\n${routeOrderHazards.join('\n')}`);
  const accessFor = (method, endpointPath) => inventory.endpoints.find((endpoint) => (
    endpoint.method === method && endpoint.path === endpointPath
  ))?.access;
  assert.strictEqual(accessFor('GET', '/api/chat/:chatId/messages'), 'authenticated');
  assert.strictEqual(accessFor('POST', '/api/chat/messages'), 'authenticated');
  assert.strictEqual(accessFor('GET', '/api/knowledge/stats'), 'admin');
  assert.strictEqual(accessFor('POST', '/api/knowledge/test-retrieval'), 'admin');
  assert.strictEqual(accessFor('POST', '/api/admin/auth/login'), 'public');
  assert.strictEqual(accessFor('GET', '/api/tournaments'), 'public-optional-auth');
  assert.strictEqual(accessFor('POST', '/api/tournaments'), 'authenticated');
  assert.strictEqual(accessFor('GET', '/api/tournaments/:id'), 'public-optional-auth');
  assert.strictEqual(accessFor('PUT', '/api/tournaments/:id'), 'authenticated');
  assert.strictEqual(accessFor('DELETE', '/api/tournaments/:id'), 'authenticated');
  assert.strictEqual(accessFor('GET', '/api/scrims'), 'public-optional-auth');
  assert.strictEqual(accessFor('POST', '/api/scrims'), 'authenticated');
  assert.strictEqual(accessFor('GET', '/api/rtc/ice'), 'authenticated');
  assert.strictEqual(accessFor('GET', '/api/rtc/usage'), 'admin');
  assert.strictEqual(accessFor('DELETE', '/api/rtc/credentials/:username'), 'admin');
  const socketHas = (direction, event) => inventory.sockets.some((record) => (
    record.direction === direction && record.event === event
  ));
  assert.ok(socketHas('inbound', 'call-accept'));
  assert.ok(socketHas('inbound', 'call-reject'));
  assert.ok(socketHas('inbound', 'call-end'));
  assert.ok(socketHas('outbound', 'call-accept'));
  assert.ok(socketHas('outbound', 'newMessage'));
  assert.ok(socketHas('outbound', 'new-notification'));
  assert.ok(socketHas('outbound', 'presence:updated'));
  assert.ok(socketHas('outbound', 'user-typing'));
  assert.ok(socketHas('outbound', 'random-session-timer-started'));
  assert.ok(socketHas('outbound', 'random-session-timer-warning'));
  assert.ok(socketHas('outbound', 'random-session-ended'));

  console.log(`API surface contracts passed (${inventory.endpointCount} HTTP endpoints inventoried).`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
