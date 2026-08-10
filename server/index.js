app.post("/api/guide", async (req, res) => {
    const { url, question, elements } = req.body;

    // 입력값 확인
    if (
        typeof url !== "string" ||
        typeof question !== "string" ||
        !question.trim() ||
        !Array.isArray(elements)
    ) {
        return res.status(400).json({ 
            error: "url, question, elements가 필요합니다." 
        });
    }

    // 1. URL과 질문으로 캐시 키 생성
    const cacheKey = createCacheKey(url, question, elements);

    // 2. Redis 조회
    let cachedResult = null;

    try {
        cachedResult = await getCache(cacheKey);
    } catch (error) {
        console.error("Cache read failed:", error.message);
    }

    // 3. 캐시가 있으면 바로 반환
    if (cachedResult !== null) {
        return res.json({
            cached: true,
            result: cachedResult,
        });
    }

    // 4. 캐시가 없으면 AI팀의 LLM 기능 호출
    let llmResult;

    try {
        llmResult = await callLlm({
            question,
            elements,
        });
    } catch (error) {
        console.error("LLM call failed:", error.message);

        return res.status(502).json({ 
            error: "LLM 호출에 실패하였습니다."
        });
    }
    // 5. LLM 응답형식
    if (!llmResult || !Array.isArray(llmResult.steps)) {
        return res.status(502).json({ 
            error: "LLM 응답 형식이 올바르지 않습니다."
        });
    }

    // 6. LLM 결과를 Redis에 저장
    try{
        await setCache(cacheKey, llmResult);
    } catch(error){
        console.error("Cache write failed:", error.message);
    }
    

    // 7. 프론트에 반환
    return res.json({
        cached: false,
        result: llmResult,
    });

    // TODO: AI팀 LLM 연동 후 callLlm() 호출로 교체
    return res.status(501).json({
        cached: false,
        error: "LLM 연동 대기 중입니다.",
    });
});
