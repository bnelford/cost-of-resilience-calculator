const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Chrome/Chromium not found');
  return found;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
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
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchChrome() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-chrome-'));
  const chrome = spawn(chromePath(), [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--lang=en-US',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let targets;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(targets) && targets.length) break;
    } catch {
      // DevTools endpoint is not up yet.
    }
    await sleep(100);
  }
  if (!targets || !targets.length) {
    chrome.kill();
    throw new Error('Chrome DevTools endpoint did not start');
  }

  const page = targets.find((target) => target.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });

  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  function send(method, params = {}, timeoutMs = 15000) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const message = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (message.result.exceptionDetails) {
      const details = message.result.exceptionDetails;
      const text = details.exception && details.exception.description
        ? details.exception.description
        : JSON.stringify(details);
      throw new Error(text);
    }
    return message.result.result.value;
  }

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    async openCalculator() {
      await send('Page.navigate', { url: PAGE_URL });
      const start = Date.now();
      while (Date.now() - start < 8000) {
        const ready = await evaluate(
          'document.readyState === "complete" && !!(document.getElementById("overall-availability") && document.querySelector("#components-list input"))'
        );
        if (ready) break;
        await sleep(50);
      }
      await this.settle();
    },
    evaluate,
    async settle() {
      let previous = null;
      let stable = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = await evaluate(
          '[document.getElementById("monthly-cost").textContent, document.getElementById("annual-cost").textContent, document.getElementById("overall-availability").textContent].join("|")'
        );
        if (current === previous) stable += 1;
        else stable = 0;
        previous = current;
        if (stable >= 4) return;
        await sleep(80);
      }
    },
    metrics() {
      return evaluate(`(() => ({
        availability: document.getElementById('overall-availability').textContent,
        gap: document.getElementById('resilience-gap').textContent,
        downtime: document.getElementById('downtime-minutes').textContent,
        downtimeCost: document.getElementById('downtime-cost').textContent,
        monthly: document.getElementById('monthly-cost').textContent,
        annual: document.getElementById('annual-cost').textContent,
        replicas: [...document.querySelectorAll('.replica-count')].map((el) => el.textContent),
        names: [...document.querySelectorAll('#components-list input[type="text"]')].map((el) => el.value),
        nums: [...document.querySelectorAll('#components-list input[type="number"]')].map((el) => el.value)
      }))()`);
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
      try { chrome.kill('SIGKILL'); } catch { /* already exited */ }
      try {
        fs.rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Chrome can still be releasing the profile. Leftover temp files are harmless.
      }
    },
  };
}

module.exports = { launchChrome };
