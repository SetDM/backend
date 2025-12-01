const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const privacyPolicyPath = path.resolve(__dirname, '..', '..', 'PRIVACY_POLICY.md');
let cachedHtml;

const loadPrivacyPolicy = () => {
  if (cachedHtml) {
    return cachedHtml;
  }

  const markdown = fs.readFileSync(privacyPolicyPath, 'utf8');
  cachedHtml = marked.parse(markdown);
  return cachedHtml;
};

const showPrivacyPolicy = (req, res, next) => {
  try {
    const html = loadPrivacyPolicy();
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8" /><title>Privacy Policy</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.6;color:#111;} h1,h2,h3{color:#0a0a0a;} pre{background:#f5f5f5;padding:12px;overflow:auto;} code{background:#f0f0f0;padding:2px 4px;border-radius:4px;} a{color:#2563eb;}</style></head><body>${html}</body></html>`);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  showPrivacyPolicy
};
