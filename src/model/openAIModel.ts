import OpenAI from "openai";
import type { IModel } from "./baseModel.js";
import type { IConversations } from "../agent/agent.js";
import { requireEnv } from "../utils/secrets.js";
import { withRetry } from "../utils/reliability.js";
import { ModelError } from "../utils/errors.js";

export class OpenAIModel implements IModel {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: requireEnv("OPENAI_API_KEY"),
    });
  }

  async generate(conversations: IConversations[], instructions: string): Promise<string | undefined> {
    try {
      const llmResponse = await withRetry(
        () =>
          this.openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              { role: "system", content: instructions },
              ...conversations.map((conversation) => ({
                role: conversation.role,
                content: conversation.content,
              })),
            ],
          }),
        { label: "OpenAI chat.completions.create", retries: 2, baseDelayMs: 500, timeoutMs: 30_000 },
      );

      return llmResponse.choices[0]?.message?.content as string
    } catch (error) {
      throw new ModelError("OpenAI model request failed", { operation: "generate", cause: error });
    }
  }
}
