import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ApiError, errText, qk, serverApi, type ProviderId, type UiSettings } from "@/api";
import { Callout } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  buildPatch,
  errorPath,
  hasAuthErrors,
  isEmptyPatch,
  providerFields,
  providerVerified,
  toAuthForm,
  validateAuthForm,
  verifyKey,
  type AuthErrors,
  type AuthForm,
  type ProviderForm,
  type TestedKeys,
} from "@/pages/settings/auth/logic";
import { ProviderSection } from "@/pages/settings/auth/ProviderSection";
import { useProviderTests } from "@/pages/settings/auth/useProviderTests";
import { providerErrors } from "@/pages/welcome/logic";

const TITLES: Record<ProviderId, string> = { oidc: "OpenID Connect", google: "Google", github: "GitHub" };

/**
 * The provider form from Settings → Панель in a dialog: redirect URL, client id / secret,
 * test login. Saves only this provider's fields. Mount it only while open (state resets).
 */
export function ProviderSetupDialog({ id, settings, onClose }: { id: ProviderId; settings: UiSettings; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<AuthForm>(() => toAuthForm(settings));
  const [tested, setTested] = useState<TestedKeys>({});
  const tests = useProviderTests((pid, key) => setTested((t) => ({ ...t, [pid]: key })));
  const [serverErrors, setServerErrors] = useState<AuthErrors>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Only this provider changes; other fields keep the stored values.
  const patch = useMemo(() => buildPatch(form, settings), [form, settings]);
  const dirty = !isEmptyPatch(patch);
  const clientErrors = providerErrors(validateAuthForm(form, settings, tested), id);
  const errors: AuthErrors = { ...clientErrors, ...serverErrors };
  const invalid = hasAuthErrors(clientErrors);

  const setProvider = (p: Partial<ProviderForm>) => {
    setForm((f) => ({ ...f, providers: { ...f.providers, [id]: { ...f.providers[id], ...p } } }));
    setServerErrors({});
  };

  const save = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    setError("");
    try {
      await serverApi.putSettings(patch);
      await qc.invalidateQueries({ queryKey: qk.uiSettings });
      void qc.invalidateQueries({ queryKey: qk.authState });
      toast.success("Сохранено");
      onClose();
    } catch (e) {
      const path = e instanceof ApiError ? errorPath(e.field) : undefined;
      if (path?.startsWith(`auth.providers.${id}.`)) setServerErrors({ [path]: errText(e) });
      else setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Настроить {TITLES[id]}</DialogTitle>
          <DialogDescription>Проверьте вход и сохраните. Включить вход можно после проверки.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <ProviderSection
            id={id}
            form={form.providers[id]}
            settings={settings}
            errors={errors}
            verified={providerVerified(form, settings, id, tested)}
            test={tests.get(id)}
            onChange={setProvider}
            onTest={() => void tests.start(id, providerFields(form, id), verifyKey(form, id))}
            onCancelTest={() => tests.cancel(id)}
          />
          {error && (
            <Callout variant="error" title="Не удалось сохранить">
              {error}
            </Callout>
          )}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {dirty ? "Отмена" : "Закрыть"}
            </Button>
            <Button type="submit" disabled={!dirty || invalid || saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />} Сохранить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
