# Agent SDK

A small, from-scratch TypeScript SDK for building LLM-driven agents with tool calling,
multi-agent handoffs, persistent memory, tracing, and reliability (retries/timeouts/
clear errors) built in.

## How it works

Every agent runs an explicit pipeline, one LLM call per step, until it reaches `OUTPUT`:

```
INITAL -> THINK -> (TOOL_REQUEST | HANDOFF)* -> ANALYSE -> OUTPUT
```

- **TOOL_REQUEST** — the agent calls one of its own tools (validated with `zod`, retried on failure).
- **HANDOFF** — the agent delegates to another `Agent` from its `handoffs` list (loop/depth protected).
- Conversation state, handoff depth/history, run id, and tracing are all carried in a
  per-run `IRunContext`, so a single `Agent` instance is stateless and reusable across runs.

## Prerequisites

- Node.js 18+ (uses `node:crypto`, `node:readline/promises`, ESM).
- An [OpenAI](https://platform.openai.com/api-keys) API key and/or a
  [Google Gemini](https://aistudio.google.com/apikey) API key, depending on which model(s) you use.
- (Optional) A [mem0](https://app.mem0.ai/) API key if you want persistent cross-run memory.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Create a `.env` file in the project root (this is gitignored, never commit it):

   ```env
   # Required if you use OpenAIModel
   OPENAI_API_KEY=sk-...

   # Required if you use GeminiModel
   GEMINI_API_KEY=...

   # Optional - enables persistent memory (recall/remember) via mem0
   MEM0_API_KEY=...
   # Optional - fallback user id used to scope memories when none is passed to run()
   MEM0_USER_ID=default-user
   ```

   Only set the keys for the model(s) you actually construct — `OpenAIModel`/`GeminiModel`
   throw a clear startup error if their required key is missing. If `MEM0_API_KEY` is unset,
   memory is silently disabled (agents still work, just without recall/remember).

3. Build or run directly:

   ```powershell
   npm run build      # compiles src/ -> dist/ with tsc
   npm run cli        # interactive REPL via tsx (no build needed)
   npm start          # runs the compiled CLI from dist/
   ```

## Using the CLI

`npm run cli` starts an interactive chat against a demo `Main Agent` (with `Math Agent` and
`Weather Agent` handoffs configured in [src/cli.ts](src/cli.ts)):

```powershell
npm run cli
You: what is 20% of 1000?
Agent: 20% of 1000 is 200.
You: exit
```

- One-shot mode: `npm run cli -- "what is 20% of 1000?"` runs a single query and exits.
- Tracing is off by default. Enable it with `--trace` (one-shot) or toggle it mid-session
  with `/trace on` / `/trace off` to see per-step timing for model calls, tool calls, and handoffs.
- Conversation continuity across turns relies on mem0 memory (if configured), not in-process
  state — each turn is an independent `run()` call scoped to a stable per-session `userId`.

## Building your own agents

```ts
import { Agent } from "./agent/agent.js";
import type { ITool } from "./agent/agent.js";
import { OpenAIModel } from "./model/openAIModel.js";
import { z } from "zod";

const model = new OpenAIModel();

const echoTool: ITool<{ text: string }, { text: string }> = {
  name: "echo",
  desc: "Echoes back the given text",
  inputSchema: z.object({ text: z.string() }),
  async executor({ text }) {
    return { text };
  },
};

const billingAgent = Agent.builder()
  .setName("Billing Agent")
  .setModel(model)
  .setInstructions("You handle billing and refund questions")
  .build();

const mainAgent = Agent.builder()
  .setName("Main Agent")
  .setModel(model)
  .setInstructions("You are a helpful assistant")
  .tool(echoTool)
  .setHandOffs([billingAgent]) // delegate matching requests instead of solving them
  .build();

const result = await mainAgent.run("I want a refund for order #123");
console.log(result?.finalOutput);
```

`Agent.run(userQuery, context?, userId?, traceEnabled?)`:
- `context` — an `IRunContext` to resume/share state (mainly used internally for handoffs); omit for a fresh top-level run.
- `userId` — scopes mem0 memory recall/remember to a specific user.
- `traceEnabled` — set `true` to print a timed trace summary (model calls, tool calls, handoffs) for this run.

`result` (`AgentResult`) contains `finalOutput`, `messages`, `iterations`, `stopReason`
(`"completed" | "max_iterations" | "error"`), and `trace` (structured `TraceEvent[]`, empty unless `traceEnabled`).

## Adding a custom model

Implement `IModel` ([src/model/baseModel.ts](src/model/baseModel.ts)):

```ts
export interface IModel {
  generate(conversations: IConversations[], instructions: string): Promise<string | undefined>;
}
```

See [src/model/openAIModel.ts](src/model/openAIModel.ts) and
[src/model/geminiModel.ts](src/model/geminiModel.ts) for reference implementations, including
required-env validation (`requireEnv`) and retry/timeout wrapping (`withRetry`).

## Project structure

```
src/
  agent/
    agent.ts      # Agent / AgentBuilder - pipeline runner, tools, handoffs
    config.ts     # HARNESS_PROMPT - the pipeline system prompt
  model/
    baseModel.ts    # IModel interface
    openAIModel.ts  # OpenAI implementation
    geminiModel.ts  # Gemini implementation
  memory/
    memoryStore.ts  # mem0-backed recall/remember, fails open if disabled/unavailable
  utils/
    reliability.ts  # withRetry / withTimeout
    errors.ts       # AgentError hierarchy + toClearMessage()
    secrets.ts      # requireEnv() / redactSecrets()
    tracing.ts      # Tracer - opt-in timed event recording
  cli.ts          # interactive/one-shot CLI entry point
  index.ts        # scripted example/test entry point
```

## Reliability notes

- Model calls and tool executions are retried with exponential backoff (`withRetry`) and bounded by a timeout.
- Handoffs are bounded by `MAX_HANDOFF_DEPTH` (5) and cycle detection (`handoffHistory`), plus an overall `MAX_ITERATION` (30) cap per run.
- Errors are normalized via `toClearMessage()` and passed through `redactSecrets()` before being logged or fed back into the conversation, so API keys/tokens never leak into logs or prompts.
- Missing required environment variables fail fast at model construction time with a clear message (no secret values are ever logged).
