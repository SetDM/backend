const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const xhub = require('express-x-hub');

const config = require('./config/environment');
const router = require('./routes');
const notFoundHandler = require('./middleware/not-found-handler');
const errorHandler = require('./middleware/error-handler');

const captureRawBody = (req, res, buf) => {
  if (buf && req.originalUrl.startsWith('/api/webhooks')) {
    req.rawBody = Buffer.from(buf);
  }
};

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());

  if (config.instagram.appSecret) {
    app.use(xhub({ algorithm: 'sha1', secret: config.instagram.appSecret }));
  }

  app.use(bodyParser.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false }));

  if (config.nodeEnv !== 'test') {
    app.use(morgan(config.logFormat));
  }

  app.get('/', (req, res) => {
    res.json({ message: 'Welcome to the SetDM API' });
  });

  app.use(router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
