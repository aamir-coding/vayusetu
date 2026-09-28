/* global localStorage, matchMedia, document */
// Applies the saved light/dark theme before first paint (no white flash).
// Same key and rule as packages/ui-components/src/lib/theme.ts.
(function () {
  try {
    var p = localStorage.getItem('vayusetu:theme');
    var d = p === 'dark' || ((!p || p === 'system') && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', d);
    document.documentElement.style.colorScheme = d ? 'dark' : 'light';
  } catch {
    /* storage blocked: keep the default */
  }
})();
