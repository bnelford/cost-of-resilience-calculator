#!/usr/bin/env node
/**
 * Update catalog pricing from cloud providers (retail/on-demand).
 *
 * Notes:
 * - AWS uses public Price List API (downloads region JSON; can be 20–40 MB).
 * - Azure uses Retail Prices API (paged).
 * - GCP uses Cloud Billing Catalog and requires an API key (optional env).
 * - Network calls may be blocked in restricted environments; handle failures gracefully.
 *
 * Output: ./catalog.generated.json
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REGION = {
  aws: 'us-east-1',
  gcp: 'us-central1',
  azure: 'eastus',
};

// Catalog targets: tweak to your preferred SKUs.
const TARGETS = {
  aws: [
    { key: 'web-basic', instanceType: 't3.small', os: 'Linux', tenancy: 'Shared', preinstalled: 'NA' },
    { key: 'web-gpu', instanceType: 'g4dn.xlarge', os: 'Linux', tenancy: 'Shared', preinstalled: 'NA' },
    { key: 'db-ha', instanceType: 'r6g.large', os: 'Linux', tenancy: 'Shared', preinstalled: 'NA' },
    { key: 'cache-ha', instanceType: 'r6g.large', os: 'Linux', tenancy: 'Shared', preinstalled: 'NA' },
  ],
  azure: [
    { key: 'web-basic', skuName: 'Standard_B2s', serviceName: 'Virtual Machines' },
    { key: 'web-gpu', skuName: 'Standard_NC4as_T4_v3', serviceName: 'Virtual Machines' },
    { key: 'db-ha', skuName: 'SQLDB_GP_Gen5_4', serviceName: 'SQL Database' },
    { key: 'cache-ha', skuName: 'Standard_C2', serviceName: 'Azure Cache for Redis' },
  ],
  gcp: [
    { key: 'web-basic', sku: 'CP-COMPUTEENGINE-VMIMAGE-E2-MICRO' },
    { key: 'web-gpu', sku: 'CP-COMPUTEENGINE-GPU-NVIDIA-TESLA-T4' },
    { key: 'db-ha', sku: '95D8-1B15-7E1E' }, // example HA Cloud SQL Postgres
    { key: 'cache-ha', sku: '53F8-38E4-8F5E' }, // example MemoryStore
  ],
};

const OUTPUT_FILE = path.join(process.cwd(), 'catalog.generated.json');
const GCP_API_KEY = process.env.GCP_API_KEY; // optional; required for GCP fetch

const MAX_REDIRECTS = 5;
const AWS_PRICING_ORIGIN = 'https://pricing.us-east-1.amazonaws.com';

function redactSecrets(text) {
  return String(text)
    .replace(/([?&]key=)[^&\s'"]+/gi, '$1REDACTED')
    .replace(/(X-Goog-Api-Key['":=\s]+)[^\s'",]+/gi, '$1REDACTED');
}

function isBlockedHost(hostname) {
  const host = String(hostname || '').replace(/\.$/, '').toLowerCase();
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!bare) return true;
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) {
    return true;
  }
  if (bare.includes(':')) return true;
  if (/^\d+$/.test(bare)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return true;
  if (/^0x[0-9a-f.]+$/i.test(bare)) return true;
  return false;
}

function assertPublicHttpsUrl(urlString) {
  let url;
  try {
    url = urlString instanceof URL ? new URL(urlString.href) : new URL(String(urlString));
  } catch {
    throw new Error('Refusing invalid URL');
  }
  if (url.protocol !== 'https:') throw new Error('Refusing non-HTTPS URL');
  if (url.username || url.password) throw new Error('Refusing URL with credentials');
  if (isBlockedHost(url.hostname)) throw new Error('Refusing local, private, or raw-IP host');
  return url;
}

function awsOfferUrl(currentVersionUrl) {
  if (typeof currentVersionUrl !== 'string' || currentVersionUrl.length === 0) {
    throw new Error('Refusing invalid AWS price list URL');
  }
  let url;
  try {
    url = new URL(currentVersionUrl, AWS_PRICING_ORIGIN);
  } catch {
    throw new Error('Refusing invalid AWS price list URL');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'pricing.us-east-1.amazonaws.com') {
    throw new Error('Refusing unexpected AWS price list URL');
  }
  if (url.username || url.password) throw new Error('Refusing AWS price list URL with credentials');
  if (!url.pathname.startsWith('/offers/')) throw new Error('Refusing unexpected AWS price list URL');
  return url.href;
}

function nextRedirectUrl(currentUrl, location) {
  let current;
  let next;
  try {
    current = new URL(currentUrl);
    next = new URL(location, current);
  } catch {
    throw new Error('Refusing invalid redirect');
  }
  if (next.protocol !== 'https:') throw new Error('Refusing non-HTTPS redirect');
  if (next.username || next.password) throw new Error('Refusing redirect with credentials');
  if (next.hostname !== current.hostname || isBlockedHost(next.hostname)) {
    throw new Error('Refusing cross-host or blocked redirect');
  }
  return next.href;
}

function gcpSkuRequest(sku, apiKey) {
  return {
    url: `https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus/${encodeURIComponent(sku)}`,
    headers: apiKey ? { 'X-Goog-Api-Key': apiKey } : {},
  };
}

function defaultRequest(url, options, callback) {
  const requestOptions = { headers: options.headers || {} };
  if (options.agent) requestOptions.agent = options.agent;
  return https.get(url, requestOptions, callback);
}

function fetchJson(url, options = {}, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = assertPublicHttpsUrl(url);
    } catch (err) {
      reject(err);
      return;
    }
    const request = options.request || defaultRequest;
    let req;
    try {
      req = request(parsed, options, (res) => {
        const location = Array.isArray(res.headers && res.headers.location)
          ? res.headers.location[0]
          : res.headers && res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && location) {
          if (typeof res.resume === 'function') res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          let next;
          try {
            next = nextRedirectUrl(parsed.href, location);
          } catch (err) {
            reject(err);
            return;
          }
          const headers = new URL(next).hostname === parsed.hostname ? { ...(options.headers || {}) } : {};
          fetchJson(next, { ...options, headers }, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          if (typeof res.resume === 'function') res.resume();
          reject(new Error(redactSecrets(`Request failed ${res.statusCode} ${parsed.origin}${parsed.pathname}`)));
          return;
        }
        let data = '';
        if (typeof res.setEncoding === 'function') res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      });
    } catch (err) {
      reject(new Error(redactSecrets(err.message || String(err))));
      return;
    }
    if (req && typeof req.on === 'function') {
      req.on('error', (err) => {
        reject(new Error(redactSecrets(err.message || String(err))));
      });
    }
  });
}

function pickAwsOffer(product, terms) {
  const onDemand = terms?.OnDemand || {};
  const od = Object.values(onDemand)[0];
  if (!od) return null;
  const priceDimensions = od.priceDimensions || {};
  const dim = Object.values(priceDimensions)[0];
  if (!dim) return null;
  const rate = Number(dim.pricePerUnit?.USD);
  if (!rate) return null;
  return {
    priceHour: rate,
    unit: dim.unit,
    sku: product.sku,
    instanceType: product.attributes?.instanceType,
    availability: 0.995,
  };
}

async function fetchAws() {
  const regionIdxUrl = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/region_index.json';
  const regionIdx = await fetchJson(regionIdxUrl);
  const regionOffer = regionIdx.regions?.[REGION.aws];
  if (!regionOffer?.currentVersionUrl) throw new Error('AWS region URL missing');
  const offerUrl = awsOfferUrl(regionOffer.currentVersionUrl);
  const json = await fetchJson(offerUrl);
  const out = {};
  const products = json.products || {};
  const terms = json.terms || {};
  TARGETS.aws.forEach((target) => {
    const matchSku = Object.keys(products).find((sku) => {
      const p = products[sku];
      const a = p.attributes || {};
      return (
        a.instanceType === target.instanceType &&
        a.operatingSystem === target.os &&
        a.tenancy === target.tenancy &&
        a.preInstalledSw === target.preinstalled &&
        a.location === regionOffer.regionDescription
      );
    });
    if (!matchSku) return;
    const offer = pickAwsOffer(products[matchSku], terms[matchSku]);
    if (!offer) return;
    out[target.key] = {
      label: target.instanceType,
      availability: offer.availability,
      priceHour: offer.priceHour,
    };
  });
  return out;
}

async function fetchAzure() {
  const out = {};
  for (const target of TARGETS.azure) {
    const filter = [
      `armRegionName eq '${REGION.azure}'`,
      `serviceName eq '${target.serviceName}'`,
      `skuName eq '${target.skuName}'`,
      "priceType eq 'Consumption'",
    ].join(' and ');
    const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`;
    const json = await fetchJson(url);
    const item = (json.Items || []).find((i) => i.unitOfMeasure === '1 Hour');
    if (!item) continue;
    out[target.key] = {
      label: target.skuName,
      availability: 0.995,
      priceHour: Number(item.unitPrice),
    };
  }
  return out;
}

async function fetchGcp() {
  if (!GCP_API_KEY) {
    console.warn('Skipping GCP fetch (set GCP_API_KEY to enable).');
    return {};
  }
  const out = {};
  for (const target of TARGETS.gcp) {
    const { url, headers } = gcpSkuRequest(target.sku, GCP_API_KEY);
    const json = await fetchJson(url, { headers });
    const pricingInfo = json.pricingInfo?.[0];
    const tieredRates = pricingInfo?.pricingExpression?.tieredRates?.[0];
    const priceMicros = tieredRates?.unitPrice?.units + (tieredRates?.unitPrice?.nanos || 0) / 1e9;
    const priceHour = Number(priceMicros);
    if (!priceHour) continue;
    out[target.key] = {
      label: json.description || target.sku,
      availability: 0.995,
      priceHour,
    };
  }
  return out;
}

async function main() {
  console.log('Fetching catalogs (this may take ~30s for AWS EC2)...');
  const [aws, azure, gcp] = await Promise.allSettled([fetchAws(), fetchAzure(), fetchGcp()]);
  const catalog = {
    updatedAt: new Date().toISOString(),
    region: REGION,
    providers: {
      aws: aws.status === 'fulfilled' ? aws.value : {},
      azure: azure.status === 'fulfilled' ? azure.value : {},
      gcp: gcp.status === 'fulfilled' ? gcp.value : {},
    },
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalog, null, 2));
  console.log(`Wrote ${OUTPUT_FILE}`);
  if (aws.status === 'rejected') console.warn('AWS fetch failed:', redactSecrets(aws.reason.message));
  if (azure.status === 'rejected') console.warn('Azure fetch failed:', redactSecrets(azure.reason.message));
  if (gcp.status === 'rejected') console.warn('GCP fetch failed:', redactSecrets(gcp.reason.message));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(redactSecrets(err && err.stack ? err.stack : err));
    process.exit(1);
  });
}

module.exports = {
  MAX_REDIRECTS,
  awsOfferUrl,
  fetchJson,
  gcpSkuRequest,
  nextRedirectUrl,
  redactSecrets,
};
