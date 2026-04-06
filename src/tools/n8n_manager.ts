import { Tool } from "../shared/types.js";
import { v4 as uuidv4 } from "uuid";

const FETCH_TIMEOUT = 30000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function n8nBase(): string {
  const base = process.env.N8N_BASE_URL;
  if (!base) throw new Error("N8N_BASE_URL debe estar configurado en .env");
  return base.replace(/\/$/, "");
}

function n8nHeaders(): Record<string, string> {
  const key = process.env.N8N_API_KEY;
  if (!key) throw new Error("N8N_API_KEY no configurado");
  return {
    "Content-Type": "application/json",
    "X-N8N-API-KEY": key,
  };
}

async function apiReq(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetchWithTimeout(`${n8nBase()}/api/v1${path}`, {
    method,
    headers: n8nHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n ${res.status}: ${text}`);
  }
  const text = await res.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

const get  = (path: string, params?: Record<string,string>) => {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return apiReq(`${path}${qs}`, "GET");
};
const post  = (path: string, body?: unknown) => apiReq(path, "POST", body);
const patch = (path: string, body?: unknown) => apiReq(path, "PATCH", body);
const del   = (path: string) => apiReq(path, "DELETE");

function emoji(active: boolean) { return active ? "🟢" : "🔴"; }

function mapNodeType(rawType: string): string {
  const t = rawType.toLowerCase();
  if (t.includes("webhook")) return "n8n-nodes-base.webhook";
  if (t.includes("httprequest") || t.includes("http")) return "n8n-nodes-base.httpRequest";
  if (t.includes("functionitem") || t.includes("fnitem")) return "n8n-nodes-base.itemLists";
  if (t.includes("setnode") || t.includes("set ") || t.includes("set:")) return "n8n-nodes-base.set";
  if (t.includes("if") || t.includes("condition")) return "n8n-nodes-base.if";
  if (t.includes("switch")) return "n8n-nodes-base.switch";
  if (t.includes("code")) return "n8n-nodes-base.code";
  if (t.includes("respond")) return "n8n-nodes-base.respondToWebhook";
  if (t.includes("schedule") || t.includes("cron")) return "n8n-nodes-base.scheduleTrigger";
  if (t.includes("whatsapp")) return "n8n-nodes-base.whatsApp";
  if (t.includes("telegram")) return "n8n-nodes-base.telegram";
  if (t.includes("gmail")) return "n8n-nodes-base.gmail";
  if (t.includes("slack")) return "n8n-nodes-base.slack";
  if (t.includes("spreadsheet") || t.includes("googleSheets")) return "n8n-nodes-base.googleSheets";
  if (t.includes("mysql") || t.includes("postgres") || t.includes("postgresql")) return "n8n-nodes-base.postgres";
  if (t.includes("mongodb")) return "n8n-nodes-base.mongoDb";
  if (t.includes("http")) return "n8n-nodes-base.httpRequest";
  if (t.includes("wait")) return "n8n-nodes-base.wait";
  if (t.includes("split") || t.includes("splits")) return "n8n-nodes-base.splitInBatches";
  if (t.includes("merge")) return "n8n-nodes-base.merge";
  if (t.includes("remove")) return "n8n-nodes-base.removeDuplicates";
  if (t.includes("noOp") || t.includes("noop")) return "n8n-nodes-base.noOp";
  return rawType;
}

function validateNode(node: any): { valid: boolean; error?: string } {
  if (!node || typeof node !== "object") return { valid: false, error: "Nodo no es un objeto" };
  if (!node.name && !node.name) return { valid: false, error: "Nodo sin nombre" };
  if (!node.type) return { valid: false, error: `Nodo "${node.name || "sin nombre"}" no tiene 'type'` };
  if (!node.id && !node.id) return { valid: true };
  return { valid: true };
}

function buildConnections(nodes: any[]): Record<string, any> {
  const connections: Record<string, any> = {};
  for (let i = 0; i < nodes.length; i++) {
    const current = nodes[i];
    if (i < nodes.length - 1) {
      const next = nodes[i + 1];
      connections[current.name] = {
        main: [[{ node: next.name, type: "main", index: 0 }]],
      };
    }
  }
  return connections;
}

async function listWorkflows(): Promise<string> {
  const data = await get("/workflows", { limit: "100" });
  const wfs: any[] = data.data || [];
  if (!wfs.length) return "📋 Sin workflows en n8n.";

  const lines = [`📋 *Workflows en n8n (${wfs.length})*`];
  for (const w of wfs) {
    const updated = new Date(w.updatedAt).toLocaleString("es-CO", { timeZone: "America/Bogota" });
    lines.push(`${emoji(w.active)} ${w.name}\n   ID: \`${w.id}\` | ${updated}`);
  }
  return lines.join("\n");
}

async function getWorkflow(workflowId: string): Promise<string> {
  const w: any = await get(`/workflows/${workflowId}`);
  if (w.message === "not found" || !w.id) return `❌ Workflow \`${workflowId}\` no encontrado.`;

  const nodes: any[] = w.nodes || [];
  const conns: any = w.connections || {};

  const nodeLines = nodes.map((n: any, idx: number) => {
    const outputs: string[] = [];
    for (const [outputName, outputsArr] of Object.entries(conns[n.name] || {})) {
      for (const arr of (outputsArr as any[])) {
        for (const c of arr) outputs.push(c.node);
      }
    }
    const connected = outputs.length ? outputs.join(", ") : "sin salida";
    const type = n.type || "desconocido";
    const params = JSON.stringify(n.parameters || {}).slice(0, 80);
    return `  ${idx + 1}. \`${n.name}\`\n     Tipo: \`${type}\`\n     → ${connected}\n     Params: ${params}...`;
  });

  return [
    `🔧 *${w.name}*`,
    `ID: \`${w.id}\` | ${emoji(w.active)} ${w.active ? "Activo" : "Inactivo"}`,
    `Nodos: ${nodes.length}`,
    `Tags: ${(w.tags || []).map((t: any) => t.name).join(", ") || "ninguno"}`,
    `Actualizado: ${new Date(w.updatedAt).toLocaleString("es-CO", { timeZone: "America/Bogota" })}`,
    nodes.length ? `\n*Nodos:*\n${nodeLines.join("\n")}` : "\n⚠️ Sin nodos",
  ].filter(Boolean).join("\n");
}

async function createWorkflow(name: string, nodes?: any[], connections?: any): Promise<string> {
  if (!nodes || nodes.length === 0) {
    const w: any = await post("/workflows", { name });
    return `✅ Workflow vacío creado: "${name}"\nID: \`${w.id}\`\n\n⚠️ Este workflow no tiene nodos. Pide al usuario que abra n8n y agregue los nodos manualmente.`;
  }

  const validatedNodes = nodes.map((n: any) => {
    if (!n.id) n.id = uuidv4();
    if (!n.typeVersion) n.typeVersion = 1;
    if (!n.position) n.position = [100, 100];
    if (!n.parameters) n.parameters = {};
    if (!n.continueOnFail) n.continueOnFail = false;
    if (!n.executeOnce) n.executeOnce = false;
    n.type = mapNodeType(n.type || "");
    return n;
  });

  const validatedConns = connections || buildConnections(validatedNodes);

  const payload = {
    name,
    nodes: validatedNodes,
    connections: validatedConns,
    settings: { executionOrder: "v1" },
    staticData: null,
    tags: [],
  };

  console.log(`[n8n] Creando workflow "${name}" con ${validatedNodes.length} nodos`);
  const w: any = await post("/workflows", payload);

  const created: any = await get(`/workflows/${w.id}`);
  const realNodes: any[] = created.nodes || [];

  if (realNodes.length === 0 && nodes.length > 0) {
    return [
      `⚠️ Workflow "${name}" creado (ID: \`${w.id}\`) PERO n8n no guardó los nodos que envié.`,
      ``,
      `Causa probable: los tipos de nodo o el formato no son válidos para esta versión de n8n.`,
      ``,
      `✅ *Lo que SÍ puedo hacer:*`,
      `• Leer workflows existentes y analizar su estructura real`,
      `• Sugerir correcciones específicas basadas en el JSON real de n8n`,
      `• Importar workflows desde JSON exportado de n8n`,
      `• Activar / desactivar / eliminar workflows`,
      `• Ejecutar workflows y ver resultados`,
      ``,
      `Para arreglar nodos, necesito que exportes el workflow desde n8n como JSON y me lo pegues aquí.`,
    ].join("\n");
  }

  const names = realNodes.map((n: any) => n.name).join(", ");
  return [
    `✅ Workflow creado y verificado en n8n`,
    `Nombre: ${name} | ID: \`${w.id}\``,
    `Nodos guardados: ${realNodes.length} (${names})`,
    `🟢 Ya puedes abrirlo en n8n, agregar credenciales y probarlo.`,
  ].join("\n");
}

async function importWorkflow(jsonStr: string): Promise<string> {
  let wf: any;
  try {
    wf = JSON.parse(jsonStr);
  } catch {
    return "❌ El JSON es inválido. Asegúrate de pegar un JSON válido exportado de n8n.";
  }

  if (!wf.name) return "❌ El JSON no tiene campo 'name'. No parece ser un workflow de n8n.";
  if (!wf.nodes) wf.nodes = [];
  if (!wf.connections) wf.connections = {};
  wf.id = undefined;

  const imported: any = await post("/workflows", wf);

  if (imported.id) {
    const nodeCount = (wf.nodes || []).length;
    const names = (wf.nodes || []).map((n: any) => n.name).join(", ") || "ninguno";
    return [
      `✅ Workflow importado exitosamente`,
      `Nombre: ${wf.name} | ID: \`${imported.id}\``,
      `Nodos: ${nodeCount} (${names})`,
      `🟢 Ábrelo en n8n, verifica los nodos y activa el workflow.`,
    ].join("\n");
  }

  return `⚠️ n8n respondió pero no devolvió ID. Revisa en n8n si el workflow "${wf.name}" apareció.`;
}

async function analyzeWorkflow(workflowId: string): Promise<string> {
  const w: any = await get(`/workflows/${workflowId}`);
  if (w.message === "not found" || !w.id) return `❌ Workflow \`${workflowId}\` no encontrado.`;

  const nodes: any[] = w.nodes || [];
  const conns: any = w.connections || {};

  const issues: string[] = [];
  const suggestions: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n.type) issues.push(`Nodo "${n.name}" (#${i + 1}) no tiene tipo definido`);
    if (!n.parameters || Object.keys(n.parameters).length === 0) {
      suggestions.push(`Nodo "${n.name}" (#${i + 1}): sin parámetros — probablemente necesita credenciales o configuración`);
    }
  }

  const nodeNames = nodes.map((n: any) => n.name);
  for (const [src, outputs] of Object.entries(conns)) {
    if (!nodeNames.includes(src)) {
      issues.push(`Conexión referencia nodo "${src}" que no existe`);
    }
  }

  const orphanNodes = nodes.filter((n: any) => {
    const hasIncoming = Object.values(conns).some((outs: any) =>
      (outs.main || outs).some((arr: any) =>
        arr.some((c: any) => c.node === n.name)
      )
    );
    const hasOutgoing = conns[n.name];
    return !hasIncoming && !hasOutgoing && nodes.length > 1;
  });
  if (orphanNodes.length > 0) {
    issues.push(`Nodos huérfanos (sin conexión): ${orphanNodes.map((n: any) => n.name).join(", ")}`);
  }

  const hasWebhook = nodes.some((n: any) => n.type?.includes("webhook") || n.type?.includes("trigger"));
  const hasTrigger = nodes.some((n: any) =>
    n.type?.includes("trigger") || n.type?.includes("schedule") || n.type?.includes("webhook")
  );
  if (!hasTrigger) {
    issues.push("No hay nodo trigger (webhook, schedule, etc.) — el workflow no se ejecutará automáticamente");
  }

  if (nodes.length === 0) {
    return [
      `🔍 *Análisis: ${w.name}*`,
      ``,
      `❌ El workflow está VACÍO — no tiene ningún nodo.`,
      ``,
      `Para que funcione, necesitas:`,
      `1. Agregar un trigger (Webhook, Schedule, etc.)`,
      `2. Conectar los nodos de tu flujo`,
      `3. Configurar credenciales`,
    ].join("\n");
  }

  const lines = [
    `🔍 *Análisis: ${w.name}*`,
    `ID: \`${w.id}\` | ${emoji(w.active)} ${w.active ? "Activo" : "Inactivo"}`,
    `Nodos: ${nodes.length}`,
  ];

  if (issues.length > 0) {
    lines.push(`\n❌ *Problemas encontrados (${issues.length}):*`);
    issues.forEach((issue, i) => lines.push(`${i + 1}. ${issue}`));
  } else {
    lines.push(`\n✅ No hay problemas críticos detectados`);
  }

  if (suggestions.length > 0) {
    lines.push(`\n💡 *Sugerencias:*`);
    suggestions.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  lines.push(`\n📋 *Estructura actual:*`);
  nodes.forEach((n: any, i: number) => {
    const outputs: string[] = [];
    for (const [, outs] of Object.entries(conns[n.name] || {})) {
      for (const arr of (outs as any[])) {
        for (const c of arr) outputs.push(c.node);
      }
    }
    lines.push(`  ${i + 1}. \`${n.name}\` → ${outputs.join(", ") || "sin salida"}`);
  });

  return lines.join("\n");
}

async function activateWorkflow(workflowId: string): Promise<string> {
  await post(`/workflows/${workflowId}/activate`);
  return `▶️ Workflow \`${workflowId}\` activado 🟢`;
}

async function deactivateWorkflow(workflowId: string): Promise<string> {
  await post(`/workflows/${workflowId}/deactivate`);
  return `⏸ Workflow \`${workflowId}\` desactivado 🔴`;
}

async function deleteWorkflow(workflowId: string): Promise<string> {
  await del(`/workflows/${workflowId}`);
  return `🗑️ Workflow \`${workflowId}\` eliminado.`;
}

async function listExecutions(workflowId?: string, limit = 10): Promise<string> {
  const params: Record<string, string> = { limit: limit.toString() };
  if (workflowId) params.workflowId = workflowId;
  const data: any = await get("/executions", params);
  const exs: any[] = data.data || [];
  if (!exs.length) return "📜 Sin ejecuciones.";

  const lines = [`📜 *Últimas ${exs.length} ejecuciones*`];
  for (const e of exs) {
    const started = new Date(e.startedAt).toLocaleString("es-CO", { timeZone: "America/Bogota" });
    const dur = e.stoppedAt
      ? `${Math.round((new Date(e.stoppedAt).getTime() - new Date(e.startedAt).getTime()) / 1000)}s`
      : "en curso";
    const icon = e.status === "success" ? "✅" : e.status === "error" ? "❌" : "⏳";
    lines.push(`${icon} ID:${e.id} | WF:${e.workflowId} | ${started} | ${dur}`);
  }
  return lines.join("\n");
}

async function executeWorkflow(workflowId: string, inputData?: Record<string, unknown>): Promise<string> {
  const exec: any = await post(`/workflows/${workflowId}/run`, inputData ? { runData: inputData } : {});
  const execId = exec.data?.executionId || exec.executionId || "desconocido";
  return `🚀 Ejecutando \`${workflowId}\`\nExecution ID: \`${execId}\`\nEstado: ${exec.data?.status || "running"}`;
}

// ─── Tool ──────────────────────────────────────────────────────────────────────

export const n8nManagerTool: Tool = {
  name: "n8n_manager",
  description:
    "Gestiona workflows de n8n. Usa esta herramienta para TODAS las operaciones con n8n.\n\n" +
    "ACCIONES DISPONIBLES:\n" +
    "• list: Lista todos los workflows (ID, nombre, estado)\n" +
    "• get: Muestra detalle completo de un workflow (nodos, conexiones, tags)\n" +
    "• analyze: Analiza un workflow y reporta problemas (nodos huérfanos, falta trigger, etc.)\n" +
    "• create: Crea un workflow con nodos — SOLO funciona si el JSON de nodos es válido para n8n\n" +
    "• import: Importa un workflow desde JSON exportado de n8n (la forma más confiable)\n" +
    "• activate: Activa un workflow\n" +
    "• deactivate: Desactiva un workflow\n" +
    "• execute: Ejecuta un workflow manualmente\n" +
    "• delete: Elimina un workflow\n" +
    "• executions: Ver historial de ejecuciones\n\n" +
    "IMPORTANTE sobre crear nodos:\n" +
    "• La API REST de n8n A VECES rechaza nodos si el formato no coincide con la versión de n8n\n" +
    "• El método MÁS CONFIABLE es que el usuario exporte el workflow desde n8n como JSON y lo pegue aquí para importar\n" +
    "• Si crear un workflow con nodos falla, el tool te lo сообщит con la causa y alternativas\n\n" +
    "PARÁMETROS:\n" +
    "• action: list|get|analyze|create|import|activate|deactivate|execute|delete|executions\n" +
    "• workflow_id: ID del workflow (para get, analyze, activate, deactivate, execute, delete)\n" +
    "• name: nombre del workflow (para create)\n" +
    "• nodes: array de nodos (para create) — cada nodo debe tener: name, type, typeVersion, position, parameters\n" +
    "• import_json: string JSON completo de un workflow exportado (para import)\n" +
    "• input_data: datos de entrada (para execute)",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "analyze", "create", "import", "activate", "deactivate", "execute", "delete", "executions"],
        description: "Acción a ejecutar",
      },
      workflow_id:  { type: "string",  description: "ID del workflow" },
      name:         { type: "string",  description: "Nombre del workflow (para create)" },
      nodes:        { type: "array",   description: "Array de nodos (para create)" },
      connections:  { type: "object",  description: "Mapa de conexiones (para create)" },
      import_json:  { type: "string",  description: "JSON completo de workflow exportado de n8n (para import)" },
      input_data:   { type: "object",  description: "Datos de entrada (para execute)" },
      limit:        { type: "number",  description: "Límite para executions" },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const { action, workflow_id, name, nodes, connections, import_json, input_data, limit } = params as any;

    try {
      switch (action) {
        case "list":
          return listWorkflows();

        case "get":
          if (!workflow_id) return "❌ Falta: workflow_id";
          return getWorkflow(workflow_id);

        case "analyze":
          if (!workflow_id) return "❌ Falta: workflow_id";
          return analyzeWorkflow(workflow_id);

        case "create":
          if (!name) return "❌ Falta: name";
          return createWorkflow(name, nodes, connections);

        case "import":
          if (!import_json) return "❌ Para importar, necesitas pegar el JSON del workflow exportado de n8n.";
          return importWorkflow(import_json);

        case "activate":
          if (!workflow_id) return "❌ Falta: workflow_id";
          return activateWorkflow(workflow_id);

        case "deactivate":
          if (!workflow_id) return "❌ Falta: workflow_id";
          return deactivateWorkflow(workflow_id);

        case "execute":
          if (!workflow_id) return "❌ Falta: workflow_id";
          return executeWorkflow(workflow_id, input_data);

        case "delete":
          if (!workflow_id) return "❌ Falta: workflow_id";
          return deleteWorkflow(workflow_id);

        case "executions":
          return listExecutions(workflow_id, limit || 10);

        default:
          return `❌ Acción desconocida: ${action}`;
      }
    } catch (err: any) {
      return `❌ n8n error: ${err.message}`;
    }
  },
};
