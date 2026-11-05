import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ApiError, errText, qk, serverApi, type UiSettings } from "@/api";
import {
  buildPatch,
  errorPath,
  hasAuthErrors,
  isEmptyPatch,
  toAuthForm,
  validateAuthForm,
  type AuthErrors,
  type AuthForm,
  type FieldPath,
} from "@/pages/settings/auth/logic";
import { inSection, sectionErrors } from "@/pages/settings/sections";

/**
 * Form state for one settings card that saves on its own. The card edits only its fields,
 * so `buildPatch` against the settings the form was built from sends only those.
 * Errors (client and server) outside `paths` go to `generalError`.
 */
export function useSettingsSection(settings: UiSettings, paths: readonly FieldPath[]) {
  const qc = useQueryClient();
  const [base, setBase] = useState(settings);
  const [form, setForm] = useState<AuthForm>(() => toAuthForm(settings));
  const [serverErrors, setServerErrors] = useState<AuthErrors>({});
  const [generalError, setGeneralError] = useState("");
  const [saving, setSaving] = useState(false);

  const patch = useMemo(() => buildPatch(form, base), [form, base]);
  const dirty = !isEmptyPatch(patch);

  // New server data (e.g. another card saved): take it unless this card has unsaved edits.
  useEffect(() => {
    if (settings !== base && !dirty) {
      setBase(settings);
      setForm(toAuthForm(settings));
    }
    // Only react to new server data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const clientErrors = useMemo(() => sectionErrors(validateAuthForm(form, base, {}), paths), [form, base, paths]);
  const errors: AuthErrors = { ...clientErrors, ...serverErrors };
  const invalid = hasAuthErrors(clientErrors);

  const set = <K extends keyof AuthForm>(k: K, v: AuthForm[K], path?: FieldPath) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (path && serverErrors[path]) setServerErrors(({ [path]: _drop, ...rest }) => rest);
  };

  const reset = () => {
    setForm(toAuthForm(base));
    setServerErrors({});
    setGeneralError("");
  };

  const save = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    setServerErrors({});
    setGeneralError("");
    try {
      await serverApi.putSettings(patch);
      const fresh = await qc.fetchQuery({ queryKey: qk.uiSettings, queryFn: () => serverApi.getSettings(), staleTime: 0 });
      setBase(fresh);
      setForm(toAuthForm(fresh));
      toast.success("Сохранено");
      void qc.invalidateQueries({ queryKey: qk.authState });
    } catch (e) {
      const path = e instanceof ApiError ? errorPath(e.field) : undefined;
      if (path && inSection(path, paths)) setServerErrors({ [path]: errText(e) });
      else setGeneralError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return { base, form, set, errors, invalid, dirty, saving, generalError, reset, save };
}
