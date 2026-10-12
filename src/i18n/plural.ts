import type { PluralForms } from "./types.ts";

const rules = new Map<string, Intl.PluralRules>();

/** The plural form of `forms` for `n` in `locale` (`2 дні`, `5 днів`, `1 day`). */
export function plural(locale: string, n: number, forms: PluralForms): string {
  let r = rules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    rules.set(locale, r);
  }
  const cat = r.select(n);
  return (cat === "one" || cat === "few" || cat === "many" ? forms[cat] : undefined) ?? forms.other;
}
