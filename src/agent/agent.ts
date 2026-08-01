import "dotenv/config";
import { HARNESS_PROMPT } from "./config.js";
import OpenAI from "openai";

export interface ITool {
  name: string;
  desc: string;
  doc?: string;
  executor: (input: string) => Promise<string>;
}

interface IAgentConfig {
  instructions: string;
  tools: ITool[];
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

  public tool(tool: ITool) {
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
  private toolMapping: Map<string, ITool>;
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
        ${agentConfig.tools.map((t) => JSON.stringify({ functionName: t.name, functionDescription: t.desc, functionDoc: t.doc })).join("\n")}
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
          const toolResult = await tool.executor(input);
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
