import { randomUUID } from "node:crypto";

export type TraceEventType = "run" | "model_call" | "tool_call" | "handoff";
export type TraceEventStatus = "started" | "success" | "error";

export interface TraceEvent {
  id: string;
  runId: string;
  type: TraceEventType;
  name: string;
  agentName: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: TraceEventStatus;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface StartTraceParams {
  runId: string;
  type: TraceEventType;
  name: string;
  agentName: string;
  metadata?: Record<string, unknown>;
}

/** Records timed, structured events (model calls, tool calls, handoffs) for a run and can print/export them for debugging. Off by default - callers opt in. */
export class Tracer {
  private events: TraceEvent[] = [];

  constructor(private enabled = false) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  start(params: StartTraceParams): TraceEvent | null {
    if (!this.enabled) return null;
    const event: TraceEvent = {
      id: randomUUID(),
      runId: params.runId,
      type: params.type,
      name: params.name,
      agentName: params.agentName,
      startedAt: Date.now(),
      status: "started",
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
    this.events.push(event);
    console.log(`[trace] -> ${event.type}:${event.name} (agent=${event.agentName})`);
    return event;
  }

  end(
    event: TraceEvent | null,
    status: Exclude<TraceEventStatus, "started">,
    extra?: { error?: string; metadata?: Record<string, unknown> },
  ): void {
    if (!event) return;
    event.endedAt = Date.now();
    event.durationMs = event.endedAt - event.startedAt;
    event.status = status;
    if (extra?.error) event.error = extra.error;
    if (extra?.metadata) event.metadata = { ...event.metadata, ...extra.metadata };

    const icon = status === "success" ? "OK" : "FAIL";
    const suffix = extra?.error ? ` - ${extra.error}` : "";
    console.log(
      `[trace] <- ${event.type}:${event.name} (agent=${event.agentName}) ${icon} in ${event.durationMs}ms${suffix}`,
    );
  }

  /** Runs fn as a traced span: records start/end, timing and error automatically. */
  async wrap<T>(params: StartTraceParams, fn: () => Promise<T>): Promise<T> {
    const event = this.start(params);
    try {
      const result = await fn();
      this.end(event, "success");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.end(event, "error", { error: message });
      throw error;
    }
  }

  getEvents(): TraceEvent[] {
    return this.events;
  }

  printSummary(): void {
    if (!this.enabled || this.events.length === 0) return;
    const totalMs = this.events.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
    const errorCount = this.events.filter((e) => e.status === "error").length;
    console.log(
      `[trace] Summary: ${this.events.length} events, ${errorCount} error(s), ${totalMs}ms total`,
    );
    for (const e of this.events) {
      const icon = e.status === "error" ? "FAIL" : e.status === "success" ? "OK" : "?";
      console.log(
        `  ${icon} [${e.type}] ${e.name} (agent=${e.agentName}) - ${e.durationMs ?? "?"}ms${e.error ? ` - ${e.error}` : ""}`,
      );
    }
  }
}
