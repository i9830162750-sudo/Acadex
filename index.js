const https = require('https');
const Module = require('module');

const RAW_URL = 'https://raw.githubusercontent.com/i9830162750-sudo/Exam-tool/c3ea1d36252ee04726b859aa73600716bcf18aa4/index.js';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return fetchText(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error('GitHub fetch failed: HTTP ' + res.statusCode));
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  let source = await fetchText(RAW_URL);
  source = source.replace(/font-size:24px;\s+font-weight:800/g, 'font-size:24px; font-weight:800');

  const mod = new Module(__filename, module);
  mod.filename = __filename;
  mod.paths = Module._nodeModulePaths(__dirname);
  mod._compile(source, __filename);
})().catch(err => {
  console.error('Failed to bootstrap Exam backend:', err);
  process.exit(1);
});
