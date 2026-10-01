import { createElement, Fragment, type ReactNode } from "react";
import type { UiLocale } from "../lib/types";
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
  // Ordered as the Language setting lists them.
  en: { name: "English", load: async (): Promise<TranslationModule> => ({ default: {} }) },
  id: { name: "Bahasa Indonesia", load: () => import("./translations/id") },
  de: { name: "Deutsch", load: () => import("./translations/de") },
  es: { name: "Español", load: () => import("./translations/es") },
  fr: { name: "Français", load: () => import("./translations/fr") },
  it: { name: "Italiano", load: () => import("./translations/it") },
  pl: { name: "Polski", load: () => import("./translations/pl") },
  "pt-BR": { name: "Português (Brasil)", load: () => import("./translations/pt-BR") },
  vi: { name: "Tiếng Việt", load: () => import("./translations/vi") },
  tr: { name: "Türkçe", load: () => import("./translations/tr") },
  ru: { name: "Русский", load: () => import("./translations/ru") },
  uk: { name: "Українська", load: () => import("./translations/uk") },
  ar: { name: "العربية", load: () => import("./translations/ar") },
  fa: { name: "فارسی", load: () => import("./translations/fa") },
  "zh-CN": { name: "简体中文", load: () => import("./translations/zh-CN") },
} as const satisfies Record<string, { name: string; load: () => Promise<TranslationModule> }>;

export type LocaleCode = keyof typeof LOCALES;

export function isLocaleCode(value: string): value is LocaleCode {
  return Object.hasOwn(LOCALES, value);
}

const RTL_LANGUAGES = new Set(["ar", "fa"]);

/** Writing direction for a locale; Arabic and Persian mirror the layout. */
export function localeDirection(code: string): "rtl" | "ltr" {
  return RTL_LANGUAGES.has(new Intl.Locale(code).language) ? "rtl" : "ltr";
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
let formatLocale = "en";
let suggestion: LanguageSuggestion | null = null;

/** The system language offered at first start, with its pitch in that language. */
export type LanguageSuggestion = { code: LocaleCode; available: string; switchTo: string };
let pluralRules = new Intl.PluralRules("en");
let countFormat = new Intl.NumberFormat("en");

function canonical(tag: string | null): string | undefined {
  try {
    return tag ? Intl.getCanonicalLocales(tag)[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Regional formats follow the system unless the user reads a different
 * language, so an English UI on a Norwegian system keeps 24-hour clocks.
 */
function pickFormatLocale(code: LocaleCode, system: string | null): string {
  const systemTag = canonical(system);
  if (!systemTag) return code;
  const systemLanguage = new Intl.Locale(systemTag).language;
  return code === "en" || systemLanguage === new Intl.Locale(code).language ? systemTag : code;
}

/**
 * Arabic and Persian keep Latin digits, which read better beside 1080p, H264
 * and URLs. Arabic also keeps the Gregorian calendar (ar-SA defaults to Hijri).
 */
function withLatinDigits(tag: string): string {
  const { language } = new Intl.Locale(tag);
  if (!RTL_LANGUAGES.has(language)) return tag;
  return new Intl.Locale(tag, {
    numberingSystem: "latn",
    ...(language === "ar" ? { calendar: "gregory" } : {}),
  }).toString();
}

/**
 * Loads the launch locale. Call once before the first render; the language
 * stays fixed for the life of the window (changes apply after a restart).
 */
export async function initI18n({ locale: code, suggested, system }: UiLocale) {
  if (suggested && isLocaleCode(suggested)) {
    const { default: offered } = await LOCALES[suggested].load();
    const pitch = flatten(offered, new Map(english));
    suggestion = {
      code: suggested,
      available: pitch.get("languagePrompt.available") as string,
      switchTo: pitch.get("languagePrompt.switchTo") as string,
    };
  }
  if (!isLocaleCode(code)) return;
  const { default: translation } = await LOCALES[code].load();
  messages = flatten(translation, new Map(english));
  locale = code;
  formatLocale = withLatinDigits(pickFormatLocale(code, system));
  pluralRules = new Intl.PluralRules(code);
  countFormat = new Intl.NumberFormat(formatLocale);
  document.documentElement.lang = code;
  document.documentElement.dir = localeDirection(code);
}

/**
 * Wraps a value interpolated into running text so it keeps its own direction:
 * `isolate` lets the value pick (names, playlist data), `isolateLtr` forces
 * left to right (paths, URLs, regex). Use for plain strings such as `title`;
 * in JSX prefer `<bdi>` or `dir`.
 */
export function isolate(value: string): string {
  return `\u2068${value}\u2069`;
}

export function isolateLtr(value: string): string {
  return `\u2066${value}\u2069`;
}

/** The UI language. */
export function getLocale(): LocaleCode {
  return locale;
}

/** Set when the system language is supported and no language has been chosen yet. */
export function getLanguageSuggestion(): LanguageSuggestion | null {
  return suggestion;
}

/** The locale for `Intl` date, time and number formatting. */
export function getFormatLocale(): string {
  return formatLocale;
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
    return name === "count" && typeof value === "number"
      ? countFormat.format(value)
      : String(value);
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
