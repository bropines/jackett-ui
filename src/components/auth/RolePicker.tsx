import { ROLES, type Role } from "@/api";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/misc";
import { ROLE_HINTS, ROLE_LABELS } from "@/lib/auth";

/** Role choice with a one-line description of each role. */
export function RolePicker({ id, value, onChange, disabled }: { id: string; value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <RadioGroup value={value} onValueChange={(v) => onChange(v as Role)} disabled={disabled} aria-label="Роль">
      {ROLES.map((r) => (
        <div key={r} className="flex items-start gap-2.5">
          <RadioGroupItem value={r} id={`${id}-${r}`} className="mt-0.5" />
          <Label htmlFor={`${id}-${r}`} className="min-w-0 cursor-pointer space-y-0.5 font-normal">
            <span className="font-medium">{ROLE_LABELS[r]}</span>
            <span className="block text-xs text-muted-foreground">{ROLE_HINTS[r]}</span>
          </Label>
        </div>
      ))}
    </RadioGroup>
  );
}
