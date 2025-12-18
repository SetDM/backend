const { createClient } = require('redis');
const config = require('../config/environment');
const logger = require('../utils/logger');

let client = null;
let pubClient = null;
let subClient = null;

/**
 * Connect to Redis
 * @returns {Promise<RedisClient|null>} Redis client or null if not configured
 */
const connectToRedis = async () => {
  if (client) {
    return client;
  }

  if (!config.redis?.url) {
    logger.info('REDIS_URL not set, Redis features disabled (using in-memory fallback)');
    return null;
  }

  try {
    client = createClient({ url: config.redis.url });
    
    client.on('error', (err) => {
      logger.error('Redis client error', { error: err.message });
    });

    client.on('reconnecting', () => {
      logger.info('Redis client reconnecting...');
    });

    await client.connect();
    logger.info('Connected to Redis');
    return client;
  } catch (error) {
    logger.error('Failed to connect to Redis', { error: error.message });
    client = null;
    return null;
  }
};

/**
 * Get the Redis client (null if not connected)
 */
const getRedis = () => client;

/**
 * Get pub/sub clients for Socket.io adapter
 * Creates duplicate connections for pub/sub
 */
const getPubSubClients = async () => {
  if (!client) {
    return null;
  }

  if (pubClient && subClient) {
    return { pubClient, subClient };
  }

  try {
    pubClient = client.duplicate();
    subClient = client.duplicate();
    
    await Promise.all([
      pubClient.connect(),
      subClient.connect()
    ]);

    logger.info('Redis pub/sub clients created');
    return { pubClient, subClient };
  } catch (error) {
    logger.error('Failed to create Redis pub/sub clients', { error: error.message });
    pubClient = null;
    subClient = null;
    return null;
  }
};

/**
 * Disconnect from Redis
 */
const disconnectFromRedis = async () => {
  const clients = [client, pubClient, subClient].filter(Boolean);
  
  await Promise.all(
    clients.map(async (c) => {
      try {
        await c.quit();
      } catch (error) {
        logger.warn('Error closing Redis connection', { error: error.message });
      }
    })
  );

  client = null;
  pubClient = null;
  subClient = null;
  logger.info('Redis connections closed');
};

// Cache helpers with graceful fallback
const CACHE_PREFIX = 'setdm:';

/**
 * Get a cached value
 * @param {string} key - Cache key
 * @returns {Promise<string|null>} Cached value or null
 */
const getCached = async (key) => {
  if (!client) return null;
  
  try {
    return await client.get(`${CACHE_PREFIX}${key}`);
  } catch (error) {
    logger.warn('Redis GET failed', { key, error: error.message });
    return null;
  }
};

/**
 * Set a cached value with TTL
 * @param {string} key - Cache key
 * @param {string} value - Value to cache
 * @param {number} ttlSeconds - Time to live in seconds (default 5 minutes)
 */
const setCached = async (key, value, ttlSeconds = 300) => {
  if (!client) return;
  
  try {
    await client.setEx(`${CACHE_PREFIX}${key}`, ttlSeconds, value);
  } catch (error) {
    logger.warn('Redis SET failed', { key, error: error.message });
  }
};

/**
 * Delete a cached value
 * @param {string} key - Cache key
 */
const deleteCached = async (key) => {
  if (!client) return;
  
  try {
    await client.del(`${CACHE_PREFIX}${key}`);
  } catch (error) {
    logger.warn('Redis DEL failed', { key, error: error.message });
  }
};

/**
 * Delete all cached values matching a pattern
 * @param {string} pattern - Pattern to match (e.g., 'prompt:*')
 */
const deleteCachedPattern = async (pattern) => {
  if (!client) return;
  
  try {
    const keys = await client.keys(`${CACHE_PREFIX}${pattern}`);
    if (keys.length > 0) {
      await client.del(keys);
    }
  } catch (error) {
    logger.warn('Redis pattern DEL failed', { pattern, error: error.message });
  }
};

module.exports = {
  connectToRedis,
  getRedis,
  getPubSubClients,
  disconnectFromRedis,
  getCached,
  setCached,
  deleteCached,
  deleteCachedPattern
};
