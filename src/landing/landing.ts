// Landing page behaviour: the copy button on the install command.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  const target = document.getElementById(button.dataset.copy ?? '');
  const label = button.textContent;
  button.addEventListener('click', async () => {
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent?.trim() ?? '');
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => { button.textContent = label; }, 1800);
  });
}

// Cookieless page views and the clicks marked data-umami-event, only in builds that set
// VITE_UMAMI_WEBSITE_ID (the public site). Local builds and the app at /app never load it.
const env = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env;
if (env.VITE_UMAMI_WEBSITE_ID) {
  const script = document.createElement('script');
  script.defer = true;
  script.src = env.VITE_UMAMI_SCRIPT_URL || 'https://cloud.umami.is/script.js';
  script.dataset.websiteId = env.VITE_UMAMI_WEBSITE_ID;
  script.dataset.doNotTrack = 'true';
  if (env.VITE_UMAMI_DOMAINS) script.dataset.domains = env.VITE_UMAMI_DOMAINS;
  document.head.append(script);
}
