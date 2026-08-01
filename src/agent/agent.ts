import "dotenv/config";
import { HARNESS_PROMPT } from "./config.js";
import OpenAI from "openai";
import type { ZodSchema } from "zod";
import { OpenAIModel } from "../model/openAIModel.js";
import type { GeminiModel } from "../model/geminiModel.js";

interface AgentResult {
  finalOutput: string;
  messages: IConversations[];
  iterations: number;
  stopReason: "completed" | "max_iterations";
}

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
  model: OpenAIModel | GeminiModel | null;
}

export interface IConversations {
  role: "user" | "assistant" | "system" | "developer";
  content: string;
}

export class AgentBuilder {
  private agentConfig: IAgentConfig = {
    instructions: "",
    tools: [],
    model: null,
  };

  constructor() {
    this.agentConfig.tools = [];
    this.agentConfig.instructions = "";
  }

  public setModel(model: OpenAIModel | GeminiModel) {
    this.agentConfig.model = model;
    return this;
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
        ${agentConfig.tools.map((t) => JSON.stringify({ functionName: t.name, functionDescription: t.desc, functionDoc: t.doc, inputSchema: t.inputSchema })).join("\n")}
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
      if (!this.agentConfig.model) {
        throw new Error("Model is not set");
      }
      const rawLLMResponse = (await this.agentConfig.model.generate(
        this.conversations,
        this.instructions,
      )) as string;

      // console.log("Raw LLM Response:", rawLLMResponse);

      this.conversations.push({ role: "assistant", content: rawLLMResponse });
      let parsedLLMResponse = null;
      try {
        const response = JSON.parse(rawLLMResponse);
        parsedLLMResponse = response;
      } catch (error) {
        // console.log(
          // "Initial JSON parsing failed, attempting to extract JSON from response",
        // );

        // Try to extract JSON from markdown code blocks or other text
        const jsonMatch =
          rawLLMResponse.match(/```(?:json)?\s*([\s\S]*?)```/) ||
          rawLLMResponse.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          try {
            const extractedJson = jsonMatch[1] || jsonMatch[0];
            parsedLLMResponse = JSON.parse(extractedJson);
            // console.log("Successfully extracted JSON from response");
          } catch (innerError) {
            // console.error("Failed to parse extracted JSON:", innerError);
            throw new Error("Could not parse response as JSON");
          }
        } else {
          // console.error("No JSON found in response:", rawLLMResponse);
          throw new Error("Response is not valid JSON");
        }
      }
      // console.log("Parsed LLM Response:", parsedLLMResponse);
      if (parsedLLMResponse.step.toLowerCase() === "output") {
        const result: AgentResult = {
          finalOutput: parsedLLMResponse.text,
          messages: this.conversations,
          iterations: currentIteration + 1,
          stopReason: "completed",
        };
        return result;
      }

      if (parsedLLMResponse.step.toLowerCase() === "tool_request") {
        // console.log("inside tool request block");

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
            this.conversations.push({
              role: "developer",
              content: JSON.stringify({
                success: false,
                functionName,
                input,
                errorType: "ValidationError",
                error: parsed.error.flatten(),
              }),
            });

            continue;
          }
          const toolResult = await tool.executor(parsed.data);
          // console.log(toolResult);

          this.conversations.push({
            role: "developer",
            content: JSON.stringify({
              success: true,
              functionName,
              input,
              toolResult,
            }),
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          // console.log("Tool Error", errorMessage);
          this.conversations.push({
            role: "developer",
            content: JSON.stringify({
              success: false,
              functionName,
              input,
              errorType: "ExecutionError",
              error: errorMessage,
            }),
          });
        }
      }

      if (currentIteration === this.MAX_ITERATION) {
        const result: AgentResult = {
          finalOutput: "Max Iteration Reached",
          messages: this.conversations,
          iterations: currentIteration + 1,
          stopReason: "max_iterations",
        };
        return result;
      }

      this.conversations.push({
        role: "user",
        content: "Continue with the next pipeline step.",
      });
    }
  }
}
