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
  name: string;
  instructions: string;
  tools: ITool<any, any>[];
  model: OpenAIModel | GeminiModel | null;
  handoffs?: Agent[]
}

export interface IConversations {
  role: "user" | "assistant" | "system" | "developer";
  content: string;
}

// Per-run state threaded through an agent (and any handoffs it triggers), keeping Agent instances stateless/reusable.
export interface IRunContext {
  conversations: IConversations[];
  handoffDepth: number;
  handoffHistory: string[];
}

export class AgentBuilder {
  private agentConfig: IAgentConfig = {
    name: "",
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

  public setName(name: string) {
    this.agentConfig.name = name;
    return this;
  }

  public setInstructions(instructions: string) {
    this.agentConfig.instructions = instructions;
    return this;
  }

  public setHandOffs(handOffs: Agent[]) {
    this.agentConfig.handoffs = [
      ...(this.agentConfig.handoffs || []),
      ...handOffs,
    ];
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
  private name: string;
  private instructions: string;
  private toolMapping: Map<string, ITool<any, any>>;
  private handoffMapping: Map<string, Agent>;
  private MAX_ITERATION = 30;
  private MAX_HANDOFF_DEPTH = 5;
  private handoffs: Agent[]

  constructor(private agentConfig: IAgentConfig) {
    this.instructions = `
        ${HARNESS_PROMPT}\n\n
        
        System Prompt:
        ${agentConfig.instructions}

        Available Tools:
        ${agentConfig.tools.map((t) => JSON.stringify({ functionName: t.name, functionDescription: t.desc, functionDoc: t.doc, inputSchema: t.inputSchema })).join("\n")}
        Handoffs:
        ${agentConfig.handoffs?.map((h) => JSON.stringify({ instructions: h.agentConfig.instructions, agentName: h.agentConfig.name })).join("\n")}
    `;
    this.name = agentConfig.name;
    this.handoffs = agentConfig.handoffs || []
    this.toolMapping = new Map();
    for (const tool of agentConfig.tools) {
      this.toolMapping.set(tool.name, tool);
    }
    this.handoffMapping = new Map();
    for (const handoff of this.handoffs) {
      this.handoffMapping.set(handoff.agentConfig.name, handoff);
    }
  }

  static builder() {
    return new AgentBuilder();
  }

  public async run(userQuery: string, context?: IRunContext) {
    const runContext: IRunContext = context ?? {
      conversations: [],
      handoffDepth: 0,
      handoffHistory: [],
    };
    runContext.conversations.push({ role: "user", content: userQuery });

    for (
      let currentIteration = 0;
      currentIteration <= this.MAX_ITERATION;
      currentIteration++
    ) {
      if (!this.agentConfig.model) {
        throw new Error("Model is not set");
      }
      const rawLLMResponse = (await this.agentConfig.model.generate(
        runContext.conversations,
        this.instructions,
      )) as string;

      console.log("Raw LLM Response:", rawLLMResponse);

      runContext.conversations.push({ role: "assistant", content: rawLLMResponse });
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
          messages: runContext.conversations,
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
          runContext.conversations.push({
            role: "developer",
            content: `Error: Function with name ${functionName} does not exists`,
          });
          continue;
        }
        try {
          const parsed = tool.inputSchema.safeParse(input);
          if (!parsed.success) {
            runContext.conversations.push({
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

          runContext.conversations.push({
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
          runContext.conversations.push({
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

      if (parsedLLMResponse.step.toLowerCase() === "handoff") {
        const { agentName, input } = parsedLLMResponse;
        console.log(`[${this.name}] Handing off to "${agentName}" with input:`, input);
        const targetAgent = this.handoffMapping.get(agentName);
        if (!targetAgent) {
          console.log(`[${this.name}] Handoff failed: agent "${agentName}" not found`);
          runContext.conversations.push({
            role: "developer",
            content: `Error: Handoff agent with name ${agentName} does not exist`,
          });
          continue;
        }

        if (runContext.handoffDepth >= this.MAX_HANDOFF_DEPTH) {
          console.log(`[${this.name}] Handoff blocked: max handoff depth (${this.MAX_HANDOFF_DEPTH}) reached`);
          runContext.conversations.push({
            role: "developer",
            content: `Error: Max handoff depth (${this.MAX_HANDOFF_DEPTH}) reached, cannot hand off to ${agentName}`,
          });
          continue;
        }

        if (runContext.handoffHistory.includes(agentName)) {
          console.log(`[${this.name}] Handoff blocked: loop detected in chain [${runContext.handoffHistory.join(" -> ")} -> ${agentName}]`);
          runContext.conversations.push({
            role: "developer",
            content: `Error: Handoff loop detected, ${agentName} already appears in the handoff chain [${runContext.handoffHistory.join(" -> ")}]`,
          });
          continue;
        }

        try {
          const handoffResult = await targetAgent.run(input, {
            conversations: runContext.conversations,
            handoffDepth: runContext.handoffDepth + 1,
            handoffHistory: [...runContext.handoffHistory, this.name],
          });
          console.log(`[${this.name}] Handoff to "${agentName}" completed:`, handoffResult?.finalOutput);
          runContext.conversations.push({
            role: "developer",
            content: JSON.stringify({
              success: true,
              agentName,
              input,
              handoffResult: handoffResult?.finalOutput,
            }),
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.log(`[${this.name}] Handoff to "${agentName}" errored:`, errorMessage);
          runContext.conversations.push({
            role: "developer",
            content: JSON.stringify({
              success: false,
              agentName,
              input,
              errorType: "HandoffError",
              error: errorMessage,
            }),
          });
        }
      }

      if (currentIteration === this.MAX_ITERATION) {
        const result: AgentResult = {
          finalOutput: "Max Iteration Reached",
          messages: runContext.conversations,
          iterations: currentIteration + 1,
          stopReason: "max_iterations",
        };
        return result;
      }

      runContext.conversations.push({
        role: "user",
        content: "Continue with the next pipeline step.",
      });
    }
  }
}
