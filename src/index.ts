import { Agent } from "./agent/agent.js";
import axios from "axios";
import type { ITool } from "./agent/agent.js";
import { z } from "zod";
import { OpenAIModel } from "./model/openAIModel.js";
import { GeminiModel } from "./model/geminiModel.js";

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

const openAIModelTest = new OpenAIModel();
const geminiModelTest = new GeminiModel();

// const myAgent1: Agent = Agent.builder()
//   .setModel(geminiModelTest)
//   .setInstructions("You are expert AI assistant")
//   .tool(weatherTool)
//   .build();

// const response1 = await myAgent1.run("What is the weather in kolkata ?");

// console.log(response1?.finalOutput);

const mathAgent: Agent = Agent.builder()
  .setName('Math Agent')
  .setModel(openAIModelTest)
  .setInstructions("You are expert AI assistant for Math problem solving")
  .build();

const myAgent2: Agent = Agent.builder()
  .setName('Main Agent')
  .setModel(openAIModelTest)
  .setHandOffs([mathAgent])
  .setInstructions("You are expert AI assistant")
  .tool(weatherTool)
  .build();

const response2 = await myAgent2.run("What is the result of 2*21*3 ?");

console.log(response2?.finalOutput);
