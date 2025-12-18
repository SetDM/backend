const config = require("../config/environment");

let fetchImpl;
const fetch = async (...args) => {
    if (!fetchImpl) {
        const mod = await import("node-fetch");
        fetchImpl = mod.default;
    }

    return fetchImpl(...args);
};

const DEFAULT_WEB_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36";

const INSTAGRAM_PROFILE_COOKIE = process.env.INSTAGRAM_PROFILE_COOKIE || null;

const ensureConfigured = () => {
    if (!config.instagram.appId || !config.instagram.appSecret) {
        const error = new Error("Instagram OAuth is not configured.");
        error.statusCode = 500;
        throw error;
    }
};

const getMetaGraphBaseUrl = () => (config.metaGraphApiBase || "https://graph.instagram.com/v24.0").replace(/\/$/, "");

const resolveRedirectUri = (overrideRedirectUri) => {
    return overrideRedirectUri || config.instagram.redirectUri;
};

const buildAuthorizationUrl = ({ state, redirectUri } = {}) => {
    ensureConfigured();

    const resolvedRedirectUri = resolveRedirectUri(redirectUri);

    if (!resolvedRedirectUri) {
        const error = new Error("Instagram redirect URI is not configured.");
        error.statusCode = 500;
        throw error;
    }

    const params = new URLSearchParams({
        client_id: config.instagram.appId,
        redirect_uri: resolvedRedirectUri,
        scope: config.instagram.scopes.join(","),
        response_type: "code",
    });

    if (state) {
        params.append("state", state);
    }

    return `${config.instagram.oauthUrl}?${params.toString()}`;
};

const exchangeCodeForToken = async ({ code, redirectUri } = {}) => {
    ensureConfigured();

    const resolvedRedirectUri = resolveRedirectUri(redirectUri);

    if (!resolvedRedirectUri) {
        const error = new Error("Instagram redirect URI is not configured.");
        error.statusCode = 500;
        throw error;
    }

    const body = new URLSearchParams({
        client_id: config.instagram.appId,
        client_secret: config.instagram.appSecret,
        grant_type: "authorization_code",
        redirect_uri: resolvedRedirectUri,
        code,
    });

    const response = await fetch(config.instagram.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!response.ok) {
        const errorPayload = await response.text();
        const error = new Error(`Instagram token exchange failed: ${errorPayload}`);
        error.statusCode = response.status;
        throw error;
    }

    return response.json();
};

const exchangeForLongLivedToken = async (shortLivedToken) => {
    ensureConfigured();

    const params = new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: config.instagram.appSecret,
        access_token: shortLivedToken,
    });

    const response = await fetch(`${config.instagram.graphApiBase}/access_token?${params.toString()}`);

    if (!response.ok) {
        const errorPayload = await response.text();
        const error = new Error(`Instagram long-lived token exchange failed: ${errorPayload}`);
        error.statusCode = response.status;
        throw error;
    }

    return response.json();
};

const fetchUserProfile = async (accessToken) => {
    const params = new URLSearchParams({
        fields: "user_id,username,account_type",
        access_token: accessToken,
    });

    const response = await fetch(`${config.instagram.graphApiBase}/me?${params.toString()}`);

    if (!response.ok) {
        const errorPayload = await response.text();
        const error = new Error(`Instagram profile lookup failed: ${errorPayload}`);
        error.statusCode = response.status;
        throw error;
    }

    return response.json();
};

const fetchInstagramProfileById = async ({ instagramId, accessToken, fields }) => {
    if (!instagramId || !accessToken) {
        throw new Error("Missing parameters for Instagram profile lookup.");
    }

    const resolvedFields = Array.isArray(fields) && fields.length > 0 ? fields.join(",") : "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user";

    const params = new URLSearchParams({
        fields: resolvedFields,
        access_token: accessToken,
    });

    const url = `${getMetaGraphBaseUrl()}/${instagramId}?${params.toString()}`;
    const response = await fetch(url);
    const payload = await response.json();

    if (!response.ok) {
        const error = new Error("Failed to fetch Instagram user profile.");
        error.statusCode = response.status;
        error.details = payload;
        throw error;
    }

    return payload;
};

const safeJsonParse = (value) => {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
};

const decodeJsonString = (value) => {
    if (typeof value !== "string") {
        return null;
    }

    try {
        const normalized = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return JSON.parse(`"${normalized}"`);
    } catch {
        return value;
    }
};

const HTML_ENTITY_MAP = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
};

const decodeHtmlEntities = (value) => {
    if (typeof value !== "string" || !value.includes("&")) {
        return value;
    }

    return value
        .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/&([a-z]+);/gi, (_m, name) => HTML_ENTITY_MAP[name.toLowerCase()] || _m);
};

const extractBioFromNextData = (html) => {
    const match = html.match(/<script type="application\/json" id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) {
        return null;
    }

    const payload = safeJsonParse(match[1]);
    if (!payload) {
        return null;
    }

    const candidates = [payload?.props?.pageProps?.profileGridData?.userInfo?.biography, payload?.props?.pageProps?.userInfo?.biography, payload?.props?.pageProps?.user?.biography];

    return candidates.find((bio) => typeof bio === "string" && bio.length) || null;
};

const extractBioFromSharedData = (html) => {
    const match = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});<\/script>/);
    if (!match) {
        return null;
    }

    const payload = safeJsonParse(match[1]);
    if (!payload) {
        return null;
    }

    return payload?.entry_data?.ProfilePage?.[0]?.graphql?.user?.biography || payload?.entry_data?.ProfilePage?.[0]?.user?.biography || null;
};

const extractBioFallback = (html) => {
    const match = html.match(/"biography":"(.*?)"/);
    if (!match) {
        return null;
    }

    return decodeJsonString(match[1]);
};

const extractBioFromMetaDescription = (html) => {
    const match = html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']\s*\/?>(?:<\/meta>)?/i);
    if (!match) {
        return null;
    }

    const decoded = decodeHtmlEntities(match[1]).trim();
    if (!decoded) {
        return null;
    }

    const bioMatch = decoded.match(/on Instagram:\s*"([\s\S]*?)"\s*$/i);
    return bioMatch ? bioMatch[1].trim() : decoded;
};

const extractInstagramBioFromHtml = (html) => {
    if (typeof html !== "string" || !html.trim()) {
        return null;
    }

    return extractBioFromNextData(html) || extractBioFromSharedData(html) || extractBioFromMetaDescription(html) || extractBioFallback(html);
};

const fetchInstagramBioByUsername = async (username) => {
    const normalizedUsername = String(username || "")
        .trim()
        .replace(/^@+/, "");

    if (!normalizedUsername) {
        const error = new Error("username is required to fetch Instagram bio.");
        error.statusCode = 400;
        throw error;
    }

    const url = `https://www.instagram.com/${encodeURIComponent(normalizedUsername)}/`;
    const headers = {
        "User-Agent": process.env.INSTAGRAM_WEB_USER_AGENT || DEFAULT_WEB_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Referer: "https://www.instagram.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    };

    if (INSTAGRAM_PROFILE_COOKIE) {
        headers.Cookie = INSTAGRAM_PROFILE_COOKIE;
    }

    const response = await fetch(url, { headers });

    if (response.status === 404) {
        const error = new Error("Instagram profile not found.");
        error.statusCode = 404;
        throw error;
    }

    if (!response.ok) {
        const error = new Error("Failed to load Instagram profile page.");
        error.statusCode = response.status;
        throw error;
    }

    const html = await response.text();
    const biography = extractInstagramBioFromHtml(html);

    if (typeof biography !== "string") {
        const error = new Error("Unable to extract biography from Instagram profile page.");
        error.statusCode = 502;
        throw error;
    }

    return {
        username: normalizedUsername,
        biography,
    };
};

const getConversationIdForUser = async ({ instagramBusinessId, userId, accessToken }) => {
    if (!instagramBusinessId || !userId || !accessToken) {
        throw new Error("Missing parameters for conversation lookup.");
    }

    const params = new URLSearchParams({
        user_id: userId,
        access_token: accessToken,
    });

    const url = `${getMetaGraphBaseUrl()}/${instagramBusinessId}/conversations?${params.toString()}`;
    const response = await fetch(url);
    const payload = await response.json();

    if (!response.ok) {
        const error = new Error("Failed to fetch Instagram conversation list.");
        error.statusCode = response.status;
        error.details = payload;
        throw error;
    }

    return payload?.data?.[0]?.id || null;
};

const getConversationMessages = async ({ conversationId, accessToken }) => {
    if (!conversationId || !accessToken) {
        throw new Error("Missing parameters for conversation messages lookup.");
    }

    const params = new URLSearchParams({
        fields: "messages{from,to,text,created_time,id}",
        access_token: accessToken,
    });

    const url = `${getMetaGraphBaseUrl()}/${conversationId}?${params.toString()}`;
    const response = await fetch(url);
    const payload = await response.json();

    if (!response.ok) {
        const error = new Error("Failed to fetch Instagram conversation messages.");
        error.statusCode = response.status;
        error.details = payload;
        throw error;
    }

    return payload?.messages?.data || [];
};

const subscribeAppToUser = async ({ instagramBusinessId, accessToken, fields = ["comments", "messages"] }) => {
    if (!instagramBusinessId || !accessToken) {
        throw new Error("Missing parameters for Instagram subscription.");
    }

    const params = new URLSearchParams({
        subscribed_fields: fields.join(","),
        access_token: accessToken,
    });

    const url = `${getMetaGraphBaseUrl()}/${instagramBusinessId}/subscribed_apps?${params.toString()}`;
    const response = await fetch(url, { method: "POST" });
    const payload = await response.json();

    if (!response.ok) {
        const error = new Error("Failed to subscribe Instagram app to user events.");
        error.statusCode = response.status;
        error.details = payload;
        throw error;
    }

    return payload;
};

module.exports = {
    buildAuthorizationUrl,
    exchangeCodeForToken,
    exchangeForLongLivedToken,
    fetchUserProfile,
    fetchInstagramProfileById,
    fetchInstagramBioByUsername,
    getConversationIdForUser,
    getConversationMessages,
    subscribeAppToUser,
};
