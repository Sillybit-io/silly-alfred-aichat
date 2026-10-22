import type { StreamError } from "./stream";

export type MappedError = { title: string; detail: string; next: string };

export type FailureInput = {
  headers: string;
  body: string;
  curlExit: number | null;
  streamError: StreamError | null;
  finishReason: string | null;
};

export type HttpStatus = { status: number; retryAfterSeconds: number | null };

// The headers file holds one block per response (redirects, 100 Continue); the last block wins.
export function lastStatus(headers: string): HttpStatus | null {
  const lines = headers.split(/\r\n|\r|\n/);
  let found: HttpStatus | null = null;
  for (const line of lines) {
    const status = /^HTTP\/\S+\s+(\d{3})/.exec(line);
    if (status) {
      found = { status: Number(status[1]), retryAfterSeconds: null };
      continue;
    }
    if (!found) continue;
    const retry = /^retry-after:\s*(\d+)\s*$/i.exec(line);
    if (retry) found.retryAfterSeconds = Number(retry[1]);
  }
  return found;
}

function providerMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === "string" && error !== "") return clip(error);
      if (typeof error === "object" && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === "string" && message !== "") return clip(message);
      }
    }
  } catch {
    // not JSON: fall through
  }
  return null;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

// OpenRouter answers 404 when the account's privacy or guardrail settings leave no endpoint for a model.
const POLICY_PATTERN = /guardrail|data policy|zero data retention|\bZDR\b/i;

export function mapHttpError(status: HttpStatus, body: string): MappedError {
  const message = providerMessage(body);
  if (message !== null && POLICY_PATTERN.test(message) && (status.status === 404 || status.status === 403 || status.status === 400)) {
    return {
      title: "Blocked by your data policy",
      detail: "Your OpenRouter privacy settings (such as zero data retention) leave no provider for this model.",
      next: "Pick a model your settings allow with the `aimodels` keyword (add #imagegen for image models), or change the policy in your OpenRouter privacy settings.",
    };
  }
  switch (status.status) {
    case 401:
      return {
        title: "Invalid API key",
        detail: "OpenRouter did not accept the API key.",
        next: "Open the workflow's Configuration and paste a key from openrouter.ai/keys.",
      };
    case 402:
      return {
        title: "Out of credits",
        detail: "The account or key behind this API key cannot pay for this request.",
        next: "Add credits on the OpenRouter dashboard, or pick a free model with /model.",
      };
    case 403:
      return {
        title: "Request blocked",
        detail: message ?? "OpenRouter or the provider refused this request.",
        next: "Rephrase the message or pick another model with /model.",
      };
    case 404:
      return {
        title: "Model not found",
        detail: message ?? "OpenRouter has no model or endpoint for this request.",
        next: "Pick another model with /model.",
      };
    case 408:
      return {
        title: "Request timed out",
        detail: message ?? "The provider took too long to answer.",
        next: "Use /retry.",
      };
    case 429:
      return {
        title: "Rate limited",
        detail: message ?? "OpenRouter or the provider is limiting requests.",
        next: status.retryAfterSeconds !== null ? `Use /retry — retry in ${status.retryAfterSeconds} s.` : "Wait a moment, then use /retry.",
      };
    case 400:
    case 413:
    case 422:
      return {
        title: "Request rejected",
        detail: message ?? "The model could not accept this request.",
        next: "Check the model supports what you attached, shorten the chat, or start /new.",
      };
    case 502:
      return {
        title: "Provider error",
        detail: message ?? "The model provider returned an error.",
        next: "Use /retry, or pick another model with /model.",
      };
    case 503:
      return {
        title: "Model unavailable",
        detail: message ?? "No provider is available for this model right now.",
        next: "Use /retry later, or pick another model with /model.",
      };
    default:
      return {
        title: `OpenRouter error ${status.status}`,
        detail: message ?? "OpenRouter returned an unexpected status.",
        next: "Use /retry.",
      };
  }
}

export function mapCurlExit(code: number): MappedError {
  switch (code) {
    case 6:
    case 7:
      return {
        title: "Cannot reach OpenRouter",
        detail: "The connection to OpenRouter could not be opened.",
        next: "Check your network connection, then use /retry.",
      };
    case 28:
      return {
        title: "Request timed out",
        detail: "OpenRouter did not answer in time.",
        next: "Use /retry, or raise the timeout in Configuration.",
      };
    case 35:
      return {
        title: "Secure connection failed",
        detail: "The TLS handshake with OpenRouter failed.",
        next: "Check your network, VPN, or proxy, then use /retry.",
      };
    case 52:
      return {
        title: "Empty reply",
        detail: "OpenRouter closed the connection without answering.",
        next: "Use /retry.",
      };
    case 56:
      return {
        title: "Connection lost",
        detail: "The connection dropped while receiving the reply.",
        next: "Use /retry.",
      };
    default:
      return {
        title: "Network error",
        detail: `The network request failed (curl exit ${code}).`,
        next: "Check your network connection, then use /retry.",
      };
  }
}

export function mapStreamError(error: StreamError): MappedError {
  if (error.kind === "protocol") {
    return {
      title: "Unreadable response",
      detail: error.message,
      next: "Use /retry.",
    };
  }
  return {
    title: "The model stopped with an error",
    detail: clip(error.message),
    next: "Use /retry, or pick another model with /model.",
  };
}

export function mapFinishReason(reason: string): MappedError | null {
  if (reason === "length") {
    return {
      title: "Reply cut off",
      detail: "The model reached its length limit before finishing.",
      next: "Send \"continue\" to get the rest.",
    };
  }
  if (reason === "content_filter") {
    return {
      title: "Reply blocked",
      detail: "The provider's content filter stopped the reply.",
      next: "Rephrase the message or pick another model with /model.",
    };
  }
  return null;
}

// Picks the most specific cause: HTTP status, then curl, then the stream, then the finish reason.
export function describeFailure(input: FailureInput): MappedError {
  const status = lastStatus(input.headers);
  if (status && status.status >= 400) return mapHttpError(status, input.body);
  if (input.curlExit !== null && input.curlExit !== 0) return mapCurlExit(input.curlExit);
  if (input.streamError) return mapStreamError(input.streamError);
  if (input.finishReason) {
    const mapped = mapFinishReason(input.finishReason);
    if (mapped) return mapped;
  }
  return {
    title: "No reply",
    detail: "The stream ended without an answer.",
    next: "Use /retry.",
  };
}
