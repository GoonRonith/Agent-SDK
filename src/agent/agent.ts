import "dotenv/config";
import { randomUUID } from "node:crypto";
import { HARNESS_PROMPT } from "./config.js";
import OpenAI from "openai";
import type { ZodSchema } from "zod";
import { OpenAIModel } from "../model/openAIModel.js";
import type { GeminiModel } from "../model/geminiModel.js";
import { sharedMemoryStore } from "../memory/memoryStore.js";
import { withRetry, withTimeout } from "../utils/reliability.js";
import { toClearMessage } from "../utils/errors.js";
import { redactSecrets } from "../utils/secrets.js";
import { Tracer, type TraceEvent } from "../utils/tracing.js";

interface AgentResult {
  finalOutput: string;
  messages: IConversations[];
  iterations: number;
  stopReason: "completed" | "max_iterations" | "error";
  trace: TraceEvent[];
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


export interface IRunContext {
  conversations: IConversations[];
  handoffDepth: number;
  handoffHistory: string[];
  runId: string;
  userId?: string | undefined;
  trace: Tracer;
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

  public async run(userQuery: string, context?: IRunContext, userId?: string, traceEnabled = false) {
    const isRootRun = context === undefined;
    const runContext: IRunContext = context ?? {
      conversations: [],
      handoffDepth: 0,
      handoffHistory: [],
      runId: randomUUID(),
      userId,
      trace: new Tracer(traceEnabled),
    };
    runContext.conversations.push({ role: "user", content: userQuery });

    const finalize = (result: Omit<AgentResult, "trace">): AgentResult => {
      if (isRootRun) runContext.trace.printSummary();
      return { ...result, trace: runContext.trace.getEvents() };
    };

    const memoryContext = { userId: runContext.userId, agentId: this.name, runId: runContext.runId };
    const memories = await sharedMemoryStore.recall(userQuery, memoryContext);
    const effectiveInstructions = this.instructions + sharedMemoryStore.formatForPrompt(memories);

    for (
      let currentIteration = 0;
      currentIteration <= this.MAX_ITERATION;
      currentIteration++
    ) {
      if (!this.agentConfig.model) {
        throw new Error("Model is not set");
      }
      let rawLLMResponse: string;
      const modelCallTrace = runContext.trace.start({
        runId: runContext.runId,
        type: "model_call",
        name: this.agentConfig.model.constructor.name,
        agentName: this.name,
        metadata: { iteration: currentIteration },
      });
      try {
        rawLLMResponse = (await this.agentConfig.model.generate(
          runContext.conversations,
          effectiveInstructions,
        )) as string;
        runContext.trace.end(modelCallTrace, "success");
      } catch (error) {
        const message = redactSecrets(toClearMessage(error));
        runContext.trace.end(modelCallTrace, "error", { error: message });
        console.log(`[${this.name}] Model call failed:`, message);
        return finalize({
          finalOutput: `I couldn't complete this request because the model call failed: ${message}`,
          messages: runContext.conversations,
          iterations: currentIteration + 1,
          stopReason: "error",
        });
      }

      console.log("Raw LLM Response:", rawLLMResponse);

      runContext.conversations.push({ role: "assistant", content: rawLLMResponse });
      let parsedLLMResponse = null;
      try {
        const response = JSON.parse(rawLLMResponse);
        parsedLLMResponse = response;
      } catch (error) {
        // Try to extract JSON from markdown code blocks or other text
        const jsonMatch =
          rawLLMResponse.match(/```(?:json)?\s*([\s\S]*?)```/) ||
          rawLLMResponse.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
          try {
            const extractedJson = jsonMatch[1] || jsonMatch[0];
            parsedLLMResponse = JSON.parse(extractedJson);
          } catch (innerError) {
            console.log(`[${this.name}] Could not parse extracted JSON, asking model to retry`);
          }
        }
      }

      if (!parsedLLMResponse || typeof parsedLLMResponse.step !== "string") {
        runContext.conversations.push({
          role: "developer",
          content: "Error: Response was not valid JSON matching the required pipeline format. Please respond again with ONLY valid JSON as instructed.",
        });
        continue;
      }
      // console.log("Parsed LLM Response:", parsedLLMResponse);
      if (parsedLLMResponse.step.toLowerCase() === "output") {
        await sharedMemoryStore.remember(
          [
            { role: "user", content: userQuery },
            { role: "assistant", content: parsedLLMResponse.text },
          ],
          memoryContext,
        );
        return finalize({
          finalOutput: parsedLLMResponse.text,
          messages: runContext.conversations,
          iterations: currentIteration + 1,
          stopReason: "completed",
        });
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
        const toolTrace = runContext.trace.start({
          runId: runContext.runId,
          type: "tool_call",
          name: functionName,
          agentName: this.name,
          metadata: { input },
        });
        try {
          const parsed = tool.inputSchema.safeParse(input);
          if (!parsed.success) {
            runContext.trace.end(toolTrace, "error", { error: "ValidationError" });
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
          const toolResult = await withRetry(() => tool.executor(parsed.data), {
            label: `tool:${functionName}`,
            retries: 1,
            baseDelayMs: 300,
            timeoutMs: 15_000,
          });
          // console.log(toolResult);
          runContext.trace.end(toolTrace, "success");

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
          const errorMessage = redactSecrets(toClearMessage(error));
          runContext.trace.end(toolTrace, "error", { error: errorMessage });
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

        const handoffTrace = runContext.trace.start({
          runId: runContext.runId,
          type: "handoff",
          name: agentName,
          agentName: this.name,
          metadata: { input, handoffDepth: runContext.handoffDepth },
        });

        if (runContext.handoffDepth >= this.MAX_HANDOFF_DEPTH) {
          const msg = `Max handoff depth (${this.MAX_HANDOFF_DEPTH}) reached, cannot hand off to ${agentName}`;
          console.log(`[${this.name}] Handoff blocked: ${msg}`);
          runContext.trace.end(handoffTrace, "error", { error: msg });
          runContext.conversations.push({
            role: "developer",
            content: `Error: ${msg}`,
          });
          continue;
        }

        if (runContext.handoffHistory.includes(agentName)) {
          const msg = `Handoff loop detected, ${agentName} already appears in the handoff chain [${runContext.handoffHistory.join(" -> ")}]`;
          console.log(`[${this.name}] Handoff blocked: loop detected in chain [${runContext.handoffHistory.join(" -> ")} -> ${agentName}]`);
          runContext.trace.end(handoffTrace, "error", { error: msg });
          runContext.conversations.push({
            role: "developer",
            content: `Error: ${msg}`,
          });
          continue;
        }

        try {
          const handoffResult = await withTimeout(
            () =>
              targetAgent.run(input, {
                conversations: runContext.conversations,
                handoffDepth: runContext.handoffDepth + 1,
                handoffHistory: [...runContext.handoffHistory, this.name],
                runId: runContext.runId,
                userId: runContext.userId,
                trace: runContext.trace,
              }),
            60_000,
            `handoff:${agentName}`,
          );
          console.log(`[${this.name}] Handoff to "${agentName}" completed:`, handoffResult?.finalOutput);
          runContext.trace.end(handoffTrace, "success");
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
          const errorMessage = redactSecrets(toClearMessage(error));
          console.log(`[${this.name}] Handoff to "${agentName}" errored:`, errorMessage);
          runContext.trace.end(handoffTrace, "error", { error: errorMessage });
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
        return finalize({
          finalOutput: "Max Iteration Reached",
          messages: runContext.conversations,
          iterations: currentIteration + 1,
          stopReason: "max_iterations",
        });
      }

      runContext.conversations.push({
        role: "user",
        content: "Continue with the next pipeline step.",
      });
    }
  }
}
