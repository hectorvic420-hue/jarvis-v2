import { Tool } from "../shared/types.js";

// ─── n8n REST helper ──────────────────────────────────────────────────────────

function n8nBase(): string {
  return process.env.N8N_BASE_URL || "http://localhost:5678";
}

function n8nHeaders(): Record<string, string> {
  const key = process.env.N8N_API_KEY;
  if (!key) throw new Error("N8N_API_KEY no configurado");
  return {
    "Content-Type": "application/json",
    "X-N8N-API-KEY": key,
  };
}

async function n8nGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = Object.keys(params).length
    ? "?" + new URLSearchParams(params).toString()
    : "";
  const res = await fetch(`${n8nBase()}/api/v1${path}${qs}`, {
    headers: n8nHeaders(),
  });
  if (!res.ok) throw new Error(`n8n error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function n8nPost(path: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${n8nBase()}/api/v1${path}`, {
    method: "POST",
    headers: n8nHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`n8n error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function n8nPatch(path: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${n8nBase()}/api/v1${path}`, {
    method: "PATCH",
    headers: n8nHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`n8n error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function n8nPut(path: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${n8nBase()}/api/v1${path}`, {
    method: "PUT",
    headers: n8nHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`n8n error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function n8nDelete(path: string): Promise<any> {
  const res = await fetch(`${n8nBase()}/api/v1${path}`, {
    method: "DELETE",
    headers: n8nHeaders(),
  });
  if (!res.ok) throw new Error(`n8n error ${res.status}: ${await res.text()}`);
  // DELETE puede retornar 204 sin body
  const text = await res.text();
  return text ? JSON.parse(text) : { success: true };
}

// ─── Status label helper ──────────────────────────────────────────────────────

function statusEmoji(active: boolean): string {
  return active ? "🟢" : "🔴";
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function listWorkflows(active?: boolean): Promise<string> {
  const params: Record<string, string> = { limit: "50" };
  if (typeof active === "boolean") params.active = active.toString();

  const data = await n8nGet("/workflows", params);
  const workflows = data.data || [];

  if (!workflows.length) return "📋 Sin workflows encontrados.";

  const lines = [`📋 *Workflows (${workflows.length})*`];
  for (const w of workflows) {
    const updated = new Date(w.updatedAt).toLocaleString("es-CO", {
      timeZone: "America/Bogota",
    });
    lines.push(
      `${statusEmoji(w.active)} ${w.name}\n  ID: ${w.id} | Actualizado: ${updated}`
    );
  }
  return lines.join("\n");
}

async function getWorkflow(workflowId: string): Promise<string> {
  const w = await n8nGet(`/workflows/${workflowId}`);

  const nodeNames = w.nodes?.map((n: any) => n.name).join(", ") || "Sin nodos";
  const connections = Object.keys(w.connections || {}).length;
  const tags = w.tags?.map((t: any) => t.name).join(", ") || "Sin tags";
  const updated = new Date(w.updatedAt).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
  });

  return [
    `🔧 *Workflow: ${w.name}*`,
    `ID: ${w.id}`,
    `Estado: ${statusEmoji(w.active)} ${w.active ? "Activo" : "Inactivo"}`,
    `Nodos (${w.nodes?.length || 0}): ${nodeNames}`,
    `Conexiones: ${connections}`,
    `Tags: ${tags}`,
    `Última actualización: ${updated}`,
  ].join("\n");
}

async function createWorkflow(
  name: string,
  nodes: unknown[] = [],
  connections: unknown = {}
): Promise<string> {
  const payload = {
    name,
    nodes,
    connections,
    settings: {},
    staticData: {},
  };

  console.log(`[N8N] Payload de creación para "${name}":`, JSON.stringify(payload));

  const w = await n8nPost("/workflows", payload);
  return `✅ Workflow creado | ID: ${w.id} | Nodos: ${nodes.length}`;
}

async function updateWorkflow(
  workflowId: string,
  updates: Record<string, unknown>
): Promise<string> {
  const current = await n8nGet(`/workflows/${workflowId}`);
  const updated = await n8nPut(`/workflows/${workflowId}`, {
    ...current,
    ...updates,
  });
  return `✅ Workflow actualizado\nID: ${updated.id}\nNombre: ${updated.name}`;
}

async function activateWorkflow(workflowId: string): Promise<string> {
  await n8nPatch(`/workflows/${workflowId}/activate`);
  return `▶️ Workflow activado: ${workflowId}`;
}

async function deactivateWorkflow(workflowId: string): Promise<string> {
  await n8nPatch(`/workflows/${workflowId}/deactivate`);
  return `⏸ Workflow desactivado: ${workflowId}`;
}

async function executeWorkflow(
  workflowId: string,
  inputData?: Record<string, unknown>
): Promise<string> {
  const body = inputData ? { runData: inputData } : {};
  const exec = await n8nPost(`/workflows/${workflowId}/run`, body);

  const executionId = exec.data?.executionId || exec.executionId || "desconocido";

  return [
    `🚀 *Workflow ejecutado*`,
    `Workflow ID: ${workflowId}`,
    `Execution ID: ${executionId}`,
    `Estado: ${exec.data?.status || "running"}`,
  ].join("\n");
}

async function deleteWorkflow(workflowId: string): Promise<string> {
  await n8nDelete(`/workflows/${workflowId}`);
  return `🗑️ Workflow eliminado: ${workflowId}`;
}

async function listExecutions(workflowId?: string, limit = 10): Promise<string> {
  const params: Record<string, string> = { limit: limit.toString() };
  if (workflowId) params.workflowId = workflowId;

  const data = await n8nGet("/executions", params);
  const executions = data.data || [];

  if (!executions.length) return "📜 Sin ejecuciones recientes.";

  const lines = [`📜 *Últimas ${executions.length} ejecuciones*`];
  for (const e of executions) {
    const started = new Date(e.startedAt).toLocaleString("es-CO", {
      timeZone: "America/Bogota",
    });
    const duration = e.stoppedAt
      ? `${Math.round(
          (new Date(e.stoppedAt).getTime() - new Date(e.startedAt).getTime()) / 1000
        )}s`
      : "En curso";
    const statusIcon = e.status === "success" ? "✅" : e.status === "error" ? "❌" : "⏳";
    lines.push(
      `${statusIcon} ID: ${e.id} | WF: ${e.workflowId || "?"} | ${started} | ${duration}`
    );
  }
  return lines.join("\n");
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const n8nManagerTool: Tool = {
  name: "n8n_manager",
  description:
    "Gestiona workflows de n8n: listar, obtener detalle, crear, actualizar, activar, desactivar, ejecutar, eliminar workflows y consultar historial de ejecuciones.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "get",
          "create",
          "update",
          "activate",
          "deactivate",
          "execute",
          "delete",
          "executions",
        ],
        description: "Acción a ejecutar",
      },
      workflow_id: {
        type: "string",
        description: "ID del workflow",
      },
      name: {
        type: "string",
        description: "Nombre del workflow (para crear)",
      },
      nodes: {
        type: "array",
        description: "Array de nodos para crear workflow",
      },
      connections: {
        type: "object",
        description: "Mapa de conexiones entre nodos",
      },
      updates: {
        type: "object",
        description: "Campos a actualizar en el workflow",
      },
      input_data: {
        type: "object",
        description: "Datos de entrada para la ejecución",
      },
      active_filter: {
        type: "boolean",
        description: "Filtrar workflows por estado activo/inactivo",
      },
      limit: {
        type: "number",
        description: "Límite de resultados",
      },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const {
      action,
      workflow_id,
      name,
      nodes,
      connections,
      updates,
      input_data,
      active_filter,
      limit,
    } = params as any;

    switch (action) {
      case "list":
        return listWorkflows(active_filter);

      case "get":
        if (!workflow_id) return "❌ Falta parámetro: workflow_id";
        return getWorkflow(workflow_id);

      case "create":
        if (!name) return "❌ Falta parámetro: name";
        return createWorkflow(name, nodes, connections);

      case "update":
        if (!workflow_id || !updates)
          return "❌ Faltan parámetros: workflow_id, updates";
        return updateWorkflow(workflow_id, updates);

      case "activate":
        if (!workflow_id) return "❌ Falta parámetro: workflow_id";
        return activateWorkflow(workflow_id);

      case "deactivate":
        if (!workflow_id) return "❌ Falta parámetro: workflow_id";
        return deactivateWorkflow(workflow_id);

      case "execute":
        if (!workflow_id) return "❌ Falta parámetro: workflow_id";
        return executeWorkflow(workflow_id, input_data);

      case "delete":
        if (!workflow_id) return "❌ Falta parámetro: workflow_id";
        return deleteWorkflow(workflow_id);

      case "executions":
        return listExecutions(workflow_id, limit || 10);

      default:
        return `❌ Acción desconocida: ${action}`;
    }
  },
};
