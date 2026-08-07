const { createClient } = require("redis");

//R Redis 서버에 연결할 클라이언트
const redis = createClient({
    url:process.env.REDIS_URL || "redis://localhost:6379",
});


redis.on("error", (error) => {
    console.error("Redis error:", error.message);
});

// Redis가 연결되지 않은 경우 redis 연결
async function connectRedis() {
    if(!redis.isOpen){
        await redis.connect();
    }
}

// 캐시 조회 후 JSON 객체로 변환
async function getCache(key) {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
}


// 
async function setCache(key, value) {
    await redis.set(key, JSON.stringify(value), {
        EX:86400,
    });
}

module.exports = {connectRedis, getCache, setCache};