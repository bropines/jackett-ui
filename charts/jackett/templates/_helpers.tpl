{{- define "jackett.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "jackett.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "jackett.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "jackett.uiImage" -}}
{{- printf "%s:%s" .Values.ui.image.repository (default "latest" .Values.ui.image.tag) -}}
{{- end -}}

{{/* yq expression that sets the configured ServerConfig.json keys (null values are skipped). */}}
{{- define "jackett.settingsExpr" -}}
{{- $s := .Values.jackett.settings -}}
{{- $e := list -}}
{{- if not (kindIs "invalid" $s.baseUrlOverride) }}{{ $e = append $e (printf ".BaseUrlOverride = %s" ($s.baseUrlOverride | toJson)) }}{{ end -}}
{{- if not (kindIs "invalid" $s.updateDisabled) }}{{ $e = append $e (printf ".UpdateDisabled = %t" $s.updateDisabled) }}{{ end -}}
{{- if not (kindIs "invalid" $s.flaresolverrUrl) }}{{ $e = append $e (printf ".FlareSolverrUrl = %s" ($s.flaresolverrUrl | toJson)) }}{{ end -}}
{{- with $s.proxy -}}
{{- if not (kindIs "invalid" .type) }}{{ $e = append $e (printf ".ProxyType = %d" (int .type)) }}{{ end -}}
{{- if not (kindIs "invalid" .url) }}{{ $e = append $e (printf ".ProxyUrl = %s" (.url | toJson)) }}{{ end -}}
{{- if not (kindIs "invalid" .port) }}{{ $e = append $e (printf ".ProxyPort = %d" (int .port)) }}{{ end -}}
{{- if not (kindIs "invalid" .username) }}{{ $e = append $e (printf ".ProxyUsername = %s" (.username | toJson)) }}{{ end -}}
{{- if not (kindIs "invalid" .password) }}{{ $e = append $e (printf ".ProxyPassword = %s" (.password | toJson)) }}{{ end -}}
{{- end -}}
{{- join " | " $e -}}
{{- end -}}
