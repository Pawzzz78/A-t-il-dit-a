// Renseigne l'éditeur du site à partir de la configuration du serveur (variables LEGAL_*). Aucun innerHTML.
fetch('/api/legal')
  .then((r) => r.json())
  .then((d) => {
    for (const el of document.querySelectorAll('[data-field]')) {
      const value = d[el.dataset.field];
      if (!value) continue;
      el.hidden = false;
      el.replaceChildren();
      if (el.dataset.field === 'email') {
        const a = document.createElement('a');
        a.href = `mailto:${value}`;
        a.textContent = value;
        el.append(a);
      } else el.textContent = value;
    }
    // adresse : n'apparaît que si elle est renseignée (un particulier peut ne donner que celle de l'hébergeur)
    const addr = document.querySelector('[data-field="address"]');
    if (addr && !d.address) {
      addr.hidden = true;
      addr.previousElementSibling.hidden = true;
    }
  })
  .catch(() => {});
