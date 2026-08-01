import OpenAI from "openai";
import type { IModel } from "./baseModel.js";
import type { IConversations } from "../agent/agent.js";

export class OpenAIModel implements IModel {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async generate(conversations: IConversations[], instructions: string): Promise<string | undefined> {
    const llmResponse = await this.openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: instructions },
        ...conversations.map((conversation) => ({
          role: conversation.role,
          content: conversation.content,
        })),
      ],
    });

    return llmResponse.choices[0]?.message?.content as string
  }
}
