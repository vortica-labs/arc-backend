const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sendInternalError } = require('./internalErrorResponse');

function createResponseCapture() {
  return {
    statusCode: null,
    body: null,
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function run() {
  const previousNodeEnv = process.env.NODE_ENV;

  try {
    const logEntries = [];
    const log = {
      error(message, metadata) {
        logEntries.push({ message, metadata });
      }
    };
    const internalFailure = new Error('mongodb://private-host/users duplicate key');

    process.env.NODE_ENV = 'production';
    const productionResponse = createResponseCapture();
    sendInternalError({
      res: productionResponse,
      log,
      operation: 'Membership lookup failed',
      publicMessage: 'Failed to get membership',
      error: internalFailure
    });

    assert.strictEqual(productionResponse.statusCode, 500);
    assert.deepStrictEqual(productionResponse.body, {
      success: false,
      message: 'Failed to get membership'
    });
    assert.strictEqual(logEntries.length, 1);
    assert.strictEqual(logEntries[0].metadata.error, internalFailure.message);
    assert.match(logEntries[0].metadata.stack, /mongodb:\/\/private-host/);

    process.env.NODE_ENV = 'development';
    const developmentResponse = createResponseCapture();
    sendInternalError({
      res: developmentResponse,
      log,
      operation: 'Membership lookup failed',
      publicMessage: 'Failed to get membership',
      error: internalFailure
    });
    assert.strictEqual(developmentResponse.body.error, internalFailure.message);

    const controllerDirectory = path.resolve(__dirname, '../controllers');
    for (const fileName of [
      'hostVerificationController.js',
      'membershipController.js',
      'monetizationController.js'
    ]) {
      const source = fs.readFileSync(path.join(controllerDirectory, fileName), 'utf8');
      assert.doesNotMatch(
        source,
        /(?:error|message)\s*:\s*(?:err|error)\.message/,
        `${fileName} must not return raw exception messages`
      );
      assert.doesNotMatch(
        source,
        /res\.status\(\s*(?:err|error)\.statusCode\s*\)/,
        `${fileName} must not allow thrown errors to choose a public HTTP status`
      );
    }
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }

  console.log('Internal error response contracts passed');
}

run();
