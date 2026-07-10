#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = path.resolve(BACKEND_ROOT, '..');
const INVENTORY_FILE = path.join(BACKEND_ROOT, 'docs', 'api-inventory.json');
const CLIENTS = [
  { name: 'web', roots: [path.join(WORKSPACE_ROOT, 'frontend', 'src')] },
  {
    name: 'mobile',
    roots: [
      path.join(WORKSPACE_ROOT, 'mobile-ui', 'arc-mobile', 'app'),
      path.join(WORKSPACE_ROOT, 'mobile-ui', 'arc-mobile', 'src')
    ]
  }
];

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts']);
const INTENTIONALLY_GATED_CALLS = new Map([
  [
    'web POST /api/payments/apple-pay/validate-merchant',
    'Apple Pay is hidden unless VITE_APPLE_PAY_ENABLED=true and the merchant backend is deployed.'
  ],
  [
    'web POST /api/payments/apple-pay/process',
    'Apple Pay is hidden unless VITE_APPLE_PAY_ENABLED=true and the merchant backend is deployed.'
  ]
]);

const walk = (directory) => {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(resolved);
    return [resolved];
  });
};

const isAuditableSource = (file) => (
  SOURCE_EXTENSIONS.has(path.extname(file)) &&
  !/\.(?:test|spec|contract)\.[^.]+$/.test(file) &&
  !file.includes(`${path.sep}node_modules${path.sep}`)
);

const sourceKindFor = (file) => {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js') || file.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};

const expressionFragment = (node) => {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.reduce(
      (value, span) => `${value}:param${span.literal.text}`,
      node.head.text
    );
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionFragment(node.left);
    const right = expressionFragment(node.right);
    if (left == null && right == null) return null;
    return `${left == null ? ':param' : left}${right == null ? ':param' : right}`;
  }
  return null;
};

const normalizeApiPath = (rawValue) => {
  const raw = String(rawValue || '');
  const apiIndex = raw.indexOf('/api/');
  if (apiIndex < 0) return null;
  const withoutQuery = raw.slice(apiIndex).split(/[?#]/, 1)[0];
  const normalized = withoutQuery
    .replace(/:param(?=:param)/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
  return normalized || '/api';
};

const propertyName = (expression) => {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return '';
};

const objectStringProperty = (object, name) => {
  if (!ts.isObjectLiteralExpression(object)) return null;
  const property = object.properties.find((entry) => (
    ts.isPropertyAssignment(entry) &&
    ((ts.isIdentifier(entry.name) && entry.name.text === name) ||
      (ts.isStringLiteralLike(entry.name) && entry.name.text === name))
  ));
  return property && ts.isPropertyAssignment(property)
    ? expressionFragment(property.initializer)
    : null;
};

const methodFromFetchOptions = (node) => {
  if (!node || !ts.isObjectLiteralExpression(node)) return 'GET';
  const raw = objectStringProperty(node, 'method');
  const method = String(raw || 'GET').toUpperCase();
  return HTTP_METHODS.has(method) ? method : null;
};

const collectClientCalls = (client) => {
  const records = [];
  for (const file of client.roots.flatMap(walk).filter(isAuditableSource)) {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      sourceKindFor(file)
    );
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        let method = null;
        let pathValue = null;
        const calleeProperty = propertyName(node.expression).toUpperCase();
        if (HTTP_METHODS.has(calleeProperty)) {
          method = calleeProperty;
          pathValue = expressionFragment(node.arguments[0]);
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
          method = methodFromFetchOptions(node.arguments[1]);
          pathValue = expressionFragment(node.arguments[0]);
        } else if (calleeProperty === 'REQUEST' && node.arguments[0]) {
          const config = node.arguments[0];
          const rawMethod = objectStringProperty(config, 'method');
          method = rawMethod ? String(rawMethod).toUpperCase() : null;
          pathValue = objectStringProperty(config, 'url');
        } else if (ts.isIdentifier(node.expression) && /^(?:api|axios|request)$/.test(node.expression.text)) {
          const config = node.arguments[0];
          const rawMethod = objectStringProperty(config, 'method');
          method = rawMethod ? String(rawMethod).toUpperCase() : null;
          pathValue = objectStringProperty(config, 'url');
        }
        const apiPath = normalizeApiPath(pathValue);
        if (apiPath && method && HTTP_METHODS.has(method)) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          records.push({
            client: client.name,
            method,
            path: apiPath,
            source: path.relative(WORKSPACE_ROOT, file).replaceAll(path.sep, '/'),
            line: position.line + 1
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return records;
};

const pathsCompatible = (clientPath, mountedPath) => {
  const clientSegments = clientPath.split('/').filter(Boolean);
  const mountedSegments = mountedPath.split('/').filter(Boolean);
  if (clientSegments.length !== mountedSegments.length) return false;
  return clientSegments.every((clientSegment, index) => {
    const mountedSegment = mountedSegments[index];
    if (clientSegment.includes(':param')) return true;
    if (mountedSegment.includes(':')) return true;
    return clientSegment === mountedSegment;
  });
};

const inventory = JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8'));
const mounted = inventory.endpoints;
const clientCalls = CLIENTS.flatMap(collectClientCalls);
const unresolved = clientCalls.filter((call) => !mounted.some((endpoint) => (
  endpoint.method === call.method && pathsCompatible(call.path, endpoint.path)
)));

const uniqueCalls = [...new Map(clientCalls.map((call) => [
  `${call.client} ${call.method} ${call.path}`,
  call
])).values()];
const uniqueUnresolved = [...new Map(unresolved.map((call) => [
  `${call.client} ${call.method} ${call.path}`,
  call
])).values()];
const intentionallyGated = uniqueUnresolved.filter((call) => (
  INTENTIONALLY_GATED_CALLS.has(`${call.client} ${call.method} ${call.path}`)
));
const activeUnresolved = uniqueUnresolved.filter((call) => (
  !INTENTIONALLY_GATED_CALLS.has(`${call.client} ${call.method} ${call.path}`)
));

console.log(`Audited ${uniqueCalls.length} statically-resolvable Web/Mobile API call contracts.`);
if (intentionallyGated.length) {
  console.log(`Classified ${intentionallyGated.length} unmatched calls as intentionally disabled capabilities:`);
  for (const call of intentionallyGated) {
    const key = `${call.client} ${call.method} ${call.path}`;
    console.log(`- ${key}: ${INTENTIONALLY_GATED_CALLS.get(key)}`);
  }
}
if (activeUnresolved.length) {
  console.error(`Found ${activeUnresolved.length} active client calls without a mounted method/path match:`);
  for (const call of activeUnresolved) {
    console.error(`- ${call.client} ${call.method} ${call.path} (${call.source}:${call.line})`);
  }
  process.exitCode = 1;
} else {
  console.log('Every active statically-resolvable client API call matches a mounted backend endpoint.');
}
