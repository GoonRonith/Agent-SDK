import { Agent } from "./agent/agent.js";
import axios from "axios";
import type { ITool } from "./agent/agent.js";

const weatherTool: ITool = {
    name: 'fetchWeatherInfo',
    desc: 'Fetches realtime weather data by cityname',
    doc: 'fetchWeatherInfo(cityName: string): WeatherReport',
    async executor(cityName) {
        const url = `https://wttr.in/${cityName.toLowerCase()}?format=%C+%t`;
        const response = await axios.get(url, { responseType: 'text' });
        return JSON.stringify({ cityName, weatherInfo: response.data });
    },
}

const myAgent:Agent = Agent.builder()
.setInstructions("You are expert AI assistant")
.tool(weatherTool)
.build()

const response = await myAgent.run("What is the weather in kolkata ?")

console.log(response![response?.length! - 1])


