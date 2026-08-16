const { connectRedis, getCache, setCache } = require("./cache");

async function test() {
  await connectRedis();

  await setCache("test-question", {
    targetId: "login-button",
    message: "로그인 버튼을 누르세요.",
  });

  const result = await getCache("test-question");
  console.log(result);

  process.exit(0);
}

test().catch(console.error);