const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createExportHandler } = require('../src/lib/export-handler.ts');

function createResponse() {
  const response = new EventEmitter();
  response.headers = {};
  response.status = code => {
    response.statusCode = code;
    return response;
  };
  response.setHeader = (name, value) => { response.headers[name] = value; };
  response.removeHeader = name => { delete response.headers[name]; };
  response.json = body => {
    response.body = body;
    response.writableFinished = true;
    return response;
  };
  return response;
}

const request = { method: 'GET', query: {} };
const filters = { startDate: '2026-01-01', endDate: '2026-01-31' };
const dependencies = {
  parseFilters: () => filters,
  generateCsv: async () => ({
    fileName: 'report.csv',
    filePath: '/unused-in-tests.csv',
    cleanup: async () => {},
  }),
  sendFile: async () => {},
};

async function waitForCancellation(_filters, signal) {
  await new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('rejects another export until the first finishes cleanup', async () => {
  let finishCleanup;
  const state = {};
  const handler = createExportHandler({
    ...dependencies,
    generateCsv: async () => ({
      fileName: 'report.csv',
      filePath: '/unused-in-tests.csv',
      cleanup: () => new Promise(resolve => { finishCleanup = resolve; }),
    }),
  }, state);

  const firstResponse = createResponse();
  const firstExport = handler(request, firstResponse);
  await new Promise(setImmediate); // Let the first request reach cleanup.

  const secondResponse = createResponse();
  await handler({ ...request, query: { downloadToken: 'busy-test' } }, secondResponse);
  assert.equal(secondResponse.statusCode, 429);
  assert.equal(secondResponse.headers['Retry-After'], '5');
  assert.equal(secondResponse.headers['Set-Cookie'],
    'exportError=busy-test-429; Path=/; Max-Age=180; SameSite=Strict');

  finishCleanup();
  await firstExport;
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(state.productHealthExportActive, false);

  const nextResponse = createResponse();
  const nextExport = handler(request, nextResponse);
  await new Promise(setImmediate);
  finishCleanup();
  await nextExport;
  assert.equal(nextResponse.statusCode, 200);
});

test('returns 504 and releases the slot when the export times out', async () => {
  const state = {};
  // Use the real timer with a short limit instead of waiting two minutes.
  const handler = createExportHandler({
    ...dependencies,
    generateCsv: waitForCancellation,
  }, state, 10);
  const response = createResponse();

  await handler(request, response);

  assert.equal(response.statusCode, 504);
  assert.equal(state.productHealthExportActive, false);
  assert.equal(response.listenerCount('close'), 0);
});

test('cancels generation and releases the slot when the client disconnects', async () => {
  const state = {};
  let exportSignal;
  const handler = createExportHandler({
    ...dependencies,
    generateCsv: (filters, signal) => {
      exportSignal = signal;
      return waitForCancellation(filters, signal);
    },
  }, state);
  const response = createResponse();
  const running = handler(request, response);

  response.destroyed = true;
  response.emit('close');
  await running;

  assert.equal(exportSignal.aborted, true);
  assert.equal(state.productHealthExportActive, false);
  assert.equal(response.statusCode, undefined); // No response to a closed connection.
  assert.equal(response.listenerCount('close'), 0);
});

test('signals file readiness only after generation and before delivery', async () => {
  let finishGeneration;
  const state = {};
  const response = createResponse();
  const handler = createExportHandler({
    ...dependencies,
    generateCsv: () => new Promise(resolve => { finishGeneration = resolve; }),
    sendFile: async () => {
      assert.equal(response.headers['Set-Cookie'],
        'exportReady=test-token; Path=/; Max-Age=180; SameSite=Strict');
    },
  }, state);
  const running = handler({ ...request, query: { downloadToken: 'test-token' } }, response);
  assert.equal(response.headers['Set-Cookie'], undefined);
  finishGeneration(await dependencies.generateCsv());
  await running;
  assert.equal(response.statusCode, 200);
});
