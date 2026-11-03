import { Eye, EyeOff, RefreshCw, X } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import type { ConfigField, InputCheckboxField, InputSelectField, InputTagsField } from "@/api/types";
import { Callout, Mono } from "@/components/common";
import { SafeHtml } from "@/components/safe-html";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox, Switch } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import {
  addTags,
  infoHeading,
  isSecretField,
  isSiteLinkField,
  isSpacer,
  parseTags,
  removeTag,
  splitTags,
  toggleValue,
  type FieldValue,
} from "./fields";

type AnyField = ConfigField | { id: string; name: string; type: string; [k: string]: unknown };

export interface ConfigFieldControlProps {
  field: AnyField;
  /** Unique DOM id for the input. */
  inputId: string;
  value: FieldValue;
  onChange: (value: FieldValue) => void;
  disabled?: boolean;
  /** For `displayimage`: re-fetch the config to get a new captcha. */
  onRefreshCaptcha?: () => void;
  refreshing?: boolean;
}

const str = (v: FieldValue): string => (typeof v === "string" ? v : "");

export function ConfigFieldControl(props: ConfigFieldControlProps) {
  const { field, inputId, value, onChange, disabled } = props;
  const f = field as ConfigField;

  switch (f.type) {
    case "hiddendata":
      return null;

    case "inputstring":
    case "password": {
      const secret = isSecretField(f);
      const site = isSiteLinkField(f);
      return (
        <div className="space-y-1.5">
          <Label htmlFor={inputId}>{f.name || f.id}</Label>
          {secret ? (
            <SecretInput id={inputId} value={str(value)} onChange={onChange} disabled={disabled} />
          ) : (
            <Input
              id={inputId}
              type={site ? "url" : "text"}
              inputMode={site ? "url" : undefined}
              value={str(value)}
              onChange={(e) => onChange(e.target.value)}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </div>
      );
    }

    case "inputbool":
      return (
        <div className="flex items-start justify-between gap-4 py-0.5">
          <Label htmlFor={inputId} className="pt-0.5 leading-snug">
            {f.name || f.id}
          </Label>
          <Switch id={inputId} checked={value === true} onCheckedChange={(c) => onChange(c)} disabled={disabled} />
        </div>
      );

    case "inputselect":
      return <SelectControl field={f} inputId={inputId} value={str(value)} onChange={onChange} disabled={disabled} />;

    case "inputcheckbox":
      return <CheckboxGroup field={f} inputId={inputId} value={value} onChange={onChange} disabled={disabled} />;

    case "inputtags":
      return <TagsInput field={f} inputId={inputId} value={str(value)} onChange={onChange} disabled={disabled} />;

    case "displayinfo": {
      if (isSpacer(f)) return null;
      const heading = infoHeading(f);
      return (
        <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2.5">
          {heading && <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{heading}</div>}
          <SafeHtml html={f.value} className="leading-relaxed" />
        </div>
      );
    }

    case "displayimage": {
      if (!f.value) return null;
      return (
        <div className="space-y-1.5">
          <div className="text-sm font-medium">{f.name || "Картинка"}</div>
          <div className="flex flex-wrap items-center gap-2">
            <img src={f.value} alt={f.name || "Капча"} className="max-h-24 max-w-full rounded border bg-white object-contain" />
            {props.onRefreshCaptcha && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={props.onRefreshCaptcha}
                disabled={disabled || props.refreshing}
              >
                <RefreshCw className={cn(props.refreshing && "animate-spin")} />
                Новая капча
              </Button>
            )}
          </div>
        </div>
      );
    }

    case "recaptcha":
      return (
        <Callout variant="warning" title="Нужна Google reCAPTCHA">
          Этот трекер требует reCAPTCHA, а новый интерфейс не умеет её проходить. Если трекер предлагает вход по cookie, используйте
          его.
        </Callout>
      );

    default: {
      const raw = (field as { value?: unknown }).value;
      return (
        <div className="space-y-1">
          <div className="text-sm font-medium">{field.name || field.id}</div>
          <Mono className="block break-all text-muted-foreground">
            {raw == null ? "—" : typeof raw === "string" ? raw : JSON.stringify(raw)}
          </Mono>
        </div>
      );
    }
  }
}

/* ── Secret input with reveal toggle ────────────────────────────────────── */

function SecretInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete="new-password"
        spellCheck={false}
        className="pr-10"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0.5 top-0.5 h-8 w-8 text-muted-foreground hover:text-foreground"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Скрыть" : "Показать"}
        aria-pressed={shown}
        aria-controls={id}
        disabled={disabled}
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

/* ── Select ─────────────────────────────────────────────────────────────── */

function SelectControl({
  field,
  inputId,
  value,
  onChange,
  disabled,
}: {
  field: InputSelectField;
  inputId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const options = Object.entries(field.options ?? {}).filter(([k]) => k !== "");
  const known = options.some(([k]) => k === value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{field.name || field.id}</Label>
      <Select value={known ? value : undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={inputId}>
          <SelectValue placeholder={value || "Не выбрано"} />
        </SelectTrigger>
        <SelectContent>
          {options.map(([k, label]) => (
            <SelectItem key={k} value={k}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ── Checkbox group ─────────────────────────────────────────────────────── */

function CheckboxGroup({
  field,
  inputId,
  value,
  onChange,
  disabled,
}: {
  field: InputCheckboxField;
  inputId: string;
  value: FieldValue;
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  const options = Object.entries(field.options ?? {});
  const selected = Array.isArray(value) ? value : [];
  const many = options.length > 6;
  const labelId = `${inputId}-label`;
  return (
    <fieldset className="space-y-2" aria-labelledby={labelId}>
      <legend id={labelId} className="text-sm font-medium">
        {field.name || field.id}
      </legend>
      <div
        className={cn(
          "grid gap-x-4 gap-y-2",
          many && "max-h-64 overflow-y-auto rounded-md border p-2 sm:grid-cols-2",
        )}
      >
        {options.map(([k, label], i) => {
          const id = `${inputId}-${i}`;
          return (
            <div key={k} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={selected.includes(k)}
                onCheckedChange={(c) => onChange(toggleValue(value, k, c === true))}
                disabled={disabled}
              />
              <Label htmlFor={id} className="font-normal leading-snug">
                {label}
              </Label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

/* ── Tags ───────────────────────────────────────────────────────────────── */

function TagsInput({
  field,
  inputId,
  value,
  onChange,
  disabled,
}: {
  field: InputTagsField;
  inputId: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();
  const tags = parseTags(value, field);

  const commit = () => {
    if (!text.trim()) return;
    const { valid, invalid } = splitTags(text, field);
    if (valid.length) onChange(addTags(value, valid, field));
    setText(invalid.join(" "));
    setError(invalid.length ? `Недопустимый тег: ${invalid.join(", ")}` : null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === (field.separator || ",")) {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !text && tags.length) {
      onChange(removeTag(value, tags[tags.length - 1] ?? "", field));
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId}>{field.name || field.id}</Label>
      <div
        className={cn(
          "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5 shadow-sm focus-within:ring-1 focus-within:ring-ring",
          disabled && "opacity-50",
        )}
      >
        {tags.map((t) => (
          <Badge key={t} variant="secondary" className="gap-1 pr-1">
            {t}
            <button
              type="button"
              className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onChange(removeTag(value, t, field))}
              aria-label={`Удалить тег ${t}`}
              disabled={disabled}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        <input
          id={inputId}
          className="min-w-[8rem] flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:text-sm"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={commit}
          disabled={disabled}
          placeholder={tags.length ? "" : "Добавить тег"}
          aria-describedby={hintId}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <p id={hintId} className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
        {error ?? "Enter или запятая — добавить тег."}
      </p>
    </div>
  );
}
