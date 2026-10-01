import { createElement, Fragment, type ReactNode } from "react";
import en from "./en";
import type { Catalog, Message, MessageAt, MessageKeys, ParamArgs, Translation } from "./types";

export type EnglishCatalog = typeof en;
export type MessageKey = MessageKeys<EnglishCatalog>;
export type LocaleTranslation = Translation<EnglishCatalog>;

type TranslationModule = { default: LocaleTranslation };

/**
 * Supported UI languages, keyed by BCP 47 tag. Rust mirrors this list in
 * `src-tauri/src/i18n.rs` to resolve the launch locale and label the menu.
 */
export const LOCALES = {
  en: { name: "English", load: async (): Promise<TranslationModule> => ({ default: {} }) },
} as const satisfies Record<string, { name: string; load: () => Promise<TranslationModule> }>;

export type LocaleCode = keyof typeof LOCALES;

export function isLocaleCode(value: string): value is LocaleCode {
  return Object.hasOwn(LOCALES, value);
}

function flatten(catalog: Catalog | LocaleTranslation, into: Map<string, Message>, prefix = "") {
  for (const [key, value] of Object.entries(catalog)) {
    if (value === undefined) continue;
    const path = `${prefix}${key}`;
    if (typeof value === "string" || "other" in value) {
      into.set(path, value as Message);
    } else {
      flatten(value as Catalog, into, `${path}.`);
    }
  }
  return into;
}

const english = flatten(en, new Map());
let messages = english;
let locale: LocaleCode = "en";
let pluralRules = new Intl.PluralRules("en");
let countFormat = new Intl.NumberFormat("en");

/**
 * Loads the launch locale. Call once before the first render; the language
 * stays fixed for the life of the window (changes apply after a restart).
 */
export async function initI18n(code: string) {
  if (!isLocaleCode(code)) return;
  const { default: translation } = await LOCALES[code].load();
  messages = flatten(translation, new Map(english));
  locale = code;
  pluralRules = new Intl.PluralRules(code);
  countFormat = new Intl.NumberFormat(code);
  document.documentElement.lang = code;
}

export function getLocale(): LocaleCode {
  return locale;
}

type Value = string | number;

/** Picks the plural variant and returns the message split around placeholders. */
function template(key: string, params: Record<string, unknown> | undefined): string {
  const message = messages.get(key) ?? key;
  if (typeof message === "string") return message;
  const count = typeof params?.count === "number" ? params.count : 0;
  return message[pluralRules.select(count)] ?? message.other;
}

/**
 * Translates a message. `{name}` placeholders are filled from `params`. Only
 * `count` is number-formatted; format other numbers before passing them.
 */
export function t<K extends MessageKey>(
  key: K,
  ...[params]: ParamArgs<MessageAt<EnglishCatalog, K>, Value>
): string {
  const values = params as Record<string, Value> | undefined;
  const text = template(key, values);
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    if (value === undefined) return match;
    return name === "count" && typeof value === "number" ? countFormat.format(value) : String(value);
  });
}

/**
 * Like `t`, but placeholders accept elements, e.g.
 * `tRich("shortcuts.hint", { key: <kbd>?</kbd> })`.
 */
export function tRich<K extends MessageKey>(
  key: K,
  ...[params]: ParamArgs<MessageAt<EnglishCatalog, K>, ReactNode>
): ReactNode {
  const values = params as Record<string, ReactNode> | undefined;
  return template(key, values)
    .split(/\{(\w+)\}/)
    .map((part, index) => {
      if (index % 2 === 0) return part;
      const value = values?.[part];
      return createElement(
        Fragment,
        { key: index },
        part === "count" && typeof value === "number" ? countFormat.format(value) : value,
      );
    });
}

export function formatCount(value: number): string {
  return countFormat.format(value);
}
