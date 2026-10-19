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
