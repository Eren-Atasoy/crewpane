'use strict';

/**
 * Bir yeteneğin argümanlarını argv'ye BASAN tek genel uygulayıcı.
 * `position`: 'prepend' → argv'nin BAŞINA (codex'in pozisyonel kimliği SON kalsın),
 * her şey → SONUNA. Boş liste no-op (bugünkü davranış).
 */
function applyArgs(argv, args, position) {
  if (!Array.isArray(args) || !args.length) return argv;
  return position === 'prepend' ? [...args, ...argv] : [...argv, ...args];
}

/**
 * Bayrak + değer listesini descriptor'ın `repeat` beyanına göre kurar:
 *   • 'per-item' → `-i a -i b`   (her değer kendi bayrağıyla — codex görselleri)
 *   • 'variadic' → `--add-dir a b`  (tek bayrak, çok değer — claude ek kökleri)
 */
function repeatFlagArgs(flag, values, repeat) {
  const list = (Array.isArray(values) ? values : []).filter((v) => typeof v === 'string' && v.trim());
  if (!flag || !list.length) return [];
  if (repeat === 'variadic') return [flag, ...list];
  const out = [];
  for (const v of list) out.push(flag, v);
  return out;
}

/**
 * Escape an arbitrary string into a TOML basic string ("…").
 */
function tomlBasicString(value) {
  let out = '"';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

module.exports = {
  applyArgs,
  repeatFlagArgs,
  tomlBasicString,
};
