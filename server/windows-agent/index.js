"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = require("express");
var playwright_1 = require("playwright");
var fs = require("fs");
var path = require("path");
var app = (0, express_1.default)();
var PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
var SECRET = (_a = process.env.WINDOWS_AGENT_SECRET) !== null && _a !== void 0 ? _a : "jarvis-windows-secret";
app.use(express_1.default.json());
// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use(function (req, res, next) {
    var auth = req.headers.authorization;
    if (!auth || auth !== "Bearer ".concat(SECRET)) {
        res.status(401).json({ success: false, result: "Unauthorized" });
        return;
    }
    next();
});
var sessions = new Map();
function getOrCreateSession(chatId) {
    return __awaiter(this, void 0, void 0, function () {
        var existing, browser, context, page, session;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    existing = sessions.get(chatId);
                    if (existing) {
                        existing.lastUsed = Date.now();
                        return [2 /*return*/, existing];
                    }
                    return [4 /*yield*/, playwright_1.chromium.launch({ headless: false })];
                case 1:
                    browser = _a.sent();
                    return [4 /*yield*/, browser.newContext()];
                case 2:
                    context = _a.sent();
                    return [4 /*yield*/, context.newPage()];
                case 3:
                    page = _a.sent();
                    session = { browser: browser, context: context, page: page, lastUsed: Date.now() };
                    sessions.set(chatId, session);
                    return [2 /*return*/, session];
            }
        });
    });
}
// ─── Browser endpoint ─────────────────────────────────────────────────────────
app.post("/browser", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var params, action, url, selector, value, username, password, _a, user_selector, _b, pass_selector, _c, submit_selector, _d, direction, chatId, s, page, result, _e, _f, _g, _h, dir, filePath, _j, _k, _l, err_1;
    var _m, _o;
    return __generator(this, function (_p) {
        switch (_p.label) {
            case 0:
                params = req.body;
                action = params.action, url = params.url, selector = params.selector, value = params.value, username = params.username, password = params.password, _a = params.user_selector, user_selector = _a === void 0 ? "input[type='email'],#email,#username" : _a, _b = params.pass_selector, pass_selector = _b === void 0 ? "input[type='password']" : _b, _c = params.submit_selector, submit_selector = _c === void 0 ? "[type='submit']" : _c, _d = params.direction, direction = _d === void 0 ? "down" : _d;
                chatId = (_m = params.chat_id) !== null && _m !== void 0 ? _m : "default";
                _p.label = 1;
            case 1:
                _p.trys.push([1, 34, , 35]);
                if (!(action === "close")) return [3 /*break*/, 4];
                s = sessions.get(chatId);
                if (!s) return [3 /*break*/, 3];
                return [4 /*yield*/, s.browser.close()];
            case 2:
                _p.sent();
                sessions.delete(chatId);
                _p.label = 3;
            case 3:
                res.json({ success: true, result: "✅ Navegador cerrado." });
                return [2 /*return*/];
            case 4: return [4 /*yield*/, getOrCreateSession(chatId)];
            case 5:
                page = (_p.sent()).page;
                result = "";
                _e = action;
                switch (_e) {
                    case "navigate": return [3 /*break*/, 6];
                    case "click": return [3 /*break*/, 9];
                    case "fill": return [3 /*break*/, 14];
                    case "screenshot": return [3 /*break*/, 16];
                    case "get_text": return [3 /*break*/, 18];
                    case "login": return [3 /*break*/, 23];
                    case "select": return [3 /*break*/, 28];
                    case "scroll": return [3 /*break*/, 30];
                }
                return [3 /*break*/, 32];
            case 6: return [4 /*yield*/, page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 })];
            case 7:
                _p.sent();
                _g = (_f = "\u2705 Navegu\u00E9 a: ".concat(url, "\nT\u00EDtulo: ")).concat;
                return [4 /*yield*/, page.title()];
            case 8:
                result = _g.apply(_f, [_p.sent()]);
                return [3 /*break*/, 33];
            case 9:
                _p.trys.push([9, 11, , 13]);
                return [4 /*yield*/, page.click(selector, { timeout: 10000 })];
            case 10:
                _p.sent();
                return [3 /*break*/, 13];
            case 11:
                _h = _p.sent();
                return [4 /*yield*/, page.getByText(selector).first().click({ timeout: 10000 })];
            case 12:
                _p.sent();
                return [3 /*break*/, 13];
            case 13:
                result = "\u2705 Clic en: ".concat(selector);
                return [3 /*break*/, 33];
            case 14: return [4 /*yield*/, page.fill(selector, value, { timeout: 10000 })];
            case 15:
                _p.sent();
                result = "\u2705 Rellen\u00E9 campo \"".concat(selector, "\"");
                return [3 /*break*/, 33];
            case 16:
                dir = path.join((_o = process.env.TEMP) !== null && _o !== void 0 ? _o : "C:/Temp", "jarvis-screenshots");
                if (!fs.existsSync(dir))
                    fs.mkdirSync(dir, { recursive: true });
                filePath = path.join(dir, "screenshot-".concat(Date.now(), ".png"));
                return [4 /*yield*/, page.screenshot({ path: filePath })];
            case 17:
                _p.sent();
                result = "\uD83D\uDCF8 Screenshot en: ".concat(filePath);
                res.json({ success: true, result: result, screenshot_path: filePath });
                return [2 /*return*/];
            case 18:
                if (!selector) return [3 /*break*/, 20];
                _k = "\uD83D\uDCC4 ".concat;
                return [4 /*yield*/, page.locator(selector).first().textContent({ timeout: 10000 })];
            case 19:
                _j = _k.apply("\uD83D\uDCC4 ", [_p.sent()]);
                return [3 /*break*/, 22];
            case 20:
                _l = "\uD83D\uDCC4 ".concat;
                return [4 /*yield*/, page.evaluate(function () { return document.body.innerText; })];
            case 21:
                _j = _l.apply("\uD83D\uDCC4 ", [(_p.sent()).slice(0, 2000)]);
                _p.label = 22;
            case 22:
                result = _j;
                return [3 /*break*/, 33];
            case 23: return [4 /*yield*/, page.fill(user_selector, username, { timeout: 10000 })];
            case 24:
                _p.sent();
                return [4 /*yield*/, page.fill(pass_selector, password, { timeout: 10000 })];
            case 25:
                _p.sent();
                return [4 /*yield*/, page.click(submit_selector, { timeout: 10000 })];
            case 26:
                _p.sent();
                return [4 /*yield*/, page.waitForLoadState("domcontentloaded", { timeout: 15000 })];
            case 27:
                _p.sent();
                result = "\u2705 Login ejecutado. URL: ".concat(page.url());
                return [3 /*break*/, 33];
            case 28: return [4 /*yield*/, page.selectOption(selector, value, { timeout: 10000 })];
            case 29:
                _p.sent();
                result = "\u2705 Seleccion\u00E9 \"".concat(value, "\"");
                return [3 /*break*/, 33];
            case 30: return [4 /*yield*/, page.evaluate(function (dir) { window.scrollBy(0, dir === "down" ? 600 : -600); }, direction)];
            case 31:
                _p.sent();
                result = "\u2705 Scroll ".concat(direction);
                return [3 /*break*/, 33];
            case 32:
                res.json({ success: false, result: "\u274C Acci\u00F3n desconocida: ".concat(action) });
                return [2 /*return*/];
            case 33:
                res.json({ success: true, result: result });
                return [3 /*break*/, 35];
            case 34:
                err_1 = _p.sent();
                res.json({ success: false, result: "\u274C Error (".concat(action, "): ").concat(err_1.message) });
                return [3 /*break*/, 35];
            case 35: return [2 /*return*/];
        }
    });
}); });
app.listen(PORT, function () {
    console.log("\uD83D\uDDA5\uFE0F  Jarvis Windows Agent running on port ".concat(PORT));
    console.log("   Secret configured: ".concat(SECRET !== "jarvis-windows-secret" ? "✅" : "⚠️  using default"));
});
