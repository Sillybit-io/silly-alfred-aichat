import { describe, expect, test } from "bun:test";
import { describeFailure, lastStatus, mapCurlExit, mapFinishReason, mapStreamError } from "../src/core/errors";

const none = { body: "", curlExit: 0, streamError: null, finishReason: null };

describe("lastStatus", () => {
  test("reads the last status block and its Retry-After", () => {
    const dump = "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nretry-after: 17\r\ncontent-type: application/json\r\n\r\n";
    expect(lastStatus(dump)).toEqual({ status: 429, retryAfterSeconds: 17 });
    expect(lastStatus("HTTP/2 200\r\nretry-after: 5\r\n\r\nHTTP/2 502\r\n\r\n")).toEqual({ status: 502, retryAfterSeconds: null });
    expect(lastStatus("")).toBeNull();
  });
});

describe("describeFailure", () => {
  test("429 with Retry-After maps to Rate limited and the wait", () => {
    const mapped = describeFailure({ ...none, headers: "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 17\r\n\r\n" });
    expect(mapped.title).toBe("Rate limited");
    expect(mapped.next).toContain("retry in 17 s");
  });

  test("curl exit 7 with an empty body maps to Cannot reach OpenRouter", () => {
    expect(describeFailure({ ...none, headers: "", curlExit: 7 }).title).toBe("Cannot reach OpenRouter");
    expect(mapCurlExit(28).title).toBe("Request timed out");
    expect(mapCurlExit(35).title).toBe("Secure connection failed");
    expect(mapCurlExit(52).title).toBe("Empty reply");
    expect(mapCurlExit(56).title).toBe("Connection lost");
    expect(mapCurlExit(6).title).toBe("Cannot reach OpenRouter");
  });

  test("a 402 body maps to Out of credits without the provider message or any figure", () => {
    const body = JSON.stringify({ error: { code: 402, message: "Insufficient credits. You have $0.02 left, this needs $1.40", metadata: { limit_source: "openrouter_credits" } } });
    const mapped = describeFailure({ ...none, headers: "HTTP/1.1 402 Payment Required\r\n\r\n", body });
    expect(mapped.title).toBe("Out of credits");
    const text = JSON.stringify(mapped);
    expect(text).not.toContain("0.02");
    expect(text).not.toContain("1.40");
    expect(text).not.toContain("$");
  });

  test("401 names the key; 400 shows the provider message", () => {
    expect(describeFailure({ ...none, headers: "HTTP/1.1 401 Unauthorized\r\n\r\n", body: '{"error":{"message":"No auth"}}' }).title).toBe("Invalid API key");
    const bad = describeFailure({ ...none, headers: "HTTP/1.1 400 Bad Request\r\n\r\n", body: '{"error":{"message":"image input is not supported"}}' });
    expect(bad.title).toBe("Request rejected");
    expect(bad.detail).toBe("image input is not supported");
  });

  test("an HTTP status wins over curl, a curl failure over a stream error", () => {
    const streamError = { kind: "api" as const, message: "boom", code: null };
    expect(describeFailure({ ...none, headers: "HTTP/1.1 503 Service Unavailable\r\n\r\n", curlExit: 56, streamError }).title).toBe("Model unavailable");
    expect(describeFailure({ ...none, headers: "HTTP/1.1 200 OK\r\n\r\n", curlExit: 56, streamError }).title).toBe("Connection lost");
    expect(describeFailure({ ...none, headers: "HTTP/1.1 200 OK\r\n\r\n", streamError }).detail).toBe("boom");
  });

  test("mid-stream, protocol, and finish-reason failures read in plain language", () => {
    expect(mapStreamError({ kind: "api", message: "Provider disconnected unexpectedly", code: "server_error" }).detail).toBe("Provider disconnected unexpectedly");
    expect(mapStreamError({ kind: "protocol", message: "bad", code: null }).title).toBe("Unreadable response");
    expect(mapFinishReason("length")?.title).toBe("Reply cut off");
    expect(mapFinishReason("content_filter")?.title).toBe("Reply blocked");
    expect(mapFinishReason("stop")).toBeNull();
  });

  test("a 404 that names a guardrail or ZDR policy says the data policy blocked the model and where to pick another", () => {
    const body = JSON.stringify({ error: { message: "Model not found. 0 endpoints out of 2 requested are available matching your guardrail restrictions and data policy. ZDR violation (guardrail): 2 endpoints excluded; configurable at https://openrouter.ai/workspaces/example/guardrails", code: 404 } });
    const mapped = describeFailure({ ...none, headers: "HTTP/1.1 404 Not Found\r\n\r\n", body });
    expect(mapped.title).toBe("Blocked by your data policy");
    expect(mapped.next).toContain("aimodels");
    expect(JSON.stringify(mapped)).not.toContain("workspaces");
    expect(describeFailure({ ...none, headers: "HTTP/1.1 404 Not Found\r\n\r\n", body: '{"error":{"message":"No such model"}}' }).title).toBe("Model not found");
  });

  test("an unexplained end still gets a next step and no raw JSON", () => {
    const mapped = describeFailure({ ...none, headers: "HTTP/1.1 200 OK\r\n\r\n" });
    expect(mapped.next).toContain("/retry");
    expect(`${mapped.title} ${mapped.detail} ${mapped.next}`).not.toContain("{");
  });
});
