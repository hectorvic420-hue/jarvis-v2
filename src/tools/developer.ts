import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Tool } from "../shared/types.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const BASE_DIR = process.cwd();

// ─── Self-Healing Logic ───────────────────────────────────────────────────────

/**
 * JARVIS puede leer sus propios logs para entender por qué falló un comando o el sistema.
 */
async function readLogs(lines = 50): Promise<string> {
    try {
        // Intentamos leer el log de PM2 directamente si existe
        const logFile = path.join(process.env.HOME || "", ".pm2/logs/jarvis-v2-error.log");
        if (fs.existsSync(logFile)) {
            const content = execSync(`tail -n ${lines} ${logFile}`).toString();
            return `📄 [LOGS DE ERROR]:\n${content}`;
        }
        return "⚠️ Archivo de log no encontrado por ahora.";
    } catch (err: any) {
        return `❌ Error leyendo logs: ${err.message as string}`;
    }
}

/**
 * JARVIS puede leer su propio código para diagnosticarse.
 */
async function readSourceCode(filePath: string): Promise<string> {
    try {
        const absolutePath = path.resolve(BASE_DIR, filePath);
        if (!absolutePath.startsWith(BASE_DIR)) return "❌ Acceso denegado fuera del proyecto.";
        if (!fs.existsSync(absolutePath)) return `❌ El archivo ${filePath} no existe.`;
        
        const stat = fs.statSync(absolutePath);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(absolutePath).join("\n");
          return `📁 [DIRECTORIO ${filePath}]:\n${files}`;
        }

        const content = fs.readFileSync(absolutePath, "utf-8");
        return `📄 [CÓDIGO DE ${filePath}]:\n\`\`\`typescript\n${content}\n\`\`\``;
    } catch (err: any) {
        return `❌ Error leyendo código: ${err.message as string}`;
    }
}

/**
 * JARVIS puede editar su propio código para autorepararse.
 */
async function writeSourceCode(filePath: string, content: string): Promise<string> {
    try {
        const absolutePath = path.resolve(BASE_DIR, filePath);
        if (!absolutePath.startsWith(BASE_DIR)) return "❌ Acceso denegado fuera del proyecto.";
        
        fs.writeFileSync(absolutePath, content, "utf-8");
        return `✅ Archivo ${filePath} actualizado. JARVIS se ha 'reparado'. Se requiere compilación (npm run build) y reinicio para aplicar.`;
    } catch (err: any) {
        return `❌ Error escribiendo código: ${err.message as string}`;
    }
}

// ─── Tool Registry ────────────────────────────────────────────────────────────
export const developerTool: Tool = {
    name: "self_healing_architect",
    description: "Permite a JARVIS leer sus propios logs, leer su código fuente y editar archivos para autorepararse o mejorar sus funciones.",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["read_logs", "read_code", "edit_code"] },
            path:   { type: "string", description: "Ruta del archivo (ej: src/tools/whatsapp.ts)" },
            content: { type: "string", description: "Nuevo contenido del archivo para la acción edit_code" }
        },
        required: ["action"]
    },
    async execute(params, _chatId) {
        const { action, path: filePath, content } = params as Record<string, any>;
        try {
            switch (action) {
                case "read_logs": return await readLogs();
                case "read_code": return await readSourceCode(filePath || "");
                case "edit_code": return await writeSourceCode(filePath || "", content || "");
                default:          return "❌ Acción de autoreparación desconocida.";
            }
        } catch (err: any) { return `❌ Error crítico de arquitectura: ${err.message as string}`; }
    }
};
