export interface ErrorContext {
  agentName?: string | undefined;
  operation?: string | undefined;
  cause?: unknown;
}

// Base class carrying structured context (agent/operation/cause) so failures stay debuggable without leaking internals to end users.
export class AgentError extends Error {
  readonly agentName: string | undefined;
  readonly operation: string | undefined;
  override readonly cause: unknown;

  constructor(message: string, context: ErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.agentName = context.agentName;
    this.operation = context.operation;
    this.cause = context.cause;
  }
}

export class TimeoutError extends AgentError {}
export class ModelError extends AgentError {}
export class ToolExecutionError extends AgentError {}
export class HandoffExecutionError extends AgentError {}

// Builds a single-line, human-readable message for logs/conversation history without dumping raw stack traces or SDK internals.
export function toClearMessage(error: unknown): string {
  if (error instanceof AgentError) {
    const parts = [error.message];
    if (error.operation) parts.push(`operation=${error.operation}`);
    if (error.agentName) parts.push(`agent=${error.agentName}`);
    if (error.cause instanceof Error) parts.push(`cause=${error.cause.message}`);
    return parts.join(" | ");
  }
  return error instanceof Error ? error.message : String(error);
}
