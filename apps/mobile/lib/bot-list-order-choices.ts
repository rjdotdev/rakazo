import type { BotListOrder } from "@rakazo/contracts";

export function botListOrderChoices(t: (text: string) => string) {
  return [
    { order: "manual", label: t("Manual") },
    { order: "recent", label: t("Most recent") },
  ] as const satisfies readonly { order: BotListOrder; label: string }[];
}
