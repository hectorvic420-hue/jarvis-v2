import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  savePendingOrder,
  getPendingOrderByChatId,
  deletePendingOrder,
} from "../shared/pendingStore.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (params: Record<string, unknown>, chatId: string) => Promise<string>;
}

// ─── Shared response type ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

// ─── Binance REST helper ──────────────────────────────────────────────────────

const BASE = "https://api.binance.com";

function sign(query: string): string {
  return crypto
    .createHmac("sha256", process.env.BINANCE_SECRET!)
    .update(query)
    .digest("hex");
}

async function publicGet(path: string, params: Record<string, string> = {}): Promise<ApiResponse> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<ApiResponse>;
}

async function privateGet(path: string, params: Record<string, string> = {}): Promise<ApiResponse> {
  const timestamp = Date.now().toString();
  const qs = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = sign(qs);
  const url = `${BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY! },
  });
  if (!res.ok) throw new Error(`Binance error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<ApiResponse>;
}

async function privatePost(path: string, params: Record<string, string> = {}): Promise<ApiResponse> {
  const timestamp = Date.now().toString();
  const qs = new URLSearchParams({ ...params, timestamp }).toString();
  const signature = sign(qs);
  const url = `${BASE}${path}?${qs}&signature=${signature}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": process.env.BINANCE_API_KEY! },
  });
  if (!res.ok) throw new Error(`Binance error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<ApiResponse>;
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 0.10; // 10%

async function checkCircuitBreaker(): Promise<{ halt: boolean; reason?: string }> {
  try {
    const account = await privateGet("/api/v3/account");
    const balances: Array<{ asset: string; free: string }> = account.balances;
    const usdtBalance = balances.find((b) => b.asset === "USDT");
    const btcBalance = balances.find((b) => b.asset === "BTC");

    if (!usdtBalance) return { halt: false };

    const usdt = parseFloat(usdtBalance.free);

    if (btcBalance) {
      const ticker = await publicGet("/api/v3/ticker/price", { symbol: "BTCUSDT" });
      const btcPrice = parseFloat(ticker.price);
      const btcValue = parseFloat(btcBalance.free) * btcPrice;
      const total = usdt + btcValue;

      // Revisar historial de trades para calcular P&L estimado
      const rawTrades = await privateGet("/api/v3/myTrades", {
        symbol: "BTCUSDT",
        limit: "50",
      });
      const trades = rawTrades as ApiResponse[];

      if (trades.length > 0) {
        const recent = trades.slice(-10);
        const avgBuyPrice =
          recent
            .filter((t: any) => t.isBuyer)
            .reduce((sum: number, t: any) => sum + parseFloat(t.price), 0) /
          (recent.filter((t: any) => t.isBuyer).length || 1);

        if (avgBuyPrice > 0 && btcPrice < avgBuyPrice * (1 - CIRCUIT_BREAKER_THRESHOLD)) {
          return {
            halt: true,
            reason: `⛔ CIRCUIT BREAKER ACTIVADO: Precio BTC (${btcPrice.toFixed(2)}) cayó >10% vs precio promedio de compra (${avgBuyPrice.toFixed(2)})`,
          };
        }
      }
    }

    return { halt: false };
  } catch {
    return { halt: false };
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function getPrice(symbol: string): Promise<string> {
  const sym = symbol.toUpperCase().replace("/", "");
  const data = await publicGet("/api/v3/ticker/price", { symbol: sym });
  const stats = await publicGet("/api/v3/ticker/24hr", { symbol: sym });
  return [
    `💰 *${sym}*`,
    `Precio: $${parseFloat(data.price).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    `Cambio 24h: ${parseFloat(stats.priceChangePercent).toFixed(2)}%`,
    `Máx 24h: $${parseFloat(stats.highPrice).toLocaleString("en-US")}`,
    `Mín 24h: $${parseFloat(stats.lowPrice).toLocaleString("en-US")}`,
    `Volumen: ${parseFloat(stats.volume).toFixed(2)} ${sym.replace("USDT", "")}`,
  ].join("\n");
}

async function getBalance(): Promise<string> {
  const account = await privateGet("/api/v3/account");
  const balances = account.balances.filter(
    (b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
  );

  if (balances.length === 0) return "💼 Balance: Sin activos.";

  const lines = ["💼 *Balance Binance*"];
  for (const b of balances) {
    const free = parseFloat(b.free);
    const locked = parseFloat(b.locked);
    lines.push(
      `• ${b.asset}: ${free.toFixed(6)} libre${locked > 0 ? ` | ${locked.toFixed(6)} bloqueado` : ""}`
    );
  }
  return lines.join("\n");
}

async function analyzePair(symbol: string): Promise<string> {
  const sym = symbol.toUpperCase().replace("/", "");

  const [ticker, klines] = await Promise.all([
    publicGet("/api/v3/ticker/24hr", { symbol: sym }),
    publicGet("/api/v3/klines", { symbol: sym, interval: "1h", limit: "24" }),
  ]);

  const prices = klines.map((k: any) => parseFloat(k[4]));
  const avg = prices.reduce((a: number, b: number) => a + b, 0) / prices.length;
  const current = parseFloat(ticker.lastPrice);
  const change = parseFloat(ticker.priceChangePercent);
  const volume = parseFloat(ticker.quoteVolume);

  const trend = current > avg ? "📈 Alcista" : "📉 Bajista";
  const momentum = change > 2 ? "Fuerte" : change > 0 ? "Débil" : change > -2 ? "Negativo débil" : "Negativo fuerte";
  const volumeLabel = volume > 1_000_000 ? "Alto" : volume > 100_000 ? "Medio" : "Bajo";

  return [
    `📊 *Análisis ${sym}*`,
    `Precio actual: $${current.toLocaleString("en-US")}`,
    `Tendencia 24h: ${trend}`,
    `Momentum: ${momentum} (${change.toFixed(2)}%)`,
    `Media 24h: $${avg.toFixed(2)}`,
    `Volumen: ${volumeLabel} ($${(volume / 1_000_000).toFixed(2)}M)`,
    ``,
    `⚠️ Análisis informativo, no es asesoría financiera.`,
  ].join("\n");
}

async function requestOrder(
  chatId: string,
  symbol: string,
  side: string,
  type: string,
  quantity: string,
  price?: string
): Promise<string> {
  const cb = await checkCircuitBreaker();
  if (cb.halt) return cb.reason!;

  const sym = symbol.toUpperCase().replace("/", "");
  const orderId = uuidv4();

  savePendingOrder(orderId, chatId, "binance", "order", {
    symbol: sym,
    side: side.toUpperCase(),
    type: type.toUpperCase(),
    quantity,
    price,
  });

  const lines = [
    `⚠️ *Confirmación requerida*`,
    ``,
    `📋 Orden pendiente:`,
    `• Par: ${sym}`,
    `• Lado: ${side.toUpperCase()}`,
    `• Tipo: ${type.toUpperCase()}`,
    `• Cantidad: ${quantity}`,
  ];
  if (price) lines.push(`• Precio límite: $${price}`);
  lines.push(``, `Responde /confirmar para ejecutar (expira en 5 min)`);
  lines.push(`ID: \`${orderId}\``);

  return lines.join("\n");
}

async function confirmOrder(chatId: string): Promise<string> {
  const pending = getPendingOrderByChatId(chatId);
  if (!pending) return "❌ No hay orden pendiente o expiró (TTL 5 min).";
  if (pending.tool !== "binance") return "❌ La orden pendiente no es de Binance.";

  const cb = await checkCircuitBreaker();
  if (cb.halt) {
    deletePendingOrder(pending.id);
    return cb.reason!;
  }

  const p = pending.payload as any;
  const params: Record<string, string> = {
    symbol: p.symbol,
    side: p.side,
    type: p.type,
    quantity: p.quantity,
  };
  if (p.type === "LIMIT" && p.price) {
    params.price = p.price;
    params.timeInForce = "GTC";
  }

  deletePendingOrder(pending.id);

  const result = await privatePost("/api/v3/order", params);

  return [
    `✅ *Orden ejecutada*`,
    `ID: ${result.orderId}`,
    `Par: ${result.symbol}`,
    `Lado: ${result.side}`,
    `Estado: ${result.status}`,
    `Cantidad: ${result.executedQty} / ${result.origQty}`,
    result.fills?.length
      ? `Precio promedio: $${(
          result.fills.reduce((s: number, f: any) => s + parseFloat(f.price) * parseFloat(f.qty), 0) /
          result.fills.reduce((s: number, f: any) => s + parseFloat(f.qty), 0)
        ).toFixed(2)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function getHistory(symbol: string, limit = 10): Promise<string> {
  const sym = symbol.toUpperCase().replace("/", "");
  const raw = await privateGet("/api/v3/myTrades", {
    symbol: sym,
    limit: limit.toString(),
  });

  const trades = raw as ApiResponse[];

  if (!trades.length) return `📜 Sin historial para ${sym}.`;

  const lines = [`📜 *Últimas ${trades.length} operaciones ${sym}*`];
  for (const t of (trades as any[])) {
    const date = new Date(t.time).toLocaleString("es-CO", { timeZone: "America/Bogota" });
    lines.push(
      `• ${t.isBuyer ? "COMPRA" : "VENTA"} | ${parseFloat(t.qty).toFixed(6)} @ $${parseFloat(t.price).toFixed(2)} | ${date}`
    );
  }
  return lines.join("\n");
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const binanceTool: Tool = {
  name: "binance",
  description:
    "Interactúa con Binance: consulta precios, balance, analiza pares, gestiona órdenes (requiere /confirmar) y consulta historial de trades.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["precio", "balance", "analizar", "orden", "confirmar", "historial"],
        description: "Acción a ejecutar",
      },
      symbol: {
        type: "string",
        description: "Par de trading (ej: BTCUSDT, ETH/USDT)",
      },
      side: {
        type: "string",
        enum: ["BUY", "SELL"],
        description: "Dirección de la orden",
      },
      type: {
        type: "string",
        enum: ["MARKET", "LIMIT"],
        description: "Tipo de orden",
      },
      quantity: {
        type: "string",
        description: "Cantidad a operar",
      },
      price: {
        type: "string",
        description: "Precio límite (solo para LIMIT)",
      },
      limit: {
        type: "number",
        description: "Cantidad de registros a retornar en historial",
      },
    },
    required: ["action"],
  },

  async execute(params, chatId) {
    const { action, symbol, side, type, quantity, price, limit } = params as any;

    switch (action) {
      case "precio":
        if (!symbol) return "❌ Falta parámetro: symbol";
        return getPrice(symbol);

      case "balance":
        return getBalance();

      case "analizar":
        if (!symbol) return "❌ Falta parámetro: symbol";
        return analyzePair(symbol);

      case "orden":
        if (!symbol || !side || !type || !quantity)
          return "❌ Faltan parámetros: symbol, side, type, quantity";
        return requestOrder(chatId, symbol, side, type, quantity, price);

      case "confirmar":
        return confirmOrder(chatId);

      case "historial":
        if (!symbol) return "❌ Falta parámetro: symbol";
        return getHistory(symbol, limit || 10);

      default:
        return `❌ Acción desconocida: ${action}`;
    }
  },
};
