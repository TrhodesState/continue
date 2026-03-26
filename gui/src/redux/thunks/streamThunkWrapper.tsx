import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import posthog from "posthog-js";
import StreamErrorDialog from "../../pages/gui/StreamError";
import { analyzeError } from "../../util/errorAnalysis";
import { selectSelectedChatModel } from "../slices/configSlice";
import { setInterrupted } from "../slices/sessionSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { loadSession, saveCurrentSession } from "./session";
import { streamNormalInput } from "./streamNormalInput";

const AUTO_RETRY_BASE_DELAY_MS = 2000;
const AUTO_RETRY_MAX_DELAY_MS = 60000;

// Wall-clock limit: keep auto-retrying for up to 10 minutes before giving up.
const MAX_RETRY_DURATION_MS = 10 * 60 * 1000;

function toLowerMessage(message?: string | null): string {
  if (!message) {
    return "";
  }

  return message.toLowerCase();
}

function isRetryableStreamMessage(message?: string | null): boolean {
  const lower = toLowerMessage(message);
  if (!lower) {
    return false;
  }

  return (
    lower.includes("overloaded") ||
    lower.includes("malformed json") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit") ||
    lower.includes("rate limited") ||
    lower.includes("resource exhausted") ||
    lower.includes("premature close") ||
    lower.includes("timed out") ||
    lower.includes("etimedout") ||
    lower.includes("timeout") ||
    lower.includes("request timeout") ||
    lower.includes("connection timeout") ||
    lower.includes("socket hang up") ||
    lower.includes("aborted")
  );
}

/**
 * Returns true for errors that are NOT worth retrying — the user needs to take
 * action (fix their API key, add credits, correct the model name, etc.).
 */
function isFatalStreamError(
  statusCode: number | undefined,
  message?: string | null,
): boolean {
  // Authentication / authorization failures
  if (statusCode === 401 || statusCode === 403) return true;
  // Model or endpoint not found
  if (statusCode === 404) return true;
  // Other 4xx errors except 408 (Request Timeout) and 429 (Rate Limit)
  if (
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    statusCode !== 429
  ) {
    return true;
  }

  const lower = toLowerMessage(message);
  return (
    lower.includes("out of credits") ||
    lower.includes("invalid api key") ||
    lower.includes("insufficient_quota") ||
    lower.includes("access denied") ||
    lower.includes("you're out of credits")
  );
}

function shouldAutoRetryStreamError(
  statusCode: number | undefined,
  message?: string | null,
  parsedError?: string | null,
): boolean {
  if (
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 502 ||
    statusCode === 503
  ) {
    return true;
  }

  if (statusCode === 504) {
    return true;
  }

  return (
    isRetryableStreamMessage(message) || isRetryableStreamMessage(parsedError)
  );
}

export { extractRetryAfterMs, getRetryDelayMs, shouldAutoRetryStreamError };

function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const errorObject = error as any;
  const headerCandidates = [
    errorObject.headers?.["retry-after"],
    errorObject.headers?.["Retry-After"],
  ];

  const jsonFromMessage = (() => {
    if (typeof errorObject.message !== "string") {
      return undefined;
    }

    const [, rawJson] = errorObject.message.split("\n\n", 2);
    if (!rawJson) {
      return undefined;
    }

    try {
      return JSON.parse(rawJson);
    } catch {
      return undefined;
    }
  })();

  const bodyError =
    jsonFromMessage && typeof jsonFromMessage === "object"
      ? ((jsonFromMessage as any).error ?? jsonFromMessage)
      : undefined;

  const candidates = [
    errorObject.retry_after,
    errorObject.retryAfter,
    bodyError?.retry_after,
    bodyError?.retryAfter,
    ...headerCandidates,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, candidate * 1000);
    }

    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const trimmed = candidate.trim();
      const numericValue = Number(trimmed);
      if (!Number.isNaN(numericValue)) {
        return Math.max(0, numericValue * 1000);
      }

      const dateValue = Date.parse(trimmed);
      if (!Number.isNaN(dateValue)) {
        return Math.max(0, dateValue - Date.now());
      }
    }
  }

  return undefined;
}

function getRetryDelayMs(error: unknown, attempt: number): number {
  const retryAfterMs = extractRetryAfterMs(error);
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, AUTO_RETRY_MAX_DELAY_MS);
  }

  const exponentialDelay = AUTO_RETRY_BASE_DELAY_MS * 2 ** attempt;
  return Math.min(exponentialDelay, AUTO_RETRY_MAX_DELAY_MS);
}

function getRetryReason(message?: string | null, parsedError?: string | null) {
  const lowerMessage = toLowerMessage(message);
  const lowerParsedError = toLowerMessage(parsedError);

  if (
    lowerMessage.includes("too many requests") ||
    lowerParsedError.includes("too many requests") ||
    lowerMessage.includes("rate limit") ||
    lowerParsedError.includes("rate limit")
  ) {
    return "rate_limit";
  }

  if (
    lowerMessage.includes("premature close") ||
    lowerParsedError.includes("premature close")
  ) {
    return "premature_close";
  }

  if (
    lowerMessage.includes("overloaded") ||
    lowerParsedError.includes("overloaded")
  ) {
    return "overloaded";
  }

  if (
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("etimedout") ||
    lowerMessage.includes("timed out") ||
    lowerParsedError.includes("timeout") ||
    lowerParsedError.includes("timed out")
  ) {
    return "timeout";
  }

  if (
    lowerMessage.includes("aborted") ||
    lowerMessage.includes("socket hang up") ||
    lowerParsedError.includes("aborted") ||
    lowerParsedError.includes("socket hang up")
  ) {
    return "connection_aborted";
  }

  return "transient_stream_error";
}

const AUTO_COMPACT_THRESHOLD = 0.7;

export const streamThunkWrapper = createAsyncThunk<
  void,
  () => Promise<void>,
  ThunkApiType
>("chat/streamWrapper", async (runStream, { dispatch, getState, extra }) => {
  const initialSessionId = getState().session.id;
  const startTime = Date.now();
  let attempt = 0;

  while (true) {
    // Clear any prior interrupted state when the first attempt begins
    if (attempt === 0) {
      dispatch(setInterrupted(false));
    }

    try {
      if (attempt > 0) {
        // On retry, check whether the LLM had already generated partial content.
        // If yes, send the history as-is (ending with the partial assistant turn)
        // so the model continues from where it stopped rather than starting over.
        const lastItem = getState().session.history.at(-1);
        const hasPartialResponse =
          lastItem?.message.role === "assistant" && !!lastItem.message.content;

        if (hasPartialResponse) {
          unwrapResult(await dispatch(streamNormalInput({})));
        } else {
          await runStream();
        }
      } else {
        await runStream();
      }

      // ── Success path ────────────────────────────────────────────────────────
      const state = getState();
      if (!state.session.isInEdit) {
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: true,
          }),
        );

        // Auto-compact if context is approaching the limit (>= 70%)
        const contextPercentage = getState().session.contextPercentage;
        if (
          contextPercentage !== undefined &&
          contextPercentage >= AUTO_COMPACT_THRESHOLD
        ) {
          try {
            const sessionId = getState().session.id;
            await extra.ideMessenger.request("conversation/compact", {
              index: 0,
              sessionId,
            });
            dispatch(loadSession({ sessionId, saveCurrentSession: false }));
          } catch {
            // Auto-compact failed — not critical, session continues normally
          }
        }
      }
      return;
    } catch (e) {
      // ── Error path ──────────────────────────────────────────────────────────
      const state = getState();
      const selectedModel = selectSelectedChatModel(state);
      const { parsedError, statusCode, message, modelTitle, providerName } =
        analyzeError(e, selectedModel);

      await dispatch(cancelStream());

      // Fatal errors are not worth retrying — the user must take action.
      if (isFatalStreamError(statusCode, message)) {
        dispatch(setInterrupted(true));
        await dispatch(
          saveCurrentSession({ openNewSession: false, generateTitle: false }),
        );
        dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
        dispatch(setShowDialog(true));
        posthog.capture("gui_stream_error", {
          error_type: statusCode ? `HTTP ${statusCode}` : "Unknown",
          error_message: parsedError,
          model_provider: providerName,
          model_title: modelTitle,
          fatal: true,
        });
        return;
      }

      // Guard: stop if the session changed or a new stream was started.
      if (
        getState().session.id !== initialSessionId ||
        getState().session.isStreaming
      ) {
        return;
      }

      // Guard: stop if we've been retrying for too long.
      const elapsed = Date.now() - startTime;
      if (elapsed >= MAX_RETRY_DURATION_MS) {
        dispatch(setInterrupted(true));
        await dispatch(
          saveCurrentSession({ openNewSession: false, generateTitle: false }),
        );
        dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
        dispatch(setShowDialog(true));
        posthog.capture("gui_stream_error", {
          error_type: "max_retry_duration_exceeded",
          error_message: parsedError,
          model_provider: providerName,
          model_title: modelTitle,
          elapsed_ms: elapsed,
        });
        return;
      }

      // Transient error — wait with exponential backoff (caps at 60s) and retry.
      const delayMs = getRetryDelayMs(e, attempt);

      posthog.capture("gui_stream_retry", {
        attempt: attempt + 1,
        delay_ms: delayMs,
        error_type: statusCode ? `HTTP ${statusCode}` : "Unknown",
        retry_reason: getRetryReason(message, parsedError),
        model_provider: providerName,
        model_title: modelTitle,
        has_partial_response:
          getState().session.history.at(-1)?.message.role === "assistant" &&
          !!getState().session.history.at(-1)?.message.content,
      });

      await new Promise((resolve) => setTimeout(resolve, delayMs));

      // Re-check session validity after the wait.
      if (
        getState().session.id !== initialSessionId ||
        getState().session.isStreaming
      ) {
        return;
      }

      attempt++;
    }
  }
});
