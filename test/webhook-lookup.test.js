/* The pinned address of a webhook delivery (DNS rebinding guard) answers both shapes Node uses: { all: true } →
   [{ address, family }] (Node 20+ autoSelectFamily), otherwise (address, family). The old single-shape answer made every
   delivery fail with «Invalid IP address: undefined». */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { pinnedLookup } = require('../src/webhooks');

test('lookup with { all: true } answers [{ address, family }]', () => {
    let got;
    pinnedLookup('93.184.216.34')('example.com', { all: true }, (...a) => { got = a; });
    assert.deepEqual(got, [null, [{ address: '93.184.216.34', family: 4 }]]);
    pinnedLookup('2606:2800:220:1::')('example.com', { all: true }, (...a) => { got = a; });
    assert.deepEqual(got, [null, [{ address: '2606:2800:220:1::', family: 6 }]]);
});

test('lookup without all answers (address, family); also when called without options', () => {
    let got;
    pinnedLookup('93.184.216.34')('example.com', { family: 0 }, (...a) => { got = a; });
    assert.deepEqual(got, [null, '93.184.216.34', 4]);
    pinnedLookup('93.184.216.34')('example.com', (...a) => { got = a; });
    assert.deepEqual(got, [null, '93.184.216.34', 4]);
});

test('a real request through the pinned lookup reaches the server (no «Invalid IP address»)', async (t) => {
    const server = http.createServer((req, res) => res.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const status = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: 'pinned.example', port: server.address().port, path: '/', method: 'POST', lookup: pinnedLookup('127.0.0.1') },
            (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end('{}');
    });
    assert.equal(status, 200);
});
