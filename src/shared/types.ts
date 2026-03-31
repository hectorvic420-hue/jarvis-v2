// ─── Shared tool types ────────────────────────────────────────────────────────

export interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface Tool {
  name:        string;
  description: string;
  parameters:  ToolParameters;
  execute:     (params: Record<string, unknown>, chatId: string) => Promise<string>;
}
