import assert from "node:assert/strict";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createAppServer } from "../server.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };
const validResult = { topic: "other", draft: "Спасибо за обращение." };

async function startServer(t, classifyMessage) {
  const server = createAppServer(classifyMessage ? { classifyMessage } : {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  });
  const url = `http://127.0.0.1:${server.address().port}/api/triage`;
  return async (body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(2_000),
    });
    assert.match(response.headers.get("content-type"), /application\/json/);
    return { status: response.status, body: await response.json() };
  };
}

test("invalid JSON or empty/non-string text returns 400 without calling AI", async (t) => {
  let modelCalls = 0;
  const post = await startServer(t, async () => {
    modelCalls += 1;
    return JSON.stringify(validResult);
  });
  const inputs = [
    ["empty body", ""],
    ["broken JSON", '{"text":'],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON string", '"hello"'],
    ["JSON number", "12"],
    ["JSON boolean", "true"],
    ["missing text", "{}"],
    ["null text", '{"text":null}'],
    ["numeric text", '{"text":42}'],
    ["boolean text", '{"text":false}'],
    ["array text", '{"text":["hello"]}'],
    ["object text", '{"text":{}}'],
    ["empty text", '{"text":""}'],
    ["whitespace text", JSON.stringify({ text: " \t\n " })],
  ];
  for (const [name, body] of inputs) {
    await t.test(name, async () => {
      assert.deepEqual(await post(body), {
        status: 400,
        body: { status: "invalid_input" },
      });
    });
  }
  assert.equal(modelCalls, 0);
});

test("valid requests return the allowed topic and a nonempty draft", async (t) => {
  const post = await startServer(t);
  for (const [text, topic] of [
    ["Когда доставка?", "delivery"],
    ["Какова стоимость?", "pricing"],
    ["Нужна консультация", "other"],
  ]) {
    await t.test(topic, async () => {
      const response = await post(JSON.stringify({ text }));
      assert.deepEqual(response, {
        status: 200,
        body: {
          status: "ready",
          topic,
          draft: "Спасибо за обращение. Уточним детали заявки.",
        },
      });
    });
  }
});

test("all supplied mock failure markers return manual review, then allow retry", async (t) => {
  const post = await startServer(t);
  for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]", "[timeout]"]) {
    await t.test(marker, async () => {
      const started = performance.now();
      assert.deepEqual(await post(JSON.stringify({ text: marker })), {
        status: 200,
        body: manualReview,
      });
      if (marker === "[timeout]") {
        const elapsed = performance.now() - started;
        assert.ok(elapsed >= 250, `timeout returned too early: ${elapsed} ms`);
        assert.ok(elapsed < 1_000, `waited for the 1,200 ms mock delay: ${elapsed} ms`);
      }
    });
  }
  const retry = await post(JSON.stringify({ text: "Повторная заявка" }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, "ready");
});

test("model output must be an object with an allowed topic and nonempty string draft", async (t) => {
  const invalidOutputs = [
    ["invalid JSON", "not JSON"],
    ["null", "null"],
    ["array", "[]"],
    ["string", '"hello"'],
    ["number", "42"],
    ["boolean", "true"],
    ["empty object", "{}"],
    ["missing topic", JSON.stringify({ draft: "Ответ" })],
    ["unsupported topic", JSON.stringify({ topic: "refund", draft: "Ответ" })],
    ["non-string topic", JSON.stringify({ topic: 1, draft: "Ответ" })],
    ["missing draft", JSON.stringify({ topic: "other" })],
    ["null draft", JSON.stringify({ topic: "other", draft: null })],
    ["numeric draft", JSON.stringify({ topic: "other", draft: 42 })],
    ["object draft", JSON.stringify({ topic: "other", draft: {} })],
    ["empty draft", JSON.stringify({ topic: "other", draft: "" })],
    ["whitespace draft", JSON.stringify({ topic: "other", draft: " \t\n " })],
  ];
  let output;
  const post = await startServer(t, async () => output);
  for (const [name, value] of invalidOutputs) {
    await t.test(name, async () => {
      output = value;
      assert.deepEqual(await post(JSON.stringify({ text: "Заявка" })), {
        status: 200,
        body: manualReview,
      });
    });
  }
});

test("untrusted model fields cannot override API status or leak into the response", async (t) => {
  const post = await startServer(t, async () => JSON.stringify({
    ...validResult,
    status: "manual_review",
    internalReasoning: "Do not expose provider data",
  }));
  assert.deepEqual(await post(JSON.stringify({ text: "Заявка" })), {
    status: 200,
    body: { status: "ready", ...validResult },
  });
});

test("a synchronous provider exception also returns manual review", async (t) => {
  const post = await startServer(t, () => {
    throw new Error("Provider failed before returning a promise");
  });
  assert.deepEqual(await post(JSON.stringify({ text: "Заявка" })), {
    status: 200,
    body: manualReview,
  });
});

test("300 ms deadline aborts even an uncooperative provider and the next request succeeds", async (t) => {
  let calls = 0;
  let providerSignal;
  let aborted = false;
  const post = await startServer(t, (_text, { signal }) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(JSON.stringify(validResult));
    providerSignal = signal;
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    // No timer or socket is held open; this deliberately ignores cancellation.
    return new Promise(() => {});
  });
  const started = performance.now();
  assert.deepEqual(await post(JSON.stringify({ text: "Зависшая заявка" })), {
    status: 200,
    body: manualReview,
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 250, `deadline returned too early: ${elapsed} ms`);
  assert.ok(elapsed < 1_000, `deadline was not enforced: ${elapsed} ms`);
  assert.equal(providerSignal.aborted, true);
  assert.equal(aborted, true);
  assert.deepEqual(await post(JSON.stringify({ text: "Повторная заявка" })), {
    status: 200,
    body: { status: "ready", ...validResult },
  });
});
