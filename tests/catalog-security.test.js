const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_REDIRECTS,
  awsOfferUrl,
  fetchJson,
  gcpSkuRequest,
  nextRedirectUrl,
  redactSecrets,
} = require('../scripts/update-catalog');

const AWS_HOST = 'https://pricing.us-east-1.amazonaws.com';
const LEGIT_PATH = '/offers/v1.0/aws/AmazonEC2/20261110173852/us-east-1/index.json';

function fakeRequest(handler) {
  return (url, options, callback) => {
    const res = handler(url, options);
    callback(res);
    return { on() { return this; } };
  };
}

function jsonResponse(body) {
  return {
    statusCode: 200,
    headers: {},
    setEncoding() {},
    on(event, fn) {
      if (event === 'data') fn(body);
      if (event === 'end') fn();
    },
  };
}

function redirectResponse(location) {
  return {
    statusCode: 302,
    headers: { location },
    resume() {},
  };
}

test('AWS offer URL stays on the pricing host', () => {
  assert.equal(awsOfferUrl(LEGIT_PATH), `${AWS_HOST}${LEGIT_PATH}`);
  assert.throws(() => awsOfferUrl('https://evil.example/offers/x'), /AWS price list/);
  assert.throws(() => awsOfferUrl('//evil.example/offers/x'), /AWS price list/);
  assert.throws(() => awsOfferUrl('@evil.example/offers/x'), /AWS price list/);
  assert.throws(() => awsOfferUrl('/offers/../../../@evil.example'), /AWS price list/);
  assert.throws(() => awsOfferUrl(''), /AWS price list/);
});

test('redirects stay on the same HTTPS host', () => {
  const current = `${AWS_HOST}/offers/a`;
  assert.equal(
    nextRedirectUrl(current, '/offers/b.json'),
    `${AWS_HOST}/offers/b.json`
  );
  assert.throws(() => nextRedirectUrl(current, 'https://evil.example/steal'), /redirect/);
  assert.throws(() => nextRedirectUrl(current, 'https://169.254.169.254/latest/meta-data'), /redirect/);
  assert.throws(() => nextRedirectUrl(current, 'http://pricing.us-east-1.amazonaws.com/offers/b'), /redirect/);
  assert.throws(
    () => nextRedirectUrl(current, 'https://user:pass@pricing.us-east-1.amazonaws.com/offers/b'),
    /redirect/
  );
  assert.throws(
    () => nextRedirectUrl(current, 'https://pricing.us-east-1.amazonaws.com@evil.example/offers/b'),
    /redirect/
  );
});

test('secrets are removed from error text', () => {
  const leaked = 'Request failed 400 https://cloudbilling.googleapis.com/v1/services?key=supersecret';
  const redacted = redactSecrets(leaked);
  assert.equal(redacted.includes('supersecret'), false);
  assert.match(redacted, /key=REDACTED/);
  assert.equal(redactSecrets('X-Goog-Api-Key: supersecret').includes('supersecret'), false);
});

test('GCP catalog request does not put the API key in the URL', () => {
  const skus = [
    'CP-COMPUTEENGINE-VMIMAGE-E2-MICRO',
    'CP-COMPUTEENGINE-GPU-NVIDIA-TESLA-T4',
    '95D8-1B15-7E1E',
    '53F8-38E4-8F5E',
  ];
  for (const sku of skus) {
    const request = gcpSkuRequest(sku, 'test-key');
    assert.equal(
      request.url,
      `https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus/${sku}`
    );
    assert.equal(request.url.includes('test-key'), false);
    assert.equal(request.url.includes('key='), false);
    assert.equal(request.headers['X-Goog-Api-Key'], 'test-key');
  }
  const escaped = gcpSkuRequest('../admin', 'test-key');
  assert.equal(new URL(escaped.url).hostname, 'cloudbilling.googleapis.com');
  assert.equal(escaped.url.endsWith('/..%2Fadmin'), true);
});

test('fetchJson refuses local, private, and non-HTTPS URLs before connecting', async () => {
  let calls = 0;
  const request = () => {
    calls += 1;
    throw new Error('should not connect');
  };
  await assert.rejects(fetchJson('https://127.0.0.1/latest', { request }), /local|private|raw-IP|Refusing/);
  await assert.rejects(fetchJson('https://169.254.169.254/', { request }), /local|private|raw-IP|Refusing/);
  await assert.rejects(fetchJson('http://prices.azure.com/api', { request }), /HTTPS|https/);
  await assert.rejects(fetchJson('https://user:pass@prices.azure.com/api', { request }), /credential/);
  assert.equal(calls, 0);
});

test('fetchJson follows a same-host redirect and then reads JSON', async () => {
  const seen = [];
  const request = fakeRequest((url, options) => {
    seen.push({ href: url.href || String(url), headers: options.headers || {} });
    if (seen.length === 1) return redirectResponse('/offers/b.json');
    return jsonResponse('{"priceHour":1}');
  });
  const body = await fetchJson(`${AWS_HOST}/offers/a?key=supersecret`, {
    request,
    headers: { 'X-Goog-Api-Key': 'supersecret' },
  });
  assert.deepEqual(body, { priceHour: 1 });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].href, `${AWS_HOST}/offers/b.json`);
  assert.equal(seen[1].headers['X-Goog-Api-Key'], 'supersecret');
});

test('fetchJson does not follow a cross-host redirect', async () => {
  let calls = 0;
  const request = fakeRequest(() => {
    calls += 1;
    return redirectResponse('https://evil.example/steal?key=supersecret');
  });
  await assert.rejects(
    fetchJson(`${AWS_HOST}/offers/a`, { request, headers: { 'X-Goog-Api-Key': 'supersecret' } }),
    /redirect/
  );
  assert.equal(calls, 1);
});

test('fetchJson stops after the redirect cap', async () => {
  let calls = 0;
  const request = fakeRequest(() => {
    calls += 1;
    return redirectResponse('/offers/loop');
  });
  await assert.rejects(fetchJson('https://prices.azure.com/api/retail/prices', { request }), /Too many redirects/);
  assert.equal(calls, MAX_REDIRECTS + 1);
  assert.equal(MAX_REDIRECTS, 5);
});

test('failed requests do not echo query secrets', async () => {
  const request = fakeRequest(() => ({
    statusCode: 403,
    headers: {},
    resume() {},
  }));
  await assert.rejects(
    fetchJson('https://cloudbilling.googleapis.com/v1/services?key=supersecret', { request }),
    (err) => {
      assert.equal(err.message.includes('supersecret'), false);
      assert.match(err.message, /403/);
      return true;
    }
  );
});
