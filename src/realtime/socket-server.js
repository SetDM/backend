const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const jwt = require("jsonwebtoken");
const config = require("../config/environment");
const logger = require("../utils/logger");
const { getInstagramUserById } = require("../services/instagram-user.service");
const { conversationEvents, REALTIME_EVENTS } = require("../events/conversation.events");
const { getPubSubClients } = require("../database/redis");

let ioInstance = null;
const boundListeners = [];

const buildBusinessRoom = (instagramId) => {
    if (!instagramId) {
        return null;
    }

    const normalized = String(instagramId).trim();
    return normalized ? `business:${normalized}` : null;
};

const parseCookies = (headerValue = "") => {
    return headerValue
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((acc, part) => {
            const separatorIndex = part.indexOf("=");
            if (separatorIndex === -1) {
                return acc;
            }
            const key = part.slice(0, separatorIndex).trim();
            const rawValue = part.slice(separatorIndex + 1).trim();
            if (!key) {
                return acc;
            }
            acc[key] = decodeURIComponent(rawValue);
            return acc;
        }, {});
};

const extractTokenFromHandshake = (handshake = {}) => {
    const authToken = handshake.auth?.token;
    if (typeof authToken === "string" && authToken.length > 0) {
        return authToken;
    }

    const queryToken = handshake.query?.token;
    if (typeof queryToken === "string" && queryToken.length > 0) {
        return queryToken;
    }
    if (Array.isArray(queryToken) && queryToken.length > 0 && typeof queryToken[0] === "string") {
        return queryToken[0];
    }

    const headerToken = handshake.headers?.authorization;
    if (typeof headerToken === "string" && headerToken.startsWith("Bearer ")) {
        return headerToken.slice("Bearer ".length).trim();
    }

    const cookies = parseCookies(handshake.headers?.cookie || "");
    if (cookies[config.session.cookieName]) {
        return cookies[config.session.cookieName];
    }

    return null;
};

const registerConversationEventBridge = () => {
    if (!ioInstance || boundListeners.length) {
        return;
    }

    const forwardEvent =
        (eventName) =>
        (payload = {}) => {
            if (!ioInstance) {
                return;
            }

            const target = payload.recipientId ?? payload.businessId ?? null;
            const room = buildBusinessRoom(target);
            if (!room) {
                return;
            }

            ioInstance.to(room).emit(eventName, payload);
        };

    [REALTIME_EVENTS.MESSAGE_CREATED, REALTIME_EVENTS.QUEUE_UPDATED, REALTIME_EVENTS.UPSERTED].forEach((eventName) => {
        const handler = forwardEvent(eventName);
        conversationEvents.on(eventName, handler);
        boundListeners.push([eventName, handler]);
    });
};

const clearConversationEventBridge = () => {
    boundListeners.forEach(([eventName, handler]) => {
        conversationEvents.off(eventName, handler);
    });
    boundListeners.length = 0;
};

const initializeSocketServer = async (httpServer) => {
    if (ioInstance) {
        return ioInstance;
    }

    const allowedOrigins = config.cors?.allowedOrigins || [];
    ioInstance = new Server(httpServer, {
        cors: {
            origin: allowedOrigins.length ? allowedOrigins : true,
            credentials: true,
        },
        pingTimeout: 20000,
        pingInterval: 25000,
    });

    // Set up Redis adapter for horizontal scaling
    const pubSubClients = await getPubSubClients();
    if (pubSubClients) {
        const { pubClient, subClient } = pubSubClients;
        ioInstance.adapter(createAdapter(pubClient, subClient));
        logger.info("Socket.io Redis adapter enabled - ready for horizontal scaling");
    } else {
        logger.info("Socket.io running without Redis adapter (single server mode)");
    }

    ioInstance.use(async (socket, next) => {
        try {
            const token = extractTokenFromHandshake(socket.handshake);
            if (!token) {
                throw new Error("Missing authentication token");
            }

            const payload = jwt.verify(token, config.auth.jwtSecret);
            if (!payload?.instagramId) {
                throw new Error("Invalid authentication payload");
            }

            const user = await getInstagramUserById(payload.instagramId);
            if (!user) {
                throw new Error("User session not found");
            }

            socket.data.auth = {
                instagramId: payload.instagramId,
                token,
            };

            const room = buildBusinessRoom(payload.instagramId);
            if (room) {
                socket.join(room);
            }

            return next();
        } catch (error) {
            logger.warn("Realtime socket authentication failed", {
                error: error.message,
            });
            return next(new Error("Unauthorized"));
        }
    });

    ioInstance.on("connection", (socket) => {
        const instagramId = socket.data?.auth?.instagramId || "unknown";
        logger.info("Realtime client connected", {
            socketId: socket.id,
            instagramId,
        });

        socket.on("disconnect", (reason) => {
            logger.info("Realtime client disconnected", {
                socketId: socket.id,
                instagramId,
                reason,
            });
        });
    });

    registerConversationEventBridge();

    return ioInstance;
};

const shutdownSocketServer = async () => {
    if (!ioInstance) {
        return;
    }

    clearConversationEventBridge();

    await new Promise((resolve) => {
        ioInstance.close(() => resolve());
    });

    ioInstance = null;
};

module.exports = {
    initializeSocketServer,
    shutdownSocketServer,
};
