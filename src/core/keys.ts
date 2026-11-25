/** Key codes (DOM KeyboardEvent.code) that the global listener can report on every platform. */
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((c) => "Key" + c);
const DIGITS = "0123456789".split("").map((c) => "Digit" + c);
const NUMPAD = "0123456789".split("").map((c) => "Numpad" + c);
const FKEYS = Array.from({ length: 12 }, (_, i) => "F" + (i + 1));

export const SUPPORTED_KEYS = new Set<string>([
  ...LETTERS,
  ...DIGITS,
  ...NUMPAD,
  ...FKEYS,
  "Space", "Enter", "Tab", "Backspace", "Escape",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "NumpadEnter", "NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal",
  "Semicolon", "Equal", "Comma", "Minus", "Period", "Slash", "Backquote",
  "BracketLeft", "Backslash", "BracketRight", "Quote",
]);
