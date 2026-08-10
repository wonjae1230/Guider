const { createClient } = require("redis");

// Redis 클라이언트 생성
// reconnectStrategy: 최대 3회 재시도 후 중단 (Redis 미설치 환경에서 무한 스팸 방지)
const redis = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
    socket: {
        reconnectStrategy: (retries) => {
            if (retries >= 3) return false; // 3회 초과 시 재연결 중단
            return retries * 200;           // 200ms, 400ms, 600ms 간격으로 재시도
        },
    },
});

redis.on("error", (error) => {
    // 연결 오류는 한 번만 출력 (반복 스팸 방지)
    if (!redis._errorLogged) {
        console.warn("[Redis] 연결 실패 (캐시 없이 계속 진행합니다):", error.code || error.message);
        redis._errorLogged = true;
    }
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