const createApp = require('./app');
const { connectToDatabase } = require('./database/mongo');

let cachedApp;
let initPromise;

const getAppInstance = async () => {
  if (cachedApp) {
    return cachedApp;
  }

  if (!initPromise) {
    initPromise = connectToDatabase()
      .then(() => {
        cachedApp = createApp();
        return cachedApp;
      })
      .catch((error) => {
        initPromise = null;
        throw error;
      });
  }

  return initPromise;
};

module.exports = async (req, res) => {
  const app = await getAppInstance();
  return app(req, res);
};
