const assert = require('node:assert/strict');
const test = require('node:test');
const { launchChrome } = require('./chrome-page');

async function withPage(fn) {
  const page = await launchChrome();
  try {
    await fn(page);
  } finally {
    page.close();
  }
}

function expectMetrics(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, key);
  }
}

test('default and edited scenarios keep the same calculator results', { timeout: 90000 }, async () => {
  await withPage(async (page) => {
    await page.openCalculator();
    expectMetrics(await page.metrics(), {
      availability: '99.897%',
      gap: '0.003%',
      downtime: '540.8 min',
      downtimeCost: '$811,241',
      monthly: '$548',
      annual: '$6,570',
      replicas: ['2', '1', '2'],
      names: ['API Gateway', 'Primary Database', 'Async Queue'],
      nums: ['99.500', '0.06', '99.900', '0.55', '99.800', '0.04'],
    });

    await page.evaluate(`(() => {
      const set = (id, value, type) => {
        const el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event(type, { bubbles: true }));
      };
      set('target-slo', '0.9999', 'change');
      set('revenue-per-minute', '2500', 'input');
      set('period', 'month', 'change');
    })()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.897%',
      gap: '0.093%',
      downtime: '44.5 min',
      downtimeCost: '$111,129',
      monthly: '$548',
      annual: '$6,570',
    });

    await page.openCalculator();
    await page.evaluate(`document.querySelector('[data-template="simple"]').click()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.898%',
      gap: '0.002%',
      downtime: '538.7 min',
      downtimeCost: '$808,090',
      monthly: '$343',
      annual: '$4,117',
      replicas: ['2', '1'],
      names: ['Web compute node', 'Relational DB (single AZ)'],
      nums: ['99.500', '0.06', '99.900', '0.35'],
    });

    await page.openCalculator();
    await page.evaluate(`document.querySelector('[data-template="tiered"]').click()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.949%',
      gap: '0.000%',
      downtime: '265.5 min',
      downtimeCost: '$398,239',
      monthly: '$927',
      annual: '$11,125',
      replicas: ['2', '3', '2', '1'],
      names: ['CDN / edge', 'Web compute node', 'In-memory cache (HA)', 'Relational DB (HA / multi-AZ)'],
      nums: ['99.800', '0.02', '99.500', '0.06', '99.900', '0.25', '99.950', '0.55'],
    });

    await page.openCalculator();
    await page.evaluate(`document.querySelector('[data-template="large"]').click()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.997%',
      gap: '0.000%',
      downtime: '15.4 min',
      downtimeCost: '$23,068',
      monthly: '$2,767',
      annual: '$33,200',
      replicas: ['3', '6', '3', '3', '2', '2', '2'],
    });

    await page.openCalculator();
    await page.evaluate(`(() => {
      const el = document.getElementById('cloud-provider');
      el.value = 'gcp';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.947%',
      gap: '0.000%',
      downtime: '276.5 min',
      downtimeCost: '$414,688',
      monthly: '$530',
      annual: '$6,360',
      nums: ['99.500', '0.065', '99.950', '0.52', '99.900', '0.038'],
    });

    await page.openCalculator();
    await page.evaluate(`(() => {
      const el = document.getElementById('cloud-provider');
      el.value = 'azure';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.947%',
      gap: '0.000%',
      downtime: '276.5 min',
      downtimeCost: '$414,688',
      monthly: '$520',
      annual: '$6,237',
      nums: ['99.500', '0.07', '99.950', '0.5', '99.900', '0.036'],
    });

    await page.openCalculator();
    await page.evaluate(`document.getElementById('optimize').click()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '100.000%',
      gap: '0.000%',
      downtime: '0.0 min',
      downtimeCost: '$8',
      monthly: '$1,467',
      annual: '$17,608',
      replicas: ['4', '3', '3'],
      names: ['API Gateway', 'Primary Database', 'Async Queue'],
    });

    await page.openCalculator();
    await page.evaluate(`document.querySelector('[data-inc]').click()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.900%',
      gap: '0.000%',
      downtime: '527.8 min',
      downtimeCost: '$791,649',
      monthly: '$591',
      annual: '$7,096',
      replicas: ['3', '1', '2'],
    });

    await page.openCalculator();
    await page.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('[data-lookup]')];
      buttons[1].click();
    })()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.947%',
      gap: '0.000%',
      downtime: '278.0 min',
      downtimeCost: '$417,052',
      monthly: '$548',
      annual: '$6,570',
      nums: ['99.500', '0.06', '99.950', '0.55', '99.800', '0.04'],
    });

    await page.openCalculator();
    await page.evaluate(`(() => {
      document.getElementById('catalog-select').value = 'search';
      document.getElementById('add-catalog').click();
    })()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.697%',
      gap: '0.203%',
      downtime: '1590.9 min',
      downtimeCost: '$2,386,418',
      monthly: '$840',
      annual: '$10,074',
      names: ['API Gateway', 'Primary Database', 'Async Queue', 'Search cluster'],
      replicas: ['2', '1', '2', '1'],
      nums: ['99.500', '0.06', '99.900', '0.55', '99.800', '0.04', '99.800', '0.4'],
    });

    await page.openCalculator();
    await page.evaluate(`(() => {
      document.getElementById('add-component').click();
      let inputs = [...document.querySelectorAll('#components-list .card')].at(-1).querySelectorAll('input');
      inputs[1].value = '99.5';
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
      inputs = [...document.querySelectorAll('#components-list .card')].at(-1).querySelectorAll('input');
      inputs[2].value = '0.2';
      inputs[2].dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.settle();
    expectMetrics(await page.metrics(), {
      availability: '99.398%',
      gap: '0.502%',
      downtime: '3166.1 min',
      downtimeCost: '$4,749,184',
      monthly: '$694',
      annual: '$8,322',
      replicas: ['2', '1', '2', '1'],
      names: ['API Gateway', 'Primary Database', 'Async Queue', 'New component'],
      nums: ['99.500', '0.06', '99.900', '0.55', '99.800', '0.04', '99.500', '0.2'],
    });
  });
});

test('component names cannot break out of the markup', { timeout: 30000 }, async () => {
  await withPage(async (page) => {
    await page.openCalculator();
    const result = await page.evaluate(`(async () => {
      window.__xss = 0;
      const payloads = [
        '"><img src=x onerror="window.__xss=1">',
        '"><details open ontoggle="window.__xss=3">',
        'Primary "DB" & cache'
      ];
      const seen = [];
      for (const payload of payloads) {
        window.__xss = 0;
        const input = document.querySelector('#components-list input[type="text"]');
        input.value = payload;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 400));
        seen.push({
          payload,
          xss: window.__xss,
          injected: document.querySelectorAll('#components-list img, #components-list details, #components-list svg').length,
          name: document.querySelector('#components-list input[type="text"]').value,
          availability: document.getElementById('overall-availability').textContent,
          monthly: document.getElementById('monthly-cost').textContent
        });
      }
      return seen;
    })()`);

    assert.equal(result.length, 3);
    for (const entry of result) {
      assert.equal(entry.xss, 0, entry.payload);
      assert.equal(entry.injected, 0, entry.payload);
      assert.equal(entry.name, entry.payload, entry.payload);
      assert.equal(entry.availability, '99.897%');
    }
    assert.equal(result[2].monthly, '$548');
  });
});
