app.post("/api/guide", async (req, res) => {
    const { url, question } = req.body;

    // 1. URL과 질문으로 캐시 키 생성
    const cachKey = createCachKey(url, question);

    // 2. Redis 조회
    const cachedResult = await getCache(cachKey);

    // 3. 캐시가 있으면 바로 반환
    if (cachedResult) {
        return res.json({
            cached: true,
            result: cachedResult,
        });
    }

    // 4. 캐시가 없으면 AI팀의 LLM 기능 호출
    const llmResult = await callLlm({
        question,
        elements,
    });

    // 5. LLM 결과를 Redis에 저장
    await setCache(cachKey, llmResult);

    // 6. 프론트에 반환
    return res.json({
        cached: false,
        result: llmResult,
    });
});