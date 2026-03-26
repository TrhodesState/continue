import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";

import { ThunkApiType } from "../store";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";

/**
 * Continues a stream that was interrupted mid-response.
 *
 * Unlike `streamResponseThunk`, this does NOT add a new user message. It sends
 * the current session history (which ends with the partial assistant response
 * preserved by `clearDanglingMessages`) directly to the LLM. The model receives
 * the partial assistant turn as a prefix and generates a continuation.
 *
 * `streamUpdate` merges the continuation chunks into the existing partial
 * assistant message because the roles match, so the user sees seamless text.
 */
export const continueInterruptedStreamThunk = createAsyncThunk<
  void,
  void,
  ThunkApiType
>("chat/continueInterrupted", async (_, { dispatch }) => {
  await dispatch(
    streamThunkWrapper(async () => {
      unwrapResult(await dispatch(streamNormalInput({})));
    }),
  );
});
