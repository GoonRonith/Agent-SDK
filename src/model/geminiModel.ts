import type { IModel } from "./baseModel.js";
import type { IConversations } from "../agent/agent.js";
import { GoogleGenAI } from "@google/genai";
import { requireEnv } from "../utils/secrets.js";
import { withRetry } from "../utils/reliability.js";
import { ModelError } from "../utils/errors.js";

export class GeminiModel implements IModel {
  private gemini: GoogleGenAI;

  constructor() {
    this.gemini = new GoogleGenAI({
      apiKey: requireEnv("GEMINI_API_KEY"),
    });
  }

  async generate(
    messages: IConversations[],
    instructions: string,
  ): Promise<string | undefined> {
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        {
          text:
            m.role === "developer" ? `[TOOL RESULT]\n${m.content}` : m.content,
        },
      ],
    }));

    try {
      const llmResponse = await withRetry(
        () =>
          this.gemini.models.generateContent({
            model: "gemini-2.5-flash",
            contents,
            config: {
              systemInstruction: instructions,
            },
          }),
        { label: "Gemini generateContent", retries: 2, baseDelayMs: 500, timeoutMs: 30_000 },
      );

      return llmResponse.candidates?.[0]?.content?.parts?.[0]?.text as
        | string
        | undefined;
    } catch (error) {
      throw new ModelError("Gemini model request failed", { operation: "generate", cause: error });
    }
  }
}
