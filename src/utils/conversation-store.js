const fs = require('fs');
const path = require('path');

const logDir = path.resolve(process.cwd(), 'logs');
const logFile = path.join(logDir, 'instagram-messages.log');

const ensureLogDir = () => {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
};

const appendEntry = (entry) => {
  ensureLogDir();
  const payload = {
    timestamp: new Date().toISOString(),
    ...entry
  };
  fs.appendFileSync(logFile, `${JSON.stringify(payload)}\n`, 'utf8');
};

module.exports = {
  appendEntry
};
