import { describe, expect, test } from "bun:test";
import { LOCALES, t } from "../src/i18n";
import en from "../src/i18n/en";
import type { Message } from "../src/i18n/types";

type Tree = { readonly [key: string]: Message | Tree | undefined };

function messages(tree: Tree, prefix = "", into = new Map<string, Message>()) {
  for (const [key, value] of Object.entries(tree)) {
    if (value === undefined) continue;
    if (typeof value === "string" || "other" in value)
      into.set(`${prefix}${key}`, value as Message);
    else messages(value as Tree, `${prefix}${key}.`, into);
  }
  return into;
}

function placeholders(message: Message): string[] {
  const texts = typeof message === "string" ? [message] : Object.values(message);
  return [
    ...new Set(texts.flatMap((text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))),
  ].sort();
}

const english = messages(en);

describe("t", () => {
  test("fills placeholders and picks English plurals", () => {
    expect(t("common.channels", { count: 1 })).toBe("1 channel");
    expect(t("common.channels", { count: 1200 })).toBe("1,200 channels");
  });
});

describe.each(Object.keys(LOCALES).filter((code) => code !== "en"))("%s", async (code) => {
  const { default: translation } = await LOCALES[code as keyof typeof LOCALES].load();
  const translated = messages(translation as Tree);
  const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;

  test("translates every message", () => {
    expect([...english.keys()].filter((key) => !translated.has(key))).toEqual([]);
  });

  test("keeps placeholders and plural shape", () => {
    const problems: string[] = [];
    for (const [key, message] of translated) {
      const source = english.get(key);
      if (!source) continue;
      if (placeholders(message).join() !== placeholders(source).join()) {
        problems.push(`${key}: placeholders differ`);
      }
      if ((typeof message === "string") !== (typeof source === "string")) {
        problems.push(`${key}: plural mismatch`);
      } else if (typeof message !== "string") {
        const missing = categories.filter((category) => !(category in message));
        if (missing.length) problems.push(`${key}: missing ${missing.join(", ")}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
