import { createAsyncThunk } from "@reduxjs/toolkit";
import posthog from "posthog-js";
import StreamErrorDialog from "../../pages/gui/StreamError";
import { analyzeError } from "../../util/errorAnalysis";
import { selectSelectedChatModel } from "../slices/configSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { saveCurrentSession } from "./session";

const AUTO_RETRY_ATTEMPTS = 4;
const AUTO_RETRY_BASE_DELAY_MS = 2000;
const AUTO_RETRY_MAX_DELAY_MS = 60000;

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
    lower.includes("premature close")
  );
}

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

function shouldAutoRetryStreamError(
  statusCode: number | undefined,
  message?: string | null,
  parsedError?: string | null,
): boolean {
  if (statusCode === 429 || statusCode === 502 || statusCode === 503) {
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

  return "transient_stream_error";
}

export const streamThunkWrapper = createAsyncThunk<
  void,
  () => Promise<void>,
  ThunkApiType
>("chat/streamWrapper", async (runStream, { dispatch, getState }) => {
  const initialSessionId = getState().session.id;

  for (let attempt = 0; attempt <= AUTO_RETRY_ATTEMPTS; attempt++) {
    try {
      await runStream();
      const state = getState();
      if (!state.session.isInEdit) {
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: true,
          }),
        );
      }
      return;
    } catch (e) {
      // Get the selected model from the state for error analysis
      const state = getState();
      const selectedModel = selectSelectedChatModel(state);
      const { parsedError, statusCode, message, modelTitle, providerName } =
        analyzeError(e, selectedModel);

      const shouldRetry =
        shouldAutoRetryStreamError(statusCode, message, parsedError) &&
        attempt < AUTO_RETRY_ATTEMPTS;

      if (shouldRetry) {
        await dispatch(cancelStream());
        const delayMs = getRetryDelayMs(e, attempt);

        posthog.capture("gui_stream_retry", {
          attempt: attempt + 1,
          delay_ms: delayMs,
          error_type: statusCode ? `HTTP ${statusCode}` : "Unknown",
          retry_reason: getRetryReason(message, parsedError),
          model_provider: providerName,
          model_title: modelTitle,
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));

        if (
          getState().session.id !== initialSessionId ||
          getState().session.isStreaming
        ) {
          return;
        }
      } else {
        await dispatch(cancelStream());
        dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
        dispatch(setShowDialog(true));

        const errorData = {
          error_type: statusCode ? `HTTP ${statusCode}` : "Unknown",
          error_message: parsedError,
          model_provider: providerName,
          model_title: modelTitle,
        };

        posthog.capture("gui_stream_error", errorData);
        return;
      }
    }
  }
});
