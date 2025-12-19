const { MongoClient, ServerApiVersion } = require("mongodb");

const config = require("../config/environment");
const logger = require("../utils/logger");

let client;

const connectToDatabase = async () => {
    if (client) {
        return client;
    }

    if (!config.mongo.uri) {
        throw new Error("MongoDB connection failed: set MONGO_URI in your environment.");
    }

    const mongoClient = new MongoClient(config.mongo.uri, {
        serverApi: {
            version: ServerApiVersion.v1,
            strict: true,
            deprecationErrors: true,
        },
        // Render-friendly connection settings
        maxPoolSize: 10,
        minPoolSize: 2,
        maxIdleTimeMS: 30000,
        connectTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        retryWrites: true,
        retryReads: true,
    });

    try {
        await mongoClient.connect();
        await mongoClient.db("admin").command({ ping: 1 });
        logger.info(`Pinged MongoDB deployment successfully (using db: ${config.mongo.dbName})`);
        client = mongoClient;
        return client;
    } catch (error) {
        try {
            await mongoClient.close();
        } catch (closeError) {
            logger.warn("Failed to close MongoDB client after connection error", closeError);
        }
        client = null;
        logger.error("Failed to connect to MongoDB", error);
        throw error;
    }
};

const getDb = () => {
    if (!client) {
        throw new Error("MongoDB client not initialized. Call connectToDatabase() first.");
    }

    return client.db(config.mongo.dbName);
};

const disconnectFromDatabase = async () => {
    if (client) {
        await client.close();
        logger.info("MongoDB connection closed");
        client = null;
    }
};

module.exports = {
    connectToDatabase,
    getDb,
    disconnectFromDatabase,
};
