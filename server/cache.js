const NodeCache = require("node-cache");

// 기본 TTL 86400초(24시간) 설정
const myCache = new NodeCache({ stdTTL: 86400 });

async function connectRedis() {
    return true;
}

async function getCache(key) {
    try {
        const value = myCache.get(key);
        return value !== undefined ? value : null;
    } catch (error) {
        console.error("[Cache] getCache 오류:", error.message);
        return null;
    }
}

async function setCache(key, value, ttlSeconds = 86400) {
    try {
        myCache.set(key, value, ttlSeconds);
    } catch (error) {
        console.error("[Cache] setCache 오류:", error.message);
    }
}

module.exports = { connectRedis, getCache, setCache };