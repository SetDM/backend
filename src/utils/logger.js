const levels = ['debug', 'info', 'warn', 'error'];

const logger = levels.reduce((acc, level) => {
  acc[level] = (...args) => {
    const timestamp = new Date().toISOString();
    // Prefix log lines with timestamp + level for easier parsing
    console[level === 'debug' ? 'log' : level](`[${timestamp}] [${level.toUpperCase()}]`, ...args);
  };
  return acc;
}, {});

module.exports = logger;
