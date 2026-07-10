#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODULES_ROOT = path.join(ROOT, 'src', 'modules');
const OUTPUT_DIR = path.join(ROOT, 'docs');
const OUTPUT_JSON = path.join(OUTPUT_DIR, 'api-inventory.json');
const OUTPUT_MARKDOWN = path.join(OUTPUT_DIR, 'API_INVENTORY.md');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const read = (file) => fs.readFileSync(file, 'utf8');
const lineNumberAt = (source, index) => source.slice(0, index).split('\n').length;
const relative = (file) => path.relative(ROOT, file).replaceAll(path.sep, '/');

const normalizePath = (...parts) => {
  const joined = parts
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
  if (!joined) return '/';
  const prefixed = joined.startsWith('/') ? joined : `/${joined}`;
  return prefixed.length > 1 && prefixed.endsWith('/') ? prefixed.slice(0, -1) : prefixed;
};

// Preserve character positions while hiding comments so route-like examples in
// comments are never reported as live endpoints.
const maskComments = (source) => {
  let result = '';
  let mode = 'code';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (mode === 'line-comment') {
      if (char === '\n') {
        mode = 'code';
        result += '\n';
      } else result += ' ';
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        result += '  ';
        index += 1;
        mode = 'code';
      } else result += char === '\n' ? '\n' : ' ';
      continue;
    }
    if (mode === 'string') {
      result += char;
      if (char === '\\') {
        if (index + 1 < source.length) {
          result += source[index + 1];
          index += 1;
        }
      } else if (char === quote) {
        mode = 'code';
        quote = '';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      result += '  ';
      index += 1;
      mode = 'line-comment';
    } else if (char === '/' && next === '*') {
      result += '  ';
      index += 1;
      mode = 'block-comment';
    } else {
      result += char;
      if (char === '"' || char === "'" || char === '`') {
        mode = 'string';
        quote = char;
      }
    }
  }
  return result;
};

const findClosingParen = (source, openIndex) => {
  let depth = 0;
  let mode = 'code';
  let quote = '';
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (mode === 'string') {
      if (char === '\\') index += 1;
      else if (char === quote) mode = 'code';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      mode = 'string';
      quote = char;
    } else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

const firstStringArgument = (argumentsSource) => {
  const match = argumentsSource.match(/^\s*(["'`])([^"'`]+)\1/);
  return match ? match[2] : null;
};

const mergeAccess = (...values) => {
  const joined = values.filter(Boolean).join(' ');
  if (/\brequireAdmin\b|requireHardcodedAdminAuth|requireAdminPermission|requireSuperAdmin/.test(joined)) return 'admin';
  if (/protectAllowIncomplete/.test(joined)) return 'authenticated-onboarding';
  if (/\bprotect\b|\brequireAuth\b|\bauthorize\s*\(/.test(joined)) return 'authenticated';
  if (/\boptionalAuth\b/.test(joined) && !/publicOptionalAuth/.test(joined)) return 'user-or-guest';
  if (/publicOptionalAuth/.test(joined)) return 'public-optional-auth';
  return 'public';
};

const resolveRouteImport = (fromFile, importPath) => {
  const base = path.resolve(path.dirname(fromFile), importPath);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const parseImports = (source, file) => {
  const imports = new Map();
  const expression = /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(expression)) {
    if (!match[2].startsWith('.')) continue;
    const resolved = resolveRouteImport(file, match[2]);
    if (resolved) imports.set(match[1], resolved);
  }
  return imports;
};

const getRouterWideAccessSource = (source) => {
  const masked = maskComments(source);
  const guards = [];
  const expression = /router\.use\s*\(([^\n;]+)\)\s*;/g;
  for (const match of masked.matchAll(expression)) {
    if (/^[\s]*["'`]/.test(match[1])) continue;
    if (/protect|authorize\s*\(|\brequireAdmin\b|requireHardcodedAdminAuth|requireAdminPermission|requireSuperAdmin/.test(match[1])) {
      guards.push(match[1]);
    }
  }
  return guards.join(' ');
};

const routeRecords = [];
const visitedMounts = new Set();

const scanRouteFile = (file, prefix, inheritedAccessSource = '') => {
  const mountKey = `${file}::${prefix}`;
  if (visitedMounts.has(mountKey)) return;
  visitedMounts.add(mountKey);

  const source = read(file);
  const masked = maskComments(source);
  const imports = parseImports(source, file);
  const routerAccessSource = `${inheritedAccessSource} ${getRouterWideAccessSource(source)}`;

  const directExpression = /\brouter\.(get|post|put|patch|delete)\s*\(/g;
  for (const match of masked.matchAll(directExpression)) {
    const openIndex = match.index + match[0].lastIndexOf('(');
    const closeIndex = findClosingParen(masked, openIndex);
    if (closeIndex < 0) continue;
    const args = source.slice(openIndex + 1, closeIndex);
    const endpointPath = firstStringArgument(args);
    if (endpointPath === null) continue;
    routeRecords.push({
      method: match[1].toUpperCase(),
      path: normalizePath(prefix, endpointPath),
      access: mergeAccess(routerAccessSource, args),
      source: relative(file),
      line: lineNumberAt(source, match.index)
    });
  }

  const builderExpression = /\brouter\.route\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g;
  for (const match of masked.matchAll(builderExpression)) {
    const chainStart = match.index + match[0].length;
    const semicolon = masked.indexOf(';', chainStart);
    const chainEnd = semicolon >= 0 ? semicolon : masked.length;
    const chain = source.slice(chainStart, chainEnd);
    const maskedChain = masked.slice(chainStart, chainEnd);
    const methodExpression = /\.(get|post|put|patch|delete)\s*\(/g;
    for (const methodMatch of maskedChain.matchAll(methodExpression)) {
      const methodOpenIndex = methodMatch.index + methodMatch[0].lastIndexOf('(');
      const methodCloseIndex = findClosingParen(maskedChain, methodOpenIndex);
      if (methodCloseIndex < 0) continue;
      // Access middleware belongs to this HTTP method, not to every sibling in
      // the router.route() chain. Merging the complete chain incorrectly made a
      // public GET authenticated whenever POST/PUT/DELETE used `protect`.
      const methodArguments = chain.slice(methodOpenIndex + 1, methodCloseIndex);
      routeRecords.push({
        method: methodMatch[1].toUpperCase(),
        path: normalizePath(prefix, match[2]),
        access: mergeAccess(routerAccessSource, methodArguments),
        source: relative(file),
        line: lineNumberAt(source, chainStart + methodMatch.index)
      });
    }
  }

  const nestedExpression = /router\.use\s*\(\s*(["'`])([^"'`]*)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const match of masked.matchAll(nestedExpression)) {
    const child = imports.get(match[3]);
    if (child) scanRouteFile(child, normalizePath(prefix, match[2]), routerAccessSource);
  }
};

const indexFile = path.join(MODULES_ROOT, 'index.ts');
const indexSource = read(indexFile);
const indexImports = parseImports(indexSource, indexFile);
const mountExpression = /app\.use\s*\(\s*(["'`])([^"'`]+)\1\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
for (const mount of indexSource.matchAll(mountExpression)) {
  const file = indexImports.get(mount[3]);
  if (!file || mount[3] === 'callsRoutes') continue;
  scanRouteFile(file, mount[2]);
}

// These TypeScript wrappers deliberately bridge to mounted CommonJS legacy
// routers through a computed `require(path.join(...))`. Static ES-import
// discovery cannot follow that expression, so scan the real implementations.
// Keeping the bridges here prevents live call/ICE endpoints from silently
// disappearing from the generated API contract.
scanRouteFile(path.join(ROOT, 'src', 'legacy-src', 'routes', 'calls.js'), '/api/calls');
scanRouteFile(path.join(ROOT, 'src', 'legacy-src', 'routes', 'rtc.js'), '/api/rtc');

routeRecords.push(
  { method: 'GET', path: '/', access: 'public', source: 'src/app.ts', line: 64 },
  { method: 'GET', path: '/health', access: 'public', source: 'src/app.ts', line: 65 }
);

const endpoints = [...new Map(routeRecords
  .map((record) => [`${record.method} ${record.path} ${record.source} ${record.line}`, record]))
  .values()]
  .sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const resolved = path.join(directory, entry.name);
  if (entry.isDirectory()) return walk(resolved);
  return [resolved];
});

const sourceFiles = walk(path.join(ROOT, 'src')).filter((file) => {
  if (!/\.(?:ts|js)$/.test(file)) return false;
  return !/\.(?:test|spec)\.(?:ts|js)$/.test(file);
});
const socketEvents = [];
for (const file of sourceFiles) {
  const source = read(file);
  const masked = maskComments(source);
  const inbound = /\b(?:socket|clientSocket)\.on\s*\(\s*(["'`])([^"'`]+)\1/g;
  for (const match of masked.matchAll(inbound)) {
    socketEvents.push({
      direction: 'inbound',
      event: match[2],
      source: relative(file),
      line: lineNumberAt(source, match.index)
    });
  }

  // Some handlers intentionally register a fixed set of event names in a
  // loop. Preserve each literal in the contract instead of losing the whole
  // group merely because socket.on() receives the loop variable.
  const loopEvents = /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+\[([^\]]+)](?:\s+as\s+const)?\s*\)/g;
  for (const loop of masked.matchAll(loopEvents)) {
    const variable = loop[1];
    const nearby = masked.slice(loop.index, Math.min(masked.length, loop.index + 8000));
    const listens = new RegExp(`\\b(?:socket|clientSocket)\\.on\\s*\\(\\s*${variable}\\b`).test(nearby);
    const emits = new RegExp(`\\.emit\\s*\\(\\s*${variable}\\b`).test(nearby);
    if (!listens && !emits) continue;
    const literals = [...loop[2].matchAll(/(["'`])([^"'`]+)\1/g)];
    for (const literal of literals) {
      if (listens) socketEvents.push({
        direction: 'inbound',
        event: literal[2],
        source: relative(file),
        line: lineNumberAt(source, loop.index)
      });
      if (emits) socketEvents.push({
        direction: 'outbound',
        event: literal[2],
        source: relative(file),
        line: lineNumberAt(source, loop.index)
      });
    }
  }
}
for (const file of sourceFiles) {
  const source = read(file);
  const masked = maskComments(source);
  // Socket.IO commonly emits through room/broadcast chains (`io.to(...).emit`)
  // and through optional chains. Restricting discovery to a bare `io.emit`
  // omitted most production message, notification, presence, and call events.
  const outbound = /\.emit\s*\(\s*(["'`])([^"'`]+)\1/g;
  for (const match of masked.matchAll(outbound)) {
    socketEvents.push({
      direction: 'outbound',
      event: match[2],
      source: relative(file),
      line: lineNumberAt(source, match.index)
    });
  }

  // Capture the two literal outcomes when the emitted name is selected by a
  // conditional expression (for example typing-start vs typing-stop).
  const conditionalOutbound = /\.emit\s*\(\s*[^?,\n]+\?\s*(["'`])([^"'`]+)\1\s*:\s*(["'`])([^"'`]+)\3/g;
  for (const match of masked.matchAll(conditionalOutbound)) {
    for (const event of [match[2], match[4]]) socketEvents.push({
      direction: 'outbound',
      event,
      source: relative(file),
      line: lineNumberAt(source, match.index)
    });
  }

  // Random Connect deliberately centralizes room fan-out behind this helper;
  // its third argument is still the concrete Socket.IO event contract.
  const participantOutbound = /\bemitToParticipants\s*\(\s*[^,]+,\s*[^,]+,\s*(["'`])([^"'`]+)\1/g;
  for (const match of masked.matchAll(participantOutbound)) socketEvents.push({
    direction: 'outbound',
    event: match[2],
    source: relative(file),
    line: lineNumberAt(source, match.index)
  });
}
const sockets = [...new Map(socketEvents
  .map((record) => [`${record.direction} ${record.event} ${record.source} ${record.line}`, record]))
  .values()]
  .sort((left, right) => left.event.localeCompare(right.event) || left.direction.localeCompare(right.direction));

const byAccess = endpoints.reduce((counts, endpoint) => {
  counts[endpoint.access] = (counts[endpoint.access] || 0) + 1;
  return counts;
}, {});
const generatedAt = new Date().toISOString();
const inventory = { generatedAt, endpointCount: endpoints.length, socketEventCount: sockets.length, byAccess, endpoints, sockets };

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(inventory, null, 2)}\n`);

const markdown = [
  '# API Inventory',
  '',
  `Generated from the mounted Express routers on ${generatedAt}.`,
  '',
  `- HTTP endpoints: **${endpoints.length}**`,
  `- Socket event handlers/emissions: **${sockets.length}**`,
  `- Access classes: ${Object.entries(byAccess).sort().map(([key, value]) => `\`${key}\`: ${value}`).join(', ')}`,
  '',
  '> This is a static registration inventory. Runtime health and behavioral coverage are reported separately; inclusion here does not imply an endpoint has a live-database integration test.',
  '',
  '## HTTP endpoints',
  '',
  '| Method | Path | Access | Source |',
  '|---|---|---|---|',
  ...endpoints.map((endpoint) => `| ${endpoint.method} | \`${endpoint.path}\` | ${endpoint.access} | \`${endpoint.source}:${endpoint.line}\` |`),
  '',
  '## Socket events',
  '',
  '| Direction | Event | Source |',
  '|---|---|---|',
  ...sockets.map((event) => `| ${event.direction} | \`${event.event}\` | \`${event.source}:${event.line}\` |`),
  ''
].join('\n');
fs.writeFileSync(OUTPUT_MARKDOWN, markdown);

console.log(`Wrote ${endpoints.length} HTTP endpoints and ${sockets.length} socket records.`);
console.log(relative(OUTPUT_MARKDOWN));
console.log(relative(OUTPUT_JSON));
