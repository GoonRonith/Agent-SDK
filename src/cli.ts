import "dotenv/config";
import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import axios from "axios";
import { z } from "zod";
import { Agent } from "./agent/agent.js";
import type { ITool } from "./agent/agent.js";
import { OpenAIModel } from "./model/openAIModel.js";

const weatherTool: ITool<
  { city: string },
  { city: string; temperature: string }
> = {
  name: "fetchWeatherInfo",
  desc: "Fetches realtime weather data by cityname",
  doc: "fetchWeatherInfo(cityName: string): WeatherReport",
  inputSchema: z.object({
    city: z.string(),
  }),
  async executor({ city }) {
    const url = `https://wttr.in/${city.toLowerCase()}?format=%C+%t`;
    const response = await axios.get(url, { responseType: "text" });
    return { city: city, temperature: response.data };
  },
};

function buildMainAgent(): Agent {
  const model = new OpenAIModel();

  const mathAgent = Agent.builder()
    .setName("Math Agent")
    .setModel(model)
    .setInstructions("You are expert AI assistant for Math problem solving")
    .build();

  const weatherAgent = Agent.builder()
    .setName("Weather Agent")
    .setModel(model)
    .tool(weatherTool)
    .setInstructions("You are expert AI assistant for fetching weather data")
    .build();

  return Agent.builder()
    .setName("Main Agent")
    .setModel(model)
    .setHandOffs([mathAgent, weatherAgent])
    .setInstructions("You are expert AI assistant")
    .build();
}

async function main() {
  const mainAgent = buildMainAgent();
  // Ties recall/remember in mem0 to this CLI session; conversation continuity across turns relies on that memory rather than in-process state.
  const userId = process.env.MEM0_USER_ID ?? randomUUID();

  const args = process.argv.slice(2);
  if (args.length > 0) {
    const query = args.join(" ");
    const result = await mainAgent.run(query, undefined, userId);
    console.log(result?.finalOutput ?? "No output produced.");
    return;
  }

  const rl = readline.createInterface({ input, output });
  console.log('Agent SDK CLI - type your message, "exit" to quit.\n');

  try {
    while (true) {
      const query = (await rl.question("You: ")).trim();
      if (!query) continue;
      if (query.toLowerCase() === "exit" || query.toLowerCase() === "quit") break;

      const result = await mainAgent.run(query, undefined, userId);
      console.log(`Agent: ${result?.finalOutput ?? "No output produced."}\n`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("CLI failed:", error);
  process.exitCode = 1;
});
