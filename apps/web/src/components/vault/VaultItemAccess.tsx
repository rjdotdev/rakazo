import { useLingui } from "@lingui/react/macro";
import type { VaultKind, VaultPolicy } from "@rakazo/contracts";
import { hasVaultAccess, VaultPolicy as Policies } from "@rakazo/contracts";
import { ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import type { AgentAccess } from "../integrations/agent-access";
import { AgentAccessControl } from "../integrations/agent-access";

/**
 * The owner's bots in this Space, which an item can be limited to; undefined until loaded, null
 * if they can't be read. An archived bot the item is limited to is named so, as restoring it
 * brings the choice back.
 */
export function useVaultBots(enabled: boolean, chosen: string[] = []) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const { data, isError } = useQuery({ ...queries.bots.list.queryOptions(), enabled });
  if (isError && !data) return null;
  return data
    ?.filter((bot) => !bot.archivedAt || chosen.includes(bot.id))
    .map((bot) => (bot.archivedAt ? { ...bot, name: `${bot.name} · ${t`Archived`}` } : bot));
}

export function usePolicyLabels(): Record<VaultPolicy, string> {
  const { t } = useLingui();
  return { allow: t`Allow`, ask: t`Ask first`, off: t`Block` };
}

export function VaultItemAccess({
  kind,
  policy,
  access,
  note,
  disabled,
  onChange,
  onAccessChange,
}: {
  kind: VaultKind;
  policy: VaultPolicy;
  /** Which bots may use it; left out on a server that can't limit an item to chosen bots. */
  access?: AgentAccess;
  /** Said under the bots when only some may use it, or when this Space's can't be chosen. */
  note?: string;
  disabled?: boolean;
  onChange: (next: VaultPolicy) => void;
  onAccessChange: (next: AgentAccess) => void;
}) {
  const { t } = useLingui();
  const labels = usePolicyLabels();
  // As the item was saved, so an archived bot let go of stays in the list until saving.
  const [saved] = useState(() => (access && !access.allBots ? access.botIds : []));
  const bots = useVaultBots(Boolean(access), saved) ?? [];
  const policies = hasVaultAccess(kind);
  const picker = access && policy !== "off" && bots.length > 0;
  const noted = note && (!access || (!access.allBots && policy !== "off"));
  if (!policies && !picker && !noted) return null;
  // Bots chosen that this list doesn't show, such as archived ones, stay chosen.
  const shown = new Set(bots.map((bot) => bot.id));
  const choose = (next: AgentAccess) =>
    onAccessChange({
      allBots: next.allBots,
      botIds: [
        ...new Set([...next.botIds, ...(access?.botIds ?? []).filter((id) => !shown.has(id))]),
      ],
    });
  return (
    <div data-testid="vault-item-access" className="flex flex-wrap items-center gap-2">
      <span className="text-body-sm text-muted-foreground">{t`Bots`}</span>
      {policies ? (
        <ToggleGroup
          aria-label={t`Bots`}
          value={[policy]}
          onValueChange={([next]) => {
            const chosen = Policies.safeParse(next).data;
            if (chosen) onChange(chosen);
          }}
          disabled={disabled}
          spacing={1}
          className="rounded-lg bg-muted p-1"
        >
          {(["allow", "ask", "off"] as const)
            // Only a login asks first.
            .filter((option) => option !== "ask" || kind === "login" || policy === "ask")
            .map((option) => (
              <ToggleGroupItem
                key={option}
                value={option}
                className="h-7 px-3 text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
              >
                {labels[option]}
              </ToggleGroupItem>
            ))}
        </ToggleGroup>
      ) : null}
      {picker ? (
        <AgentAccessControl
          bots={bots}
          access={access}
          disabled={disabled}
          withOneBot
          onChange={choose}
        />
      ) : null}
      {noted ? <p className="w-full text-body-sm text-muted-foreground">{note}</p> : null}
    </div>
  );
}
