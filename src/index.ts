import { Agent } from "./agent/agent.js";
import axios from "axios";
import type { ITool } from "./agent/agent.js";
import { z } from "zod";

const weatherTool: ITool<{ city: string }, { city: string, temperature: string }> = {
  name: "fetchWeatherInfo",
  desc: "Fetches realtime weather data by cityname",
  doc: "fetchWeatherInfo(cityName: string): WeatherReport",
  inputSchema: z.object({
    city: z.string(),
  }),
  async executor({city}) {
    const url = `https://wttr.in/${city.toLowerCase()}?format=%C+%t`;
    const response = await axios.get(url, { responseType: "text" });
    return { city: city, temperature: response.data };
  },
};

const myAgent: Agent = Agent.builder()
  .setInstructions("You are expert AI assistant")
  .tool(weatherTool)
  .build();

const response = await myAgent.run("What is the weather in kolkata ?");

console.log(response![response?.length! - 1]);
