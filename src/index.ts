import "dotenv/config";
import "./memory/db"; // inicializa DB antes que todo
// @ts-ignore - Express v5 types gap
import express from "express";
import { createTelegramBot } from "./bot/telegram.js";
import whatsappRouter from "./bot/whatsapp.route.js";
import landingsRouter from "./routes/landings.route.js";
import { closeDb } from "./memory/db.js";
import db from "./memory/db.js";

const app = express();

// Middlewares
// @ts-ignore
app.use(express.json());
// @ts-ignore
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/health", (_req, res) => {
  const base = {
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage().heapUsed,
  };

  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const total1h = db.prepare("SELECT COUNT(*) as c FROM agent_runs WHERE created_at >= ?").get(oneHourAgo) as { c: number };
    const success1h = db.prepare("SELECT COUNT(*) as c FROM agent_runs WHERE created_at >= ? AND status = 'success'").get(oneHourAgo) as { c: number };
    const error1h = db.prepare("SELECT COUNT(*) as c FROM agent_runs WHERE created_at >= ? AND (status = 'error' OR status = 'max_iterations')").get(oneHourAgo) as { c: number };

    res.json({
      ...base,
      lastRuns: {
        total_1h: total1h.c,
        success_1h: success1h.c,
        errors_1h: error1h.c,
      },
    });
  } catch {
    res.json(base);
  }
});

// Rutas
app.use("/webhook/whatsapp", whatsappRouter);
app.use("/l", landingsRouter);         // sirve /l/:slug
app.use("/", landingsRouter);          // sirve /api/landings y /api/landing-generate

// Start Server
const PORT = process.env.PORT || 8080;

async function start() {
  console.log("🤖 Iniciando JARVIS v2...");

  // Iniciar bot de Telegram
  try {
    const telegramBot = createTelegramBot();
    
    // grammy recomienda llamar a .start de forma asíncrona pero sin await si queremos
    // que el código continúe, o ejecutar expr y telegram al mismo tiempo
    telegramBot.start({
      onStart: (info) => {
        console.log(`✅ Telegram Bot online → @${info.username}`);
      },
    }).catch(err => {
      console.error("❌ Error en Telegram Bot:", err);
    });
  } catch (err) {
    console.error("❌ Error al inicializar Telegram Bot:", err);
  }

  // Iniciar servidor Express (Webhook WA)
  const server = app.listen(Number(PORT), () => {
    console.log(`✅ Servidor Express online en puerto ${PORT}`);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────
  async function shutdown(signal: string) {
    console.log(`\n${signal} recibido. Cerrando gracefully...`);
    server.close(() => console.log("HTTP server cerrado."));
    try {
      closeDb();
      console.log("DB cerrada.");
    } catch (e) {
      console.error("Error en shutdown:", e);
    }
    process.exit(0);
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("❌ Error fatal al iniciar:", err);
  process.exit(1);
});
