/** 中国天气网城市编码（与小米天气 locationKey weathercn:cityId 一致） */
import cities from "./weather-cities.json";

export type WeatherCity = {
  cityId: string;
  name: string;
};

export const WEATHER_CITIES: readonly WeatherCity[] = cities;

export function findWeatherCity(cityId: string): WeatherCity | undefined {
  const id = cityId.trim().replace(/^weathercn:/i, "");
  return WEATHER_CITIES.find((c) => c.cityId === id);
}
