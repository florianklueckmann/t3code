import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import {
  BOT_COLOR_OPTIONS,
  BOT_COLOR_PALETTE,
  BOT_FACE_OPTIONS,
  BOT_TOPPER_OPTIONS,
  defaultBotAppearance,
} from "@t3tools/client-runtime/bot-appearance";
import type { BotAppearance } from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { BotAvatar } from "../BotAvatar";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

const TILE_RADIO_CLASSNAME =
  "grid size-10 cursor-pointer place-items-center rounded-lg border border-transparent outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:border-foreground/64 data-checked:bg-accent data-disabled:cursor-default data-disabled:opacity-64";

/**
 * The Bot's avatar, which opens its appearance choices. `appearance` is the draft: null keeps
 * the default look derived from `botId`.
 */
export function BotAppearancePicker({
  botId,
  appearance,
  supported,
  environmentLabel,
  disabled,
  onChange,
}: {
  readonly botId: string;
  readonly appearance: BotAppearance | null;
  /** False on servers that cannot store an appearance; the picker then only explains why. */
  readonly supported: boolean;
  readonly environmentLabel: string;
  readonly disabled: boolean;
  readonly onChange: (appearance: BotAppearance | null) => void;
}) {
  const shown = appearance ?? defaultBotAppearance(botId);
  const set = (patch: Partial<BotAppearance>) => onChange({ ...shown, ...patch });
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Change appearance"
            className="relative grid size-14 shrink-0 cursor-pointer place-items-center rounded-xl border bg-muted/40 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:opacity-64"
          />
        }
      >
        <BotAvatar appearance={shown} size={44} />
        <span className="absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground">
          <PencilIcon className="size-2.5" aria-hidden />
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <div className="space-y-3">
          <div className="flex min-h-6 items-center justify-between gap-2">
            <PopoverTitle>Appearance</PopoverTitle>
            {supported ? (
              // Stays enabled at the default: disabling the focused button would drop focus out
              // of the popover, and the next Escape would close the whole editor.
              <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onChange(null)}>
                Reset
              </Button>
            ) : null}
          </div>
          {supported ? (
            <>
              <OptionGroup
                label="Color"
                value={shown.color}
                options={BOT_COLOR_OPTIONS}
                disabled={disabled}
                onValueChange={(color) => set({ color })}
                renderOption={(option) => (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    aria-label={option.label}
                    className="grid size-7 cursor-pointer place-items-center rounded-full border border-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:border-foreground/64 data-disabled:cursor-default data-disabled:opacity-64"
                  >
                    <span
                      className="size-5 rounded-full border border-black/10"
                      style={{ backgroundColor: BOT_COLOR_PALETTE[option.value].body }}
                    />
                  </RadioPrimitive.Root>
                )}
              />
              <OptionGroup
                label="Face"
                value={shown.face}
                options={BOT_FACE_OPTIONS}
                disabled={disabled}
                onValueChange={(face) => set({ face })}
                renderOption={(option) => (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    aria-label={option.label}
                    className={TILE_RADIO_CLASSNAME}
                  >
                    <BotAvatar
                      appearance={{ ...shown, face: option.value, topper: "none" }}
                      size={28}
                    />
                  </RadioPrimitive.Root>
                )}
              />
              <OptionGroup
                label="Topper"
                value={shown.topper}
                options={BOT_TOPPER_OPTIONS}
                disabled={disabled}
                onValueChange={(topper) => set({ topper })}
                renderOption={(option) => (
                  <RadioPrimitive.Root
                    key={option.value}
                    value={option.value}
                    aria-label={option.label}
                    className={TILE_RADIO_CLASSNAME}
                  >
                    <BotAvatar appearance={{ ...shown, topper: option.value }} size={28} />
                  </RadioPrimitive.Root>
                )}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Update T3 Code on {environmentLabel} to change how this Bot looks.
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function OptionGroup<T extends string>({
  label,
  value,
  options,
  disabled,
  onValueChange,
  renderOption,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly disabled: boolean;
  readonly onValueChange: (value: T) => void;
  readonly renderOption: (option: { readonly value: T; readonly label: string }) => ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="space-y-1.5">
      <div id={labelId} className="text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <RadioGroupPrimitive
        aria-labelledby={labelId}
        className="flex flex-wrap gap-1"
        disabled={disabled}
        value={value}
        onValueChange={(next) => {
          const option = options.find((entry) => entry.value === next);
          if (option) onValueChange(option.value);
        }}
      >
        {options.map(renderOption)}
      </RadioGroupPrimitive>
    </div>
  );
}
