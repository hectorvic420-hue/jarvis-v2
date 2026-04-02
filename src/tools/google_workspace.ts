import { Tool } from "../shared/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

const GMAIL_BASE    = "https://gmail.googleapis.com/gmail/v1";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const DRIVE_BASE    = "https://www.googleapis.com/drive/v3";
const DOCS_BASE     = "https://docs.googleapis.com/v1";
const SHEETS_BASE   = "https://sheets.googleapis.com/v4";

// ─── Auth ─────────────────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Faltan GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET o GOOGLE_REFRESH_TOKEN");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error((data["error_description"] as string) || `Google OAuth ${res.status}`);

  cachedToken = {
    value:     data["access_token"] as string,
    expiresAt: Date.now() + (data["expires_in"] as number) * 1000,
  };

  return cachedToken.value;
}

async function gGet(url: string, params: Record<string, string> = {}): Promise<ApiResponse> {
  const qs = Object.keys(params).length
    ? "?" + new URLSearchParams(params).toString()
    : "";
  const res = await fetch(`${url}${qs}`, {
    headers: { Authorization: `Bearer ${await token()}` },
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["error"]?.["message"] as string || `Google API ${res.status}`);
  return data;
}

async function gPost(url: string, body: unknown): Promise<ApiResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["error"]?.["message"] as string || `Google API ${res.status}`);
  return data;
}

async function gPatch(url: string, body: unknown): Promise<ApiResponse> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["error"]?.["message"] as string || `Google API ${res.status}`);
  return data;
}

// ─── Gmail ────────────────────────────────────────────────────────────────────

async function listEmails(query = "", maxResults = 10): Promise<string> {
  const data = await gGet(`${GMAIL_BASE}/users/me/messages`, {
    q: query,
    maxResults: maxResults.toString(),
  });

  const messages = (data["messages"] as ApiResponse[]) ?? [];
  if (!messages.length) return "📧 Sin correos encontrados.";

  const lines = [`📧 *Correos (${messages.length})*`];
  for (const m of messages.slice(0, 10)) {
    const detail = await gGet(`${GMAIL_BASE}/users/me/messages/${m["id"] as string}`, {
      format: "metadata",
      metadataHeaders: "Subject,From,Date",
    });
    const headers = (detail["payload"]?.["headers"] as ApiResponse[]) ?? [];
    const subject = headers.find((h: ApiResponse) => h["name"] === "Subject")?.["value"] ?? "(sin asunto)";
    const from    = headers.find((h: ApiResponse) => h["name"] === "From")?.["value"] ?? "?";
    lines.push(`• ${subject}\n  De: ${from}`);
  }
  return lines.join("\n");
}

async function sendEmail(to: string, subject: string, body: string): Promise<string> {
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const data = await gPost(`${GMAIL_BASE}/users/me/messages/send`, { raw });
  return `✅ Email enviado\nID: ${data["id"] as string}`;
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

async function listEvents(maxResults = 10): Promise<string> {
  const data = await gGet(`${CALENDAR_BASE}/calendars/primary/events`, {
    timeMin: new Date().toISOString(),
    maxResults: maxResults.toString(),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const items = (data["items"] as ApiResponse[]) ?? [];
  if (!items.length) return "📅 Sin eventos próximos.";

  const lines = [`📅 *Próximos eventos (${items.length})*`];
  for (const e of items) {
    const start = (e["start"]?.["dateTime"] ?? e["start"]?.["date"]) as string;
    const date  = new Date(start).toLocaleString("es-CO", { timeZone: "America/Bogota" });
    lines.push(`• ${e["summary"] as string ?? "(sin título)"}\n  ${date}`);
  }
  return lines.join("\n");
}

async function createEvent(
  summary: string,
  startDateTime: string,
  endDateTime: string,
  description?: string
): Promise<string> {
  const data = await gPost(`${CALENDAR_BASE}/calendars/primary/events`, {
    summary,
    description,
    start: { dateTime: startDateTime, timeZone: "America/Bogota" },
    end:   { dateTime: endDateTime,   timeZone: "America/Bogota" },
  });
  return `✅ Evento creado\nID: ${data["id"] as string}\n${summary}`;
}

// ─── Drive ────────────────────────────────────────────────────────────────────

async function listFiles(query = "", maxResults = 10): Promise<string> {
  const params: Record<string, string> = {
    pageSize: maxResults.toString(),
    fields:   "files(id,name,mimeType,modifiedTime,size)",
  };
  if (query) params["q"] = query;

  const data  = await gGet(`${DRIVE_BASE}/files`, params);
  const files = (data["files"] as ApiResponse[]) ?? [];
  if (!files.length) return "📁 Sin archivos encontrados.";

  const lines = [`📁 *Archivos Drive (${files.length})*`];
  for (const f of files) {
    const size = f["size"] ? `${Math.round(parseInt(f["size"] as string) / 1024)}KB` : "";
    lines.push(`• ${f["name"] as string} ${size}\n  ID: ${f["id"] as string}`);
  }
  return lines.join("\n");
}

async function readDoc(docId: string): Promise<string> {
  const data = await gGet(`${DOCS_BASE}/documents/${docId}`);
  const content = data["body"]?.["content"] as ApiResponse[] ?? [];

  const text = content
    .flatMap((block: ApiResponse) =>
      ((block["paragraph"]?.["elements"] as ApiResponse[]) ?? []).map(
        (el: ApiResponse) => el["textRun"]?.["content"] as string ?? ""
      )
    )
    .join("")
    .trim()
    .slice(0, 2000);

  return `📄 *${data["title"] as string}*\n\n${text}${text.length >= 2000 ? "\n...[truncado]" : ""}`;
}

async function readSheet(spreadsheetId: string, range = "A1:Z100"): Promise<string> {
  const data = await gGet(
    `${SHEETS_BASE}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`
  );
  const rows = (data["values"] as string[][]) ?? [];
  if (!rows.length) return "📊 Hoja vacía o sin datos en el rango.";

  const preview = rows
    .slice(0, 20)
    .map((row) => row.join(" | "))
    .join("\n");

  return `📊 *Hoja (${rows.length} filas)*\n\`\`\`\n${preview}\n\`\`\``;
}

async function appendToSheet(
  spreadsheetId: string,
  range: string,
  values: string[][]
): Promise<string> {
  const data = await gPost(
    `${SHEETS_BASE}/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
    { values }
  );
  const updates = data["updates"] as ApiResponse;
  return `✅ Filas añadidas: ${updates?.["updatedRows"] as number ?? "?"}\nRango: ${updates?.["updatedRange"] as string ?? range}`;
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const googleWorkspaceTool: Tool = {
  name: "google_workspace",
  description:
    "Accede a Gmail (leer/enviar emails), Google Calendar (listar/crear eventos), " +
    "Google Drive (listar archivos), Google Docs (leer documentos) y Google Sheets (leer/escribir).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list_emails", "send_email",
          "list_events", "create_event",
          "list_files",  "read_doc",
          "read_sheet",  "append_sheet",
        ],
      },
      query:          { type: "string",  description: "Búsqueda (emails/archivos)" },
      to:             { type: "string",  description: "Destinatario email" },
      subject:        { type: "string",  description: "Asunto del email" },
      body:           { type: "string",  description: "Cuerpo del email" },
      summary:        { type: "string",  description: "Título del evento" },
      start_datetime: { type: "string",  description: "ISO 8601 (2025-04-01T10:00:00)" },
      end_datetime:   { type: "string",  description: "ISO 8601 (2025-04-01T11:00:00)" },
      description:    { type: "string",  description: "Descripción del evento" },
      doc_id:         { type: "string",  description: "ID de Google Doc" },
      spreadsheet_id: { type: "string",  description: "ID de Google Sheet" },
      range:          { type: "string",  description: "Rango A1:Z100" },
      values:         { type: "array",   description: "Filas a insertar [[col1, col2]]" },
      max_results:    { type: "number",  description: "Límite de resultados" },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const {
      action, query, to, subject, body, summary,
      start_datetime, end_datetime, description,
      doc_id, spreadsheet_id, range, values, max_results,
    } = params as Record<string, any>;

    switch (action) {
      case "list_emails":  return listEmails(query, max_results);
      case "send_email":
        if (!to || !subject || !body) return "❌ Faltan: to, subject, body";
        return sendEmail(to, subject, body);
      case "list_events":  return listEvents(max_results);
      case "create_event":
        if (!summary || !start_datetime || !end_datetime)
          return "❌ Faltan: summary, start_datetime, end_datetime";
        return createEvent(summary, start_datetime, end_datetime, description);
      case "list_files":   return listFiles(query, max_results);
      case "read_doc":
        if (!doc_id) return "❌ Falta: doc_id";
        return readDoc(doc_id);
      case "read_sheet":
        if (!spreadsheet_id) return "❌ Falta: spreadsheet_id";
        return readSheet(spreadsheet_id, range);
      case "append_sheet":
        if (!spreadsheet_id || !range || !values) return "❌ Faltan: spreadsheet_id, range, values";
        return appendToSheet(spreadsheet_id, range, values);
      default:
        return `❌ Acción desconocida: ${action as string}`;
    }
  },
};
