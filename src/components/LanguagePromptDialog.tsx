import { Globe } from "lucide-react";
import { useState } from "react";
import { getLocale, type LanguageSuggestion, LOCALES, type LocaleCode, t } from "../i18n";
import { logger } from "../lib/logger";
import { restartApp } from "../lib/tauri";
import { useAppStore } from "../store";

const englishNames = new Intl.DisplayNames(["en"], { type: "language" });

/** "Simplified Chinese" reads better than "Chinese (China)". */
function englishName(code: LocaleCode): string {
  return englishNames.of(code === "zh-CN" ? "zh-Hans" : code) ?? code;
}

/**
 * Offers the system language on first start. The pitch and switch button are
 * in that language; everything else stays English for whoever keeps English.
 */
export default function LanguagePromptDialog({ suggestion }: { suggestion: LanguageSuggestion }) {
  const [saving, setSaving] = useState(false);
  const others = Object.entries(LOCALES).filter(
    ([code]) => code !== "en" && code !== suggestion.code,
  );

  const choose = async (language: LocaleCode) => {
    setSaving(true);
    try {
      const { settings, saveSettings } = useAppStore.getState();
      await saveSettings({ ...settings, language });
      if (language !== getLocale()) await restartApp();
    } catch (error) {
      logger.error("[i18n] Failed to save the language choice:", error);
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="language-prompt-title"
    >
      <div className="absolute inset-0 bg-black/45" />
      <div className="relative w-full max-w-sm rounded-2xl border border-border-app bg-overlay shadow-2xl p-6 flex flex-col items-center text-center gap-1.5">
        <Globe className="w-7 h-7 text-blue-400" />
        <h2
          id="language-prompt-title"
          lang={suggestion.code}
          className="mt-1.5 text-[16px] font-semibold text-text-primary"
        >
          {suggestion.available}
        </h2>
        <p className="mb-3 text-[13px] text-text-secondary">
          {t("languagePrompt.systemLanguage", { language: englishName(suggestion.code) })}
        </p>
        <div className="w-full flex flex-col gap-2">
          <button
            type="button"
            lang={suggestion.code}
            disabled={saving}
            // biome-ignore lint/a11y/noAutofocus: the dialog needs an answer before the app is usable.
            autoFocus
            onClick={() => void choose(suggestion.code)}
            className="w-full px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-[13px] font-medium disabled:opacity-50"
          >
            {suggestion.switchTo}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void choose("en")}
            className="w-full px-3 py-2 rounded-md border border-border-app bg-btn hover:bg-btn-hover text-[13px] disabled:opacity-50"
          >
            {t("languagePrompt.keepEnglish")}
          </button>
          <select
            value=""
            disabled={saving}
            aria-label={t("languagePrompt.otherLanguage")}
            onChange={(event) => void choose(event.target.value as LocaleCode)}
            className="native-field w-full px-3 py-2 rounded-md border border-border-app bg-input text-[13px] text-text-primary disabled:opacity-50"
          >
            <option value="" disabled>
              {t("languagePrompt.otherLanguage")}
            </option>
            {others.map(([code, { name }]) => (
              <option key={code} value={code} lang={code}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-2 text-[11.5px] text-text-tertiary">{t("languagePrompt.changeLater")}</p>
      </div>
    </div>
  );
}
