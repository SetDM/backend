const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const xhub = require('express-x-hub');

const config = require('./config/environment');
const router = require('./routes');
const notFoundHandler = require('./middleware/not-found-handler');
const errorHandler = require('./middleware/error-handler');
const { attachSession } = require('./middleware/session-auth');
const { showPrivacyPolicy } = require('./controllers/privacy.controller');
const path = require('path');

const captureRawBody = (req, res, buf) => {
  if (buf && req.originalUrl.startsWith('/api/webhooks')) {
    req.rawBody = Buffer.from(buf);
  }
};

function createApp() {
  const app = express();
  app.set('trust proxy', true);

  app.use(helmet());

  const allowedOrigins = config.cors?.allowedOrigins || [];
  const corsOptions = {
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
  };

  app.use(cors(corsOptions));
  app.options(/.*/, cors(corsOptions));

  if (config.instagram.appSecret) {
    app.use(xhub({ algorithm: 'sha1', secret: config.instagram.appSecret }));
  }

  app.use(cookieParser());
  app.use(bodyParser.json({ verify: captureRawBody }));
  app.use(express.urlencoded({ extended: false }));
  app.use(attachSession);

  if (config.nodeEnv !== 'test') {
    app.use(morgan(config.logFormat));
  }

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'googlee549e20a54b0f0da.html'));
  });

  app.get('/privacy', showPrivacyPolicy);

  app.get('/googlee549e20a54b0f0da.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'googlee549e20a54b0f0da.html'));
  });

  app.use(router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
