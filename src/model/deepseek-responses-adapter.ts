import {
  DeepSeekChatAdapter,
  type DeepSeekChatOptions,
} from "./deepseek-chat-adapter.js";

/** @deprecated Use DeepSeekChatOptions. reasoningEffort is unavailable in the MVP slice. */
export interface DeepSeekResponsesOptions extends DeepSeekChatOptions {
  readonly reasoningEffort?: "low" | "medium" | "high";
}

/** @deprecated DeepSeek's documented tool-calling protocol is Chat Completions. */
export class DeepSeekResponsesAdapter extends DeepSeekChatAdapter {
  constructor(options: DeepSeekResponsesOptions) {
    if (options.reasoningEffort !== undefined) {
      throw new TypeError(
        "reasoningEffort requires the deferred sensitive reasoning continuation contract.",
      );
    }
    super(options);
  }
}
