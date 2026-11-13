/** 信息组件与外部数据契约：天气（Open-Meteo / 中国天气网）与系统资源。 */

export type InfoWidgetType = "datetime" | "openmeteo" | "resources";

/** 逐小时预报点 */
export type WeatherHourlyItem = {
  /** ISO 8601 本地时间（含偏移） */
  time: string;
  temperatureC: number;
  weatherCode?: number | undefined;
  conditionText?: string | undefined;
};

/** 逐日预报点 */
export type WeatherDailyItem = {
  /** 日历日 YYYY-MM-DD（当地） */
  date: string;
  temperatureMaxC: number;
  temperatureMinC: number;
  weatherCode?: number | undefined;
  conditionText?: string | undefined;
};

/** GET /api/info/{infoId} 的天气响应体 */
export type OpenMeteoInfoResponse = {
  temperatureC: number;
  conditionText?: string | undefined;
  weatherCode?: number | undefined;
  /** 地点名称（展示用） */
  location?: string | undefined;
  /** 相对湿度 0–100（百分比） */
  humidityPercent?: number | undefined;
  /** 中国国标 AQI（HJ633）。仅在数值可确认为国标口径时提供。 */
  aqi?: number | undefined;
  /** 体感温度 ℃ */
  feelsLikeC?: number | undefined;
  /** 风速 km/h */
  windSpeedKmh?: number | undefined;
  /** 风向角度 0–360（气象来向） */
  windDirectionDeg?: number | undefined;
  /** 紫外线指数（无量纲，通常 0–15） */
  uvIndex?: number | undefined;
  /** 气压 hPa */
  pressureHpa?: number | undefined;
  /** 今日日出 ISO 8601（当地偏移） */
  sunrise?: string | undefined;
  /** 今日日落 ISO 8601（当地偏移） */
  sunset?: string | undefined;
  /** 未来逐小时（已截断，通常约 12–24 点） */
  hourly?: WeatherHourlyItem[] | undefined;
  /** 未来逐日（含今天，通常约 5–7 天） */
  daily?: WeatherDailyItem[] | undefined;
};

export type ResourceAvailableItem = {
  id: string;
  label: string;
  percent: number;
  /** 已使用字节数（内存 / 磁盘） */
  usedBytes?: number | undefined;
  /** 总容量字节数（内存 / 磁盘） */
  totalBytes?: number | undefined;
};

export type ResourceUnavailableItem = {
  id: string;
  label: string;
  status: "unavailable";
  message: string;
};

export type ResourceItem = ResourceUnavailableItem | ResourceAvailableItem;

export type ResourcesInfoResponse = {
  items: ResourceItem[];
};
