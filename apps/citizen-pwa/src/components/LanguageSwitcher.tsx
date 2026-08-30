import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vayusetu/ui-components';
import { SUPPORTED_LANGUAGES, i18nCodeToBcp47 } from '../i18n';
import { useAuth } from '../hooks/useAuth';

/**
 * Product Spec: "single persistent control, stored on User.preferredLanguage,
 * no re-login required." The i18next switch is instant and local; the
 * PATCH /users/me call is fire-and-forget best-effort (a citizen who
 * hasn't registered yet — i.e. hasn't submitted a report — simply doesn't
 * have a User doc to patch, and that's fine, ensureRegistered() will pick
 * up the current i18n language the first time it does register).
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  const { user, updateProfile } = useAuth();

  async function handleChange(code: string) {
    await i18n.changeLanguage(code);
    document.documentElement.lang = code;
    if (user) {
      updateProfile({ preferredLanguage: i18nCodeToBcp47(code) }).catch(() => {
        // best-effort — the local UI language has already switched
      });
    }
  }

  return (
    <Select value={i18n.resolvedLanguage} onValueChange={handleChange}>
      <SelectTrigger className={className ?? 'h-10 w-auto gap-2 border-none bg-transparent px-2 shadow-none'}>
        <Languages className="h-4 w-4 text-brand-700" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <SelectItem key={lang.code} value={lang.code}>
            {lang.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
