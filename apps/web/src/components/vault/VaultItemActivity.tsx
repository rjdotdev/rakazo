import { Trans } from "@lingui/react/macro";
import type { SettingsScope } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSpaceQueries } from "../../lib/query";
import { formatRelativeTime } from "../../lib/relative-time";
import { siteHost } from "./kinds";

export function VaultItemActivity({ scope, name }: { scope: SettingsScope; name: string }) {
  const queries = useSpaceQueries();
  const { data: uses } = useQuery(queries.vault.activity.queryOptions({ input: { scope, name } }));
  const [open, setOpen] = useState(false);
  const latest = uses?.[0];
  if (!latest) return null;
  const when = formatRelativeTime(latest.at);
  const bot = latest.botName;
  return (
    <div data-testid="vault-item-activity" className="flex flex-col gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className="self-start px-0 text-body-sm text-muted-foreground hover:bg-transparent"
        onClick={() => setOpen(!open)}
      >
        <Trans>
          Used {when} by {bot}
        </Trans>
      </Button>
      {open ? (
        <ul className="overflow-hidden rounded-xl bg-muted/50">
          {(uses ?? []).map((use, index) => (
            <li
              key={`${use.at}-${index}`}
              data-testid="vault-item-use"
              className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-body-sm first:border-t-0"
            >
              <span className="min-w-0 flex-1 truncate">
                {use.botName}
                {use.chat && use.chat.title !== use.botName ? (
                  <span className="text-muted-foreground"> · {use.chat.title}</span>
                ) : null}
              </span>
              {use.site ? (
                <span className="truncate text-muted-foreground">{siteHost(use.site)}</span>
              ) : null}
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatRelativeTime(use.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
