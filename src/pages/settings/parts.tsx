import { Eye, EyeOff, Loader2, RotateCcw, Save } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

export function Section({
  id,
  title,
  description,
  icon: Icon,
  children,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <Card id={id} aria-labelledby={`${id}-title`} role="region">
      <CardHeader className="p-4 md:p-6">
        <CardTitle id={`${id}-title`} className="flex items-center gap-2 text-base">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0 md:p-6 md:pt-0">{children}</CardContent>
    </Card>
  );
}

/** Text input with a show/hide toggle for secrets. */
export function SecretInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  autoComplete = "off",
  invalid,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoComplete?: string;
  invalid?: boolean;
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
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        className="pr-10"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0.5 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground"
        onClick={() => setShown(!shown)}
        disabled={disabled}
        aria-label={shown ? "Скрыть" : "Показать"}
        aria-controls={id}
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

export function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className={cn("cursor-pointer", disabled && "cursor-not-allowed opacity-70")}>
          {label}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

/** Save / reset row at the bottom of a settings card that saves on its own. */
export function SectionFooter({
  dirty,
  invalid,
  saving,
  error,
  onReset,
}: {
  dirty: boolean;
  invalid: boolean;
  saving: boolean;
  error?: string;
  onReset: () => void;
}) {
  return (
    <div className="space-y-3 border-t pt-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Не удалось сохранить: {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {dirty && (
          <span className={cn("mr-auto text-xs", invalid ? "text-destructive" : "text-muted-foreground")}>
            {invalid ? "Исправьте ошибки" : "Есть несохранённые изменения"}
          </span>
        )}
        {dirty && (
          <Button type="button" variant="ghost" size="sm" onClick={onReset} disabled={saving}>
            <RotateCcw /> Сбросить
          </Button>
        )}
        <Button type="submit" size="sm" disabled={!dirty || invalid || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />} Сохранить
        </Button>
      </div>
    </div>
  );
}
