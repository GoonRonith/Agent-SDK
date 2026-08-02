import "dotenv/config";
import { MemoryClient } from "mem0ai";

const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_USER_ID = process.env.MEM0_USER_ID ?? "default-user";

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

    const results = await this.client.search(query, {
      top_k: limit,
      user_id: context.userId ?? MEM0_USER_ID,
      ...(context.agentId ? { agent_id: context.agentId } : {}),
      ...(context.runId ? { run_id: context.runId } : {}),
    });

    return results
      .map((item) => item.memory ?? item.data?.memory)
      .filter((value): value is string => Boolean(value));
  }

  async remember(messages: MemoryMessage[], context: MemoryContext = {}): Promise<void> {
    if (!this.client || messages.length === 0) return;

    await this.client.add(messages, {
      user_id: context.userId ?? MEM0_USER_ID,
      ...(context.agentId ? { agent_id: context.agentId } : {}),
      ...(context.runId ? { run_id: context.runId } : {}),
    });
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
