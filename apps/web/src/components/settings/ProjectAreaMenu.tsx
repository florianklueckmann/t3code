import { ChevronDownIcon, PlusIcon, TagIcon } from "lucide-react";

import type { ProjectAreaChoice } from "../../projectAreas";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

const NO_AREA_VALUE = "\u0000no-area";

export function ProjectAreaMenu({
  areas,
  current,
  disabled,
  onChoose,
}: {
  readonly areas: readonly string[];
  readonly current: readonly string[];
  readonly disabled: boolean;
  readonly onChoose: (choice: ProjectAreaChoice) => void;
}) {
  const label = current.length === 0 ? "No area" : current.join(", ");
  // Checkouts that disagree on their area check no row until one is picked.
  const value = current.length === 0 ? NO_AREA_VALUE : current.length === 1 ? current[0] : null;
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Project area: ${label}`}
        disabled={disabled}
        render={<Button variant="outline" size="sm" />}
        className="min-w-0 max-w-56"
      >
        <TagIcon aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          aria-hidden
          strokeWidth={1.75}
          className="-me-0.5 size-3.5 shrink-0 text-muted-foreground opacity-70"
        />
      </MenuTrigger>
      <MenuPopup align="end">
        <div className="w-56 max-w-full">
          <MenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (next === NO_AREA_VALUE) onChoose({ kind: "clear" });
              else if (typeof next === "string") onChoose({ kind: "set", area: next });
            }}
          >
            {areas.map((area) => (
              <MenuRadioItem key={area} value={area} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{area}</span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
            <MenuRadioItem value={NO_AREA_VALUE} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">No area</span>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem onClick={() => onChoose({ kind: "new" })}>
            <PlusIcon aria-hidden />
            New area…
          </MenuItem>
        </div>
      </MenuPopup>
    </Menu>
  );
}
