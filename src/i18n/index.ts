import zh, { MessageKey } from "./zh";
import en from "./en";
import { Pattern } from "../core/types";

export type Lang = "zh" | "en";
export type LangSetting = "auto" | Lang;
export type { MessageKey };

const DICTS: Record<Lang, Record<MessageKey, string>> = { zh, en };
let current: Lang = resolveLang("auto");

export function resolveLang(s: LangSetting): Lang {
  if (s !== "auto") return s;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** Switch language. Components re-render via their own state (settings change). */
export function setLang(l: Lang) {
  current = l;
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
}

export function getLang(): Lang {
  return current;
}

/** Translate `key`, filling `{name}` placeholders. `{app}` is always the app name. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const s = DICTS[current][key] ?? zh[key] ?? key;
  const all: Record<string, string | number> = { app: DICTS[current]["app.name"], ...vars };
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in all ? String(all[k]) : m));
}

/** Display name of a pattern: built-ins are translated, custom ones keep the user's name. */
export function patternName(p: Pick<Pattern, "id" | "name" | "builtin">): string {
  const key = `preset.${p.id}` as MessageKey;
  return p.builtin && key in zh ? t(key) : p.name;
}

/** Display name of a key code (DOM KeyboardEvent.code). */
export function keyName(code: string): string {
  const named = `key.${code}` as MessageKey;
  if (named in zh) return t(named);
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) {
    const ops: Record<string, string> = { Add: "+", Subtract: "-", Multiply: "*", Divide: "/", Decimal: "." };
    const rest = code.slice(6);
    return t("key.numpad", { k: ops[rest] ?? rest });
  }
  const symbols: Record<string, string> = {
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc",
    Semicolon: ";", Equal: "=", Comma: ",", Minus: "-", Period: ".", Slash: "/",
    Backquote: "`", BracketLeft: "[", Backslash: "\\", BracketRight: "]", Quote: "'",
  };
  return symbols[code] ?? code;
}

export function tendency(m: number): string {
  return Math.abs(m) < 8 ? t("tend.onTime") : m < 0 ? t("tend.early", { ms: Math.abs(m) }) : t("tend.late", { ms: m });
}

export function formatPosition(p: { beat: number; sub: number; of: number }): string {
  return p.of === 1 ? t("pos.beat", { b: p.beat + 1 }) : t("pos.sub", { b: p.beat + 1, i: p.sub + 1, n: p.of });
}
