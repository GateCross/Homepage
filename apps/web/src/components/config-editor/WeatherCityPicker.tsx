import { useMemo, useState, type JSX } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  WEATHER_CITIES,
  findWeatherCity,
  type WeatherCity,
} from "@/lib/weather-cities";
import { cn } from "@/lib/utils";

export type WeatherCityPickerProps = {
  cityId: string;
  location: string;
  disabled?: boolean;
  onSelect: (city: WeatherCity) => void;
};

export function WeatherCityPicker({
  cityId,
  location,
  disabled,
  onSelect,
}: WeatherCityPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const matched = findWeatherCity(cityId);
  const displayName = matched?.name ?? (location.trim() || "选择城市");
  const displayId = cityId.trim() || "—";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) {
      return WEATHER_CITIES;
    }
    return WEATHER_CITIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.cityId.includes(q) ||
        c.name.includes(query.trim()),
    );
  }, [query]);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        className="h-auto w-full justify-between gap-2 px-3 py-2 font-normal"
        onClick={() => setOpen(true)}
      >
        <span className="flex min-w-0 flex-col items-start text-left">
          <span className="truncate text-sm text-foreground">{displayName}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {displayId}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <DialogContent className="overflow-hidden p-0 sm:max-w-md">
          <DialogHeader className="sr-only">
            <DialogTitle>选择天气城市</DialogTitle>
            <DialogDescription>
              搜索并选择中国天气网城市，用于小米天气数据源
            </DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false} className="rounded-none border-0">
            <CommandInput
              placeholder="搜索城市名或编码…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>未找到匹配城市</CommandEmpty>
              <CommandGroup heading={`共 ${filtered.length} 个城市`}>
                {filtered.map((city) => {
                  const selected = city.cityId === cityId.trim();
                  return (
                    <CommandItem
                      key={city.cityId}
                      value={`${city.name} ${city.cityId}`}
                      onSelect={() => {
                        onSelect(city);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <Check
                        className={cn(
                          "size-4 shrink-0",
                          selected ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{city.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {city.cityId}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
