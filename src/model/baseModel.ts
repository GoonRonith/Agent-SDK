import type{ IConversations } from "../agent/agent.js";

export interface IModel {
    generate(conversations: IConversations[], instructions: string): Promise<string | undefined>;
}

