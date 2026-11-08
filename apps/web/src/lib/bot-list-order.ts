import { t } from "@lingui/core/macro";
import type { BotListOrder } from "@rakazo/contracts";
import { createBotListOrderStore } from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import { useSyncExternalStore } from "react";
import { rpc } from "./rpc";

// Module-level so a choice outlives the shell remounting on a space switch. The order is
// account-wide, so the selected space's client saves it for every space.
export const botListOrder = createBotListOrderStore((order) =>
  rpc.preferences.update({ botListOrder: order }),
);

export const useBotListOrder = () => useSyncExternalStore(botListOrder.subscribe, botListOrder.get);

export function chooseBotListOrder(order: BotListOrder): void {
  botListOrder.choose(order, () => toast.error(t`Could not save`));
}
