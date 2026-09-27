import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vayusetu/ui-components';
import { SUPPORTED_LANGUAGES } from '../i18n';

/** Per-browser choice (officials' profiles are provisioned out-of-band, so
 *  there is no User doc to store it on); the detector caches it locally. */
export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  return (
    <Select
      value={i18n.resolvedLanguage}
      onValueChange={(code) => {
        void i18n.changeLanguage(code);
        document.documentElement.lang = code;
      }}
    >
      <SelectTrigger className="h-9 w-full gap-2 text-xs" aria-label={t('nav.language')}>
        <Languages className="h-3.5 w-3.5 text-brand-700" aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SUPPORTED_LANGUAGES.map((l) => (
          <SelectItem key={l.code} value={l.code}>
            {l.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
