{{/* Chart name, overridable. */}}
{{- define "pi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Release-qualified base name for every resource. */}}
{{- define "pi.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "pi.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "pi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels for one component. Call as (dict "ctx" $ "component" "agent"). */}}
{{- define "pi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pi.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Fully qualified image reference. */}}
{{- define "pi.image" -}}
{{- $registry := .ctx.Values.image.registry -}}
{{- $tag := default .ctx.Chart.AppVersion .image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .image.repository $tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "pi.secretName" -}}
{{- default (printf "%s-secrets" (include "pi.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "pi.configName" -}}
{{- printf "%s-config" (include "pi.fullname" .) -}}
{{- end -}}

{{/* Service names. The Sandbox has two: a headless one for per-pod DNS
     (how the Agent reaches a specific replica) and a ClusterIP one used only
     for discovery, which is the single route any replica may answer. */}}
{{- define "pi.sandboxHeadless" -}}
{{- printf "%s-sandbox-headless" (include "pi.fullname" .) -}}
{{- end -}}

{{- define "pi.sandboxService" -}}
{{- printf "%s-sandbox" (include "pi.fullname" .) -}}
{{- end -}}

{{- define "pi.agentService" -}}
{{- printf "%s-agent" (include "pi.fullname" .) -}}
{{- end -}}

{{- define "pi.apiService" -}}
{{- printf "%s-api" (include "pi.fullname" .) -}}
{{- end -}}

{{- define "pi.frontendService" -}}
{{- printf "%s-frontend" (include "pi.fullname" .) -}}
{{- end -}}

{{- define "pi.mcpService" -}}
{{- printf "%s-sandbox-mcp" (include "pi.fullname" .) -}}
{{- end -}}

{{/* Secret key references shared by Agent, worker, migration job and Sandbox. */}}
{{- define "pi.mysqlEnv" -}}
- name: MYSQL_USER
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: mysql-user }
- name: MYSQL_PASSWORD
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: mysql-password }
{{- end -}}

{{/* Common pod-level scheduling knobs. */}}
{{- define "pi.podPlacement" -}}
{{- with .Values.nodeSelector }}
nodeSelector: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity: {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .Values.image.pullSecrets }}
imagePullSecrets: {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* Secret-derived env shared by the Agent HTTP pod, the worker, and the
     migration job. Kept in one place so a rotated key cannot reach some
     processes but not others. */}}
{{- define "pi.agentSecretEnv" -}}
- name: MYSQL_URL
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: mysql-url }
- name: REDIS_URL
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: redis-url }
- name: LLMIO_API_KEY
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: llm-api-key }
- name: LLMIO_BASE_URL
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: llm-base-url }
- name: SANDBOX_INTERNAL_HMAC_KEYRING
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: internal-hmac-keyring }
- name: SANDBOX_INTERNAL_HMAC_ACTIVE_KID
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: internal-hmac-active-kid }
- name: AGENT_INTERNAL_TOKEN
  valueFrom:
    secretKeyRef: { name: {{ include "pi.secretName" . }}, key: agent-internal-token }
{{- end -}}
