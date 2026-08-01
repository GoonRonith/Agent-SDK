import "dotenv/config";
import { HARNESS_PROMPT } from "./config.js";
import OpenAI from "openai";
import type { ZodSchema } from "zod";

export interface ITool<TInput, TResult> {
  name: string;
  desc: string;
  doc?: string;
  inputSchema: ZodSchema<TInput>;
  executor: (input: TInput) => Promise<TResult>;
}

interface IAgentConfig {
  instructions: string;
  tools: ITool<any, any>[];
}

interface IConversations {
  role: "user" | "assistant" | "system" | "developer";
  content: string;
}

export class AgentBuilder {
  private agentConfig: IAgentConfig = {
    instructions: "",
    tools: [],
  };

  constructor() {
    this.agentConfig.tools = [];
    this.agentConfig.instructions = "";
  }

  public setInstructions(instructions: string) {
    this.agentConfig.instructions = instructions;
    return this;
  }

  public tool<TInput, TResult>(tool: ITool<TInput, TResult>) {
    this.agentConfig.tools.push(tool);
    return this;
  }

  public build() {
    return new Agent(this.agentConfig);
  }
}

export class Agent {
  private instructions: string;
  private openai: OpenAI;
  private conversations: IConversations[];
  private toolMapping: Map<string, ITool<any, any>>;
  private MAX_ITERATION = 30;

  constructor(private agentConfig: IAgentConfig) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    this.instructions = `
        ${HARNESS_PROMPT}\n\n
        
        System Prompt:
        ${agentConfig.instructions}

        Available Tools:
        ${agentConfig.tools.map((t) => JSON.stringify({ functionName: t.name, functionDescription: t.desc, functionDoc: t.doc,inputSchema:t.inputSchema })).join("\n")}
    `;

    this.conversations = [];

    this.toolMapping = new Map();
    for (const tool of agentConfig.tools) {
      this.toolMapping.set(tool.name, tool);
    }
  }

  static builder() {
    return new AgentBuilder();
  }

  public async run(userQuery: string) {
    this.conversations.push({ role: "user", content: userQuery });

    for (
      let currentIteration = 0;
      currentIteration <= this.MAX_ITERATION;
      currentIteration++
    ) {
      const llmResponse = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: this.instructions },
          ...this.conversations.map((conversation) => ({
            role: conversation.role,
            content: conversation.content,
          })),
        ],
      });

      const rawLLMResponse: string = llmResponse.choices[0]?.message
        .content as string;

      this.conversations.push({ role: "assistant", content: rawLLMResponse });

      const parsedLLMResponse = JSON.parse(rawLLMResponse);
      console.log(parsedLLMResponse);
      if (parsedLLMResponse.step.toLowerCase() === "output")
        return this.conversations;

      if (parsedLLMResponse.step.toLowerCase() === "tool_request") {
        console.log("inside tool request block");
        
        const { functionName, input } = parsedLLMResponse;
        const tool = this.toolMapping.get(functionName);
        if (!tool) {
          this.conversations.push({
            role: "developer",
            content: `Error: Function with name ${functionName} does not exists`,
          });
          continue;
        }
        try {
          const parsed = tool.inputSchema.safeParse(input);
          if (!parsed.success) {
            console.log("parsing error");
            
            throw new Error(parsed.error.message);
          }
          const toolResult = await tool.executor(parsed.data);
          console.log(toolResult);
          
          this.conversations.push({
            role: "developer",
            content: JSON.stringify({
              functionName,
              input,
              toolResult,
            }),
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.log("Tool Error", errorMessage);
          this.conversations.push({
            role: "developer",
            content: `Error: Tool Call Failed, error -> ${errorMessage}`,
          });
        }
      }
    }
  }
}
