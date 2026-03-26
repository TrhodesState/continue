import { useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  setInlineErrorMessage,
  setInterrupted,
} from "../../redux/slices/sessionSlice";
import { continueInterruptedStreamThunk } from "../../redux/thunks/continueInterruptedStream";
import { streamResponseThunk } from "../../redux/thunks/streamResponse";
import { useMainEditor } from "./TipTapEditor";

export type InlineErrorMessageType = "out-of-context" | "interrupted";

export default function InlineErrorMessage() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const inlineErrorMessage = useAppSelector(
    (state) => state.session.inlineErrorMessage,
  );
  const history = useAppSelector((state) => state.session.history);
  const { mainEditor } = useMainEditor();

  if (inlineErrorMessage === "out-of-context") {
    return (
      <div
        className={`border-border relative m-2 flex flex-col rounded-md border border-solid bg-transparent p-4`}
      >
        <p className={`thread-message text-error text-center`}>
          {`Message exceeds context limit.`}
        </p>
        <div className="text-description flex flex-row items-center justify-center gap-1.5 px-3">
          <div
            className="cursor-pointer text-xs hover:underline"
            onClick={() => {
              ideMessenger.post("config/openProfile", {
                profileId: undefined,
              });
            }}
          >
            <span className="xs:flex hidden">Open config</span>
            <span className="xs:hidden">Config</span>
          </div>
          |
          <span
            className="cursor-pointer text-xs hover:underline"
            onClick={() => {
              dispatch(setInlineErrorMessage(undefined));
            }}
          >
            Hide
          </span>
        </div>
      </div>
    );
  }

  if (inlineErrorMessage === "interrupted") {
    const handleResume = () => {
      const lastItem = history.at(-1);
      const hasPartialResponse =
        lastItem?.message.role === "assistant" && !!lastItem.message.content;

      if (hasPartialResponse) {
        // True resume: the LLM receives the history ending with the partial
        // assistant turn and continues generating from where it stopped.
        void dispatch(continueInterruptedStreamThunk());
        return;
      }

      // Fallback: no partial content was kept, so resubmit the last user message.
      let index = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (
          history[i].message.role === "user" ||
          history[i].message.role === "tool"
        ) {
          index = i;
          break;
        }
      }

      const editorState =
        index === -1 ? mainEditor?.getJSON() : history[index]?.editorState;

      if (!editorState) {
        dispatch(setInterrupted(false));
        return;
      }

      void dispatch(
        streamResponseThunk({
          editorState,
          modifiers: { noContext: true, useCodebase: false },
          index: index === -1 ? 0 : index,
        }),
      );
    };

    return (
      <div
        className={`border-border relative m-2 flex flex-col rounded-md border border-solid bg-transparent p-4`}
      >
        <p className={`thread-message text-warning text-center text-sm`}>
          {`Last message was interrupted.`}
        </p>
        <div className="text-description flex flex-row items-center justify-center gap-1.5 px-3">
          <span
            className="cursor-pointer text-xs font-medium hover:underline"
            onClick={handleResume}
          >
            Resume
          </span>
          |
          <span
            className="cursor-pointer text-xs hover:underline"
            onClick={() => {
              dispatch(setInterrupted(false));
            }}
          >
            Dismiss
          </span>
        </div>
      </div>
    );
  }

  return null;
}
