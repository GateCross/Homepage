import { z } from "zod";

export const InfoWidgetTypeSchema = z.enum([
  "datetime",
  "openmeteo",
  "resources",
]);

export type InfoWidgetType = z.infer<typeof InfoWidgetTypeSchema>;

/** 逐小时预报点 */
export const WeatherHourlyItemSchema = z.object({
  /** ISO 8601 本地时间（含偏移） */
  time: z.string().min(1),
  temperatureC: z.number(),
  weatherCode: z.number().optional(),
  conditionText: z.string().min(1).optional(),
});

export type WeatherHourlyItem = z.infer<typeof WeatherHourlyItemSchema>;

/** 逐日预报点 */
export const WeatherDailyItemSchema = z.object({
  /** 日历日 YYYY-MM-DD（当地） */
  date: z.string().min(1),
  temperatureMaxC: z.number(),
  temperatureMinC: z.number(),
  weatherCode: z.number().optional(),
  conditionText: z.string().min(1).optional(),
});

export type WeatherDailyItem = z.infer<typeof WeatherDailyItemSchema>;

export const OpenMeteoInfoResponseSchema = z
  .object({
    temperatureC: z.number(),
    conditionText: z.string().min(1).optional(),
    weatherCode: z.number().optional(),
    /** 地点名称（展示用） */
    location: z.string().min(1).optional(),
    /** 相对湿度 0–100（百分比） */
    humidityPercent: z.number().min(0).max(100).optional(),
    /**
     * 中国国标 AQI（HJ633）。
     * 仅在数值可确认为国标口径时提供；不得用美标数字填充。
     */
    aqi: z.number().nonnegative().optional(),
    /** 体感温度 ℃ */
    feelsLikeC: z.number().optional(),
    /** 风速 km/h */
    windSpeedKmh: z.number().nonnegative().optional(),
    /** 风向角度 0–360（气象来向） */
    windDirectionDeg: z.number().min(0).max(360).optional(),
    /** 今日日出 ISO 8601（当地偏移） */
    sunrise: z.string().min(1).optional(),
    /** 今日日落 ISO 8601（当地偏移） */
    sunset: z.string().min(1).optional(),
    /** 未来逐小时（已截断，通常约 12–24 点） */
    hourly: z.array(WeatherHourlyItemSchema).optional(),
    /** 未来逐日（含今天，通常约 5–7 天） */
    daily: z.array(WeatherDailyItemSchema).optional(),
  })
  .refine(
    (value) =>
      value.conditionText !== undefined || value.weatherCode !== undefined,
    {
      message: "至少需要提供 conditionText 或 weatherCode 之一",
      path: ["conditionText"],
    },
  );

export type OpenMeteoInfoResponse = z.infer<typeof OpenMeteoInfoResponseSchema>;

export const ResourceAvailableItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  percent: z.number().min(0).max(100),
  /** 已使用字节数（内存 / 磁盘） */
  usedBytes: z.number().nonnegative().optional(),
  /** 总容量字节数（内存 / 磁盘） */
  totalBytes: z.number().positive().optional(),
});

export type ResourceAvailableItem = z.infer<typeof ResourceAvailableItemSchema>;

export const ResourceUnavailableItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.literal("unavailable"),
  message: z.string().min(1),
});

export type ResourceUnavailableItem = z.infer<
  typeof ResourceUnavailableItemSchema
>;

export const ResourceItemSchema = z.union([
  ResourceUnavailableItemSchema,
  ResourceAvailableItemSchema,
]);

export type ResourceItem = z.infer<typeof ResourceItemSchema>;

export const ResourcesInfoResponseSchema = z.object({
  items: z.array(ResourceItemSchema),
});

export type ResourcesInfoResponse = z.infer<typeof ResourcesInfoResponseSchema>;
