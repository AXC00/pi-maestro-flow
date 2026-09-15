export * from "./events.ts";
export * from "./provider.ts";
export * from "./schema.ts";

// The keyboard-shortcut helpers live in the shared UI primitives module so
// Cockpit, Flow, and Teammate all import the same implementation. Keep the
// rest of the i18n surface unchanged.
export {
	SUPPORTED_SETTINGS_LOCALES,
	checkCatalogCompleteness,
	createSettingsTranslator,
	detectSystemSettingsLocale,
	interpolateTranslation,
	mergeTranslationCatalogs,
	normalizeSettingsLocale,
	resolveSettingsLocale,
	translateSettings,
	type CatalogCompletenessIssue,
	type CatalogCompletenessIssueKind,
	type CatalogCompletenessResult,
	type MissingTranslation,
	type MissingTranslationCallback,
	type SettingsTranslator,
	type SettingsTranslatorOptions,
	type SupportedSettingsLocale,
	type SystemSettingsLocaleOptions,
	type TranslationCatalog,
	type TranslationCatalogs,
	type TranslationParams,
} from "./i18n.ts";

export { altKey, altLabel } from "../../ui/key-labels.ts";
