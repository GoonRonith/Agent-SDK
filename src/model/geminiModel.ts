import type { IModel } from "./baseModel.js";
import type { IConversations } from "../agent/agent.js";
import { GoogleGenAI } from "@google/genai";

export class GeminiModel implements IModel {
  private gemini: GoogleGenAI;

  constructor() {
    this.gemini = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || "",
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

    const llmResponse = await this.gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction: instructions,
      },
    });

    return llmResponse.candidates?.[0]?.content?.parts?.[0]?.text as
      | string
      | undefined;
  }
}
