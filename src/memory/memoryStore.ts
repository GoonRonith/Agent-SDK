import "dotenv/config";
import { MemoryClient } from "mem0ai";
import { withTimeout } from "../utils/reliability.js";
import { redactSecrets } from "../utils/secrets.js";

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_USER_ID = process.env.MEM0_USER_ID ?? "default-user";
const MEM0_TIMEOUT_MS = 8_000;

export interface MemoryContext {
  userId?: string | undefined;
  agentId?: string | undefined;
  runId?: string | undefined;
}

export interface MemoryMessage {
  role: "user" | "assistant";
  content: string;
}

export class MemoryStore {
  private readonly client?: MemoryClient;
  readonly enabled: boolean;

  constructor() {
    if (MEM0_API_KEY) {
      this.client = new MemoryClient({ apiKey: MEM0_API_KEY });
      this.enabled = true;
    } else {
      this.enabled = false;
    }
  }

  async recall(query: string, context: MemoryContext = {}, limit = 5): Promise<string[]> {
    if (!this.client) return [];

    try {
      const results = await withTimeout(
        // Scoped by user_id only: memories must survive across runs/agents, so run_id/agent_id
        // (which are unique per call) must never be used to filter recall.
        () =>
          this.client!.search(query, {
            top_k: limit,
            user_id: context.userId ?? MEM0_USER_ID,
          }),
        MEM0_TIMEOUT_MS,
        "mem0.search",
      );

      return results
        .map((item) => item.memory ?? item.data?.memory)
        .filter((value): value is string => Boolean(value));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[memory] recall failed, continuing without memories: ${redactSecrets(message)}`);
      return [];
    }
  }

  async remember(messages: MemoryMessage[], context: MemoryContext = {}): Promise<void> {
    if (!this.client || messages.length === 0) return;

    try {
      await withTimeout(
        () =>
          this.client!.add(messages, {
            user_id: context.userId ?? MEM0_USER_ID,
            ...(context.agentId ? { agent_id: context.agentId } : {}),
            ...(context.runId ? { run_id: context.runId } : {}),
          }),
        MEM0_TIMEOUT_MS,
        "mem0.add",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[memory] remember failed, continuing: ${redactSecrets(message)}`);
    }
  }

  formatForPrompt(memories: string[]): string {
    if (memories.length === 0) return "";

    return `
        Relevant memories from past conversations:
        ${memories.map((memory, index) => `${index + 1}. ${memory}`).join("\n")}
        Use these memories when helpful. Do not mention the memory system unless asked.`;
  }

  get modeLabel(): string {
    return this.enabled ? "mem0 platform" : "disabled";
  }
}

export const sharedMemoryStore = new MemoryStore();
