import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const oldDraft = "Предыдущий черновик для первого клиента";
const newDraft = "Новый черновик для повторной попытки";
const ready = (draft = oldDraft, topic = "delivery") => ({ status: "ready", topic, draft });

function response(body, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// Execute the page's actual script. The small DOM double records only visible
// text, form state, focus and events; it does not reproduce application logic.
function page(fetchImpl) {
  const listeners = new Map();
  const timers = new Map();
  let timerId = 0;
  const element = () => ({
    textContent: "", value: "", disabled: false, focused: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() { this.focused = true; },
    set innerHTML(_) { throw new Error("Use textContent for untrusted output"); },
  });
  const form = element();
  form.addEventListener = (name, handler) => listeners.set(name, handler);
  const message = element();
  const button = element();
  const result = element();
  const elements = { form, "#message": message, button, "#result": result };
  runInNewContext(script, {
    document: { querySelector: (selector) => {
      assert.ok(elements[selector], `Unexpected selector: ${selector}`);
      return elements[selector];
    } },
    fetch: fetchImpl,
    AbortController,
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    form, message, button, result, timers,
    submit(text) {
      message.value = text;
      return listeners.get("submit")({ preventDefault() {} });
    },
  };
}

test("shows Russian topic labels and the draft as plain text", async () => {
  for (const [topic, label] of [["delivery", "Доставка"], ["pricing", "Стоимость"], ["other", "Другое"]]) {
    const draft = '<img src=x onerror="alert(1)">';
    const view = page(async (url, options) => {
      assert.equal(url, "/api/triage");
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { text: "Учебная заявка" });
      return response(ready(draft, topic));
    });
    await view.submit("  Учебная заявка  ");
    assert.match(view.result.textContent, new RegExp(`Тема: ${label}`));
    assert.ok(view.result.textContent.includes(draft));
    assert.match(view.result.textContent, /Проверьте черновик/);
    assert.equal(view.timers.size, 0);
  }
  assert.match(html, /aria-live="polite"/);
});

test("empty and whitespace input clears a previous draft without a request", async () => {
  for (const input of ["", " \n\t "]) {
    let calls = 0;
    const view = page(async () => { calls += 1; return response(ready()); });
    await view.submit("Учебная заявка");
    assert.ok(view.result.textContent.includes(oldDraft));
    await view.submit(input);
    assert.equal(calls, 1);
    assert.match(view.result.textContent, /Введите текст заявки/);
    assert.ok(!view.result.textContent.includes(oldDraft));
    assert.equal(view.message.focused, true);
    assert.equal(view.button.disabled, false);
  }
});

const failures = [
  ["manual review", async () => response({ status: "manual_review", topic: null, draft: null })],
  ["network failure", async () => { throw new TypeError("Network unavailable"); }],
  ["malformed API JSON", async () => ({ ...response(null), json: async () => { throw new SyntaxError("Bad JSON"); } })],
  ["HTTP error", async () => response(ready(), 503)],
  ["unknown topic", async () => response(ready("Draft", "refund"))],
  ["inherited object property as topic", async () => response(ready("Draft", "constructor"))],
  ["blank draft", async () => response(ready(" \n "))],
  ["non-string draft", async () => response(ready(123))],
  ["null response", async () => response(null)],
  ["array response", async () => response([])],
  ["missing response fields", async () => response({ status: "ready" })],
];

for (const [name, fail] of failures) {
  test(`${name} clears previous output, offers manual review and permits retry`, async () => {
    let calls = 0;
    const view = page(async (...args) => {
      calls += 1;
      if (calls === 1) return response(ready());
      if (calls === 2) return fail(...args);
      return response(ready(newDraft, "pricing"));
    });
    await view.submit("Первая заявка");
    assert.ok(view.result.textContent.includes(oldDraft));
    await view.submit("Вторая заявка");
    assert.match(view.result.textContent, /Разберите заявку вручную/);
    assert.ok(!view.result.textContent.includes(oldDraft));
    assert.ok(!view.result.textContent.includes("Тема:"));
    assert.equal(view.button.disabled, false);
    assert.equal(view.message.disabled, false);
    assert.equal(view.form.attributes.get("aria-busy"), "false");
    assert.equal(view.timers.size, 0);
    await view.submit("Повторная попытка");
    assert.ok(view.result.textContent.includes(newDraft));
    assert.match(view.result.textContent, /Тема: Стоимость/);
    assert.equal(calls, 3);
  });
}

test("invalid_input from the API clears the draft and asks to correct the input", async () => {
  let calls = 0;
  const view = page(async () => ++calls === 1
    ? response(ready())
    : response({ status: "invalid_input" }, 400));
  await view.submit("Первая заявка");
  await view.submit("Заявка отклонена API");
  assert.match(view.result.textContent, /Введите непустой текст заявки/);
  assert.ok(!view.result.textContent.includes(oldDraft));
  assert.equal(view.button.disabled, false);
  assert.equal(view.timers.size, 0);
});

test("loading clears previous output and blocks duplicate submissions", async () => {
  let resolveReply;
  let calls = 0;
  const view = page(async () => {
    calls += 1;
    if (calls === 1) return response(ready());
    return new Promise((resolve) => { resolveReply = resolve; });
  });
  await view.submit("Первая заявка");
  const pending = view.submit("Вторая заявка");
  assert.match(view.result.textContent, /Разбираем заявку/);
  assert.ok(!view.result.textContent.includes(oldDraft));
  assert.equal(view.button.disabled, true);
  assert.equal(view.message.disabled, true);
  assert.equal(view.form.attributes.get("aria-busy"), "true");
  await view.submit("Повторный submit во время ожидания");
  assert.equal(calls, 2);
  resolveReply(response(ready(newDraft)));
  await pending;
  assert.ok(view.result.textContent.includes(newDraft));
  assert.equal(view.button.disabled, false);
  assert.equal(view.timers.size, 0);
});

test("client timeout aborts a hanging request, removes the draft and permits retry", async () => {
  let calls = 0;
  let aborted = false;
  const view = page(async (_url, { signal }) => {
    calls += 1;
    if (calls !== 2) return response(ready(calls === 1 ? oldDraft : newDraft));
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  });
  await view.submit("Первая заявка");
  const pending = view.submit("Зависшая заявка");
  const [timer] = view.timers.values();
  assert.equal(timer.delay, 3_000);
  timer.callback();
  await pending;
  assert.equal(aborted, true);
  assert.match(view.result.textContent, /Разберите заявку вручную/);
  assert.ok(!view.result.textContent.includes(oldDraft));
  assert.equal(view.timers.size, 0);
  assert.equal(view.button.disabled, false);
  await view.submit("Повторная попытка");
  assert.ok(view.result.textContent.includes(newDraft));
});
