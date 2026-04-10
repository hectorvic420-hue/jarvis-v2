import { Tool } from "../shared/types.js";

const ZONES: Record<string, string> = {
  colombia:      "America/Bogota",
  bogota:        "America/Bogota",
  mexico:        "America/Mexico_City",
  cdmx:          "America/Mexico_City",
  peru:          "America/Lima",
  lima:          "America/Lima",
  argentina:     "America/Argentina/Buenos_Aires",
  buenos_aires:  "America/Argentina/Buenos_Aires",
  chile:         "America/Santiago",
  venezuela:     "America/Caracas",
  ecuador:       "America/Guayaquil",
  usa_east:      "America/New_York",
  usa_west:      "America/Los_Angeles",
  españa:        "Europe/Madrid",
  espana:        "Europe/Madrid",
  utc:           "UTC",
};

function formatInZone(date: Date, tz: string): string {
  return date.toLocaleString("es-CO", {
    timeZone: tz,
    weekday: "long",
    year:    "numeric",
    month:   "long",
    day:     "numeric",
    hour:    "2-digit",
    minute:  "2-digit",
    second:  "2-digit",
    hour12:  true,
  });
}

function resolveZone(input: string): string | null {
  const key = input.toLowerCase().replace(/\s+/g, "_");
  if (ZONES[key]) return ZONES[key];
  // Intentar directamente si es IANA válido (ej: "America/Bogota")
  try {
    Intl.DateTimeFormat(undefined, { timeZone: input });
    return input;
  } catch {
    return null;
  }
}

export const timezoneTool: Tool = {
  name: "timezone",
  description:
    "Consulta la hora actual en cualquier zona horaria, convierte horas entre zonas, y muestra la zona horaria del servidor. " +
    "Úsala para responder 'qué hora es en Colombia', 'convierte 3pm Bogotá a Madrid', 'en qué zona está el servidor'.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["current_time", "convert", "server_info"],
        description:
          "current_time: hora actual en una o varias zonas. " +
          "convert: convierte una hora de una zona a otra. " +
          "server_info: zona horaria y hora del servidor.",
      },
      zone: {
        type: "string",
        description:
          "Zona horaria de destino. Acepta nombres IANA (America/Bogota) o alias: colombia, mexico, peru, argentina, usa_east, españa, utc. " +
          "Para current_time puedes pasar varias separadas por coma.",
      },
      time: {
        type: "string",
        description: "Hora a convertir. Formato: 'HH:MM' o 'HH:MM:SS' (24h). Ej: '15:00'",
      },
      from_zone: {
        type: "string",
        description: "Zona horaria de origen para la conversión.",
      },
    },
    required: ["action"],
  },

  async execute(params) {
    const { action, zone, time, from_zone } = params as Record<string, string>;
    const now = new Date();

    try {
      switch (action) {
        case "server_info": {
          const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "UTC (no configurado)";
          const serverLocal = now.toLocaleString("es-CO");
          const bogota      = formatInZone(now, "America/Bogota");
          const utc         = formatInZone(now, "UTC");
          return (
            `🖥️ *Zona horaria del servidor:* \`${serverTz}\`\n` +
            `🕐 *Hora local del servidor:* ${serverLocal}\n\n` +
            `🌎 *Bogotá (Colombia):* ${bogota}\n` +
            `🌐 *UTC:*              ${utc}`
          );
        }

        case "current_time": {
          if (!zone) return "❌ Debes indicar la zona horaria con el parámetro `zone`.";
          const zones = zone.split(",").map(z => z.trim());
          const lines: string[] = [];
          for (const z of zones) {
            const iana = resolveZone(z);
            if (!iana) {
              lines.push(`❌ Zona desconocida: "${z}"`);
              continue;
            }
            lines.push(`🕐 *${z}* (${iana})\n   ${formatInZone(now, iana)}`);
          }
          return lines.join("\n\n");
        }

        case "convert": {
          if (!time)      return "❌ Debes indicar la hora con el parámetro `time` (ej: '15:00').";
          if (!from_zone) return "❌ Debes indicar la zona de origen con `from_zone`.";
          if (!zone)      return "❌ Debes indicar la zona de destino con `zone`.";

          const fromIana = resolveZone(from_zone);
          const toIana   = resolveZone(zone);
          if (!fromIana) return `❌ Zona de origen desconocida: "${from_zone}"`;
          if (!toIana)   return `❌ Zona de destino desconocida: "${zone}"`;

          // Construir fecha de hoy con la hora indicada en la zona origen
          const [hStr, mStr = "0", sStr = "0"] = time.split(":");
          const h = parseInt(hStr, 10);
          const m = parseInt(mStr, 10);
          const s = parseInt(sStr, 10);
          if (isNaN(h) || isNaN(m)) return `❌ Hora inválida: "${time}". Usa formato HH:MM.`;

          // Fecha local del servidor en la zona origen
          const bogotaDate = new Date(now.toLocaleString("en-US", { timeZone: fromIana }));
          bogotaDate.setHours(h, m, s, 0);
          // Calcular offset entre zona origen y UTC
          const originOffset = bogotaDate.getTime() - new Date(bogotaDate.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
          const utcEquiv = new Date(bogotaDate.getTime() - originOffset);

          const resultFrom = bogotaDate.toLocaleString("es-CO", {
            timeZone: fromIana, hour: "2-digit", minute: "2-digit", hour12: true,
          });
          const resultTo = utcEquiv.toLocaleString("es-CO", {
            timeZone: toIana, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: true,
          });

          return (
            `🔄 *Conversión de hora:*\n` +
            `   ${time} en *${from_zone}* (${fromIana})\n` +
            `   → *${resultTo}* en *${zone}* (${toIana})`
          );
        }

        default:
          return `❌ Acción desconocida: "${action}". Usa: current_time, convert, server_info.`;
      }
    } catch (err: any) {
      return `❌ Error en timezone: ${err.message as string}`;
    }
  },
};
