import { google } from "googleapis";
import * as fs from "fs";
import * as path from "path";

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getAuthClient() {
  const credsJson = process.env.GOOGLE_CREDENTIALS_JSON;
  if (!credsJson) throw new Error("GOOGLE_CREDENTIALS_JSON not set");

  const creds = JSON.parse(credsJson);

  // Service account
  if (creds.type === "service_account") {
    return new google.auth.GoogleAuth({
      credentials: creds,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/calendar",
      ],
    });
  }

  // OAuth2 credentials
  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uri
  );
  if (creds.refresh_token) {
    oauth2Client.setCredentials({ refresh_token: creds.refresh_token });
  }
  return oauth2Client;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHEETS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_SHEET_ID = process.env.GOOGLE_SHEETS_ID ?? "";

export interface SheetReadResult {
  success: boolean;
  values: string[][];
  rows: number;
  error?: string;
}

export async function sheetsRead(
  range: string,
  spreadsheetId = DEFAULT_SHEET_ID
): Promise<SheetReadResult> {
  try {
    const auth  = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth: auth as any });

    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const values = (res.data.values ?? []) as string[][];
    return { success: true, values, rows: values.length };
  } catch (err: any) {
    return { success: false, values: [], rows: 0, error: err.message };
  }
}

export interface SheetWriteResult {
  success: boolean;
  updated_cells?: number;
  error?: string;
}

export async function sheetsWrite(
  range: string,
  values: (string | number | boolean)[][],
  spreadsheetId = DEFAULT_SHEET_ID
): Promise<SheetWriteResult> {
  try {
    const auth  = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth: auth as any });

    const res = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    });

    return { success: true, updated_cells: res.data.updatedCells ?? 0 };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sheetsAppend(
  range: string,
  values: (string | number | boolean)[][],
  spreadsheetId = DEFAULT_SHEET_ID
): Promise<SheetWriteResult> {
  try {
    const auth  = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth: auth as any });

    const res = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values },
    });

    return {
      success: true,
      updated_cells: res.data.updates?.updatedCells ?? 0,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sheetsClear(
  range: string,
  spreadsheetId = DEFAULT_SHEET_ID
): Promise<{ success: boolean; error?: string }> {
  try {
    const auth  = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth: auth as any });

    await sheets.spreadsheets.values.clear({ spreadsheetId, range });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVE
// ─────────────────────────────────────────────────────────────────────────────

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export async function driveList(
  folderId?: string,
  query?: string
): Promise<{ success: boolean; files: DriveFile[]; error?: string }> {
  try {
    const auth  = getAuthClient();
    const drive = google.drive({ version: "v3", auth: auth as any });

    let q = "trashed = false";
    if (folderId) q += ` and '${folderId}' in parents`;
    if (query)    q += ` and ${query}`;

    const res = await drive.files.list({
      q,
      fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
      pageSize: 50,
    });

    return { success: true, files: (res.data.files ?? []) as DriveFile[] };
  } catch (err: any) {
    return { success: false, files: [], error: err.message };
  }
}

export interface DriveUploadResult {
  success: boolean;
  file_id?: string;
  web_view_link?: string;
  error?: string;
}

export async function driveUpload(
  localPath: string,
  remoteName?: string,
  folderId?: string,
  mimeType?: string
): Promise<DriveUploadResult> {
  try {
    const auth  = getAuthClient();
    const drive = google.drive({ version: "v3", auth: auth as any });

    const fileName = remoteName ?? path.basename(localPath);
    const detectedMime = mimeType ?? detectMimeType(localPath);

    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: folderId ? [folderId] : undefined,
      },
      media: {
        mimeType: detectedMime,
        body: fs.createReadStream(localPath),
      },
      fields: "id,webViewLink",
    });

    return {
      success: true,
      file_id: res.data.id ?? undefined,
      web_view_link: res.data.webViewLink ?? undefined,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function driveDownload(
  fileId: string,
  localPath: string
): Promise<{ success: boolean; path: string; error?: string }> {
  try {
    const auth  = getAuthClient();
    const drive = google.drive({ version: "v3", auth: auth as any });

    const dest = fs.createWriteStream(localPath);

    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    await new Promise<void>((resolve, reject) => {
      (res.data as any)
        .on("end", resolve)
        .on("error", reject)
        .pipe(dest);
    });

    return { success: true, path: localPath };
  } catch (err: any) {
    return { success: false, path: "", error: err.message };
  }
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".pdf":  "application/pdf",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4":  "video/mp4",
    ".mp3":  "audio/mpeg",
    ".json": "application/json",
    ".csv":  "text/csv",
    ".txt":  "text/plain",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext] ?? "application/octet-stream";
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  id?: string;
  summary: string;
  description?: string;
  start: string;   // ISO 8601
  end: string;     // ISO 8601
  location?: string;
  attendees?: string[];
  html_link?: string;
}

export async function calendarList(
  calendarId = "primary",
  maxResults = 20,
  timeMin?: string
): Promise<{ success: boolean; events: CalendarEvent[]; error?: string }> {
  try {
    const auth     = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth: auth as any });

    const res = await calendar.events.list({
      calendarId,
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: timeMin ?? new Date().toISOString(),
    });

    const events: CalendarEvent[] = (res.data.items ?? []).map((e: any) => ({
      id: e.id ?? "",
      summary: e.summary ?? "(sin título)",
      description: e.description ?? undefined,
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      location: e.location ?? undefined,
      attendees: e.attendees?.map((a: any) => a.email ?? "").filter(Boolean),
      html_link: e.htmlLink ?? undefined,
    }));

    return { success: true, events };
  } catch (err: any) {
    return { success: false, events: [], error: err.message };
  }
}

export interface CreateEventResult {
  success: boolean;
  event_id?: string;
  html_link?: string;
  error?: string;
}

export async function calendarCreate(
  event: CalendarEvent,
  calendarId = "primary"
): Promise<CreateEventResult> {
  try {
    const auth     = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth: auth as any });

    const res = await calendar.events.insert({
      calendarId,
      requestBody: {
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: { dateTime: event.start, timeZone: "America/Bogota" },
        end:   { dateTime: event.end,   timeZone: "America/Bogota" },
        attendees: event.attendees?.map((email) => ({ email })),
      },
    });

    return {
      success: true,
      event_id: res.data.id ?? undefined,
      html_link: res.data.htmlLink ?? undefined,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function calendarDelete(
  eventId: string,
  calendarId = "primary"
): Promise<{ success: boolean; error?: string }> {
  try {
    const auth     = getAuthClient();
    const calendar = google.calendar({ version: "v3", auth: auth as any });

    await calendar.events.delete({ calendarId, eventId });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Tool registry ────────────────────────────────────────────────────────────
export const googleWorkspaceTools = {
  // Sheets
  sheets_read:   sheetsRead,
  sheets_write:  sheetsWrite,
  sheets_append: sheetsAppend,
  sheets_clear:  sheetsClear,
  // Drive
  drive_list:     driveList,
  drive_upload:   driveUpload,
  drive_download: driveDownload,
  // Calendar
  calendar_list:   calendarList,
  calendar_create: calendarCreate,
  calendar_delete: calendarDelete,
};
