import fs from 'node:fs';

const localesDir = new URL('./locales/', import.meta.url);
const cache: Record<string, Record<string, string>> = {};

function pickLang(locale?: string) {
  if (locale?.toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}

export function loadLocale(locale?: string) {
  const lang = pickLang(locale);
  if (!cache[lang]) {
    const file = new URL(`${lang}.json`, localesDir);
    try {
      cache[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      cache[lang] = {};
    }
  }
  return (key: string, vars: Record<string, string | number> = {}) => {
    const template = cache[lang][key] || key;
    return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
  };
}

