import type { BotListOrder } from "@rakazo/contracts";
import { createBotListOrderStore } from "@rakazo/core";
import { useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { rpc } from "./api";
import { t } from "./i18n";
import { registerSessionDiskCache } from "./session";

/** One for the app, so every inbox follows a pick and a save outlives the inbox that made it. */
export const botListOrderStore = createBotListOrderStore((botListOrder) =>
  rpc("preferences/update", { botListOrder }),
);

// A sign-out, another account or another server forgets the last account's order.
registerSessionDiskCache((sameAccount) => {
  if (!sameAccount) botListOrderStore.reset();
});

export function useBotListOrder() {
  return useSyncExternalStore(botListOrderStore.subscribe, botListOrderStore.get);
}

/** The list follows at once; a failed save rolls back. */
export function chooseBotListOrder(order: BotListOrder) {
  botListOrderStore.choose(order, () => Alert.alert(t("Could not save")));
}
