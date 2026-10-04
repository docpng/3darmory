document.documentElement.classList.add('js');

document.addEventListener('DOMContentLoaded', () => {
  // Mobile navigation
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  // Dismissable flash messages
  document.querySelectorAll('[data-dismiss]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('.flash')?.remove());
  });

  // Auto-submit selects / quantity inputs
  document.querySelectorAll('[data-autosubmit]').forEach((el) => {
    el.addEventListener('change', () => el.form?.requestSubmit());
  });

  // Quantity stepper on the product page
  document.querySelectorAll('[data-qty-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = btn.parentElement.querySelector('input');
      const min = Number(input.min) || 1;
      const max = Number(input.max) || 99;
      const next = (Number(input.value) || min) + Number(btn.dataset.qtyStep);
      input.value = String(Math.min(max, Math.max(min, next)));
    });
  });

  // Confirmation prompts for destructive actions
  document.addEventListener('submit', (event) => {
    const message = event.submitter?.dataset.confirm || event.target.dataset.confirm;
    if (message && !window.confirm(message)) event.preventDefault();
  });

  // Admin: live image preview
  const imageInput = document.querySelector('[data-image-input]');
  const preview = document.querySelector('[data-image-preview]');
  if (imageInput && preview) {
    imageInput.addEventListener('change', () => {
      const file = imageInput.files?.[0];
      if (!file) return;
      preview.src = URL.createObjectURL(file);
      preview.classList.remove('is-placeholder');
    });
  }

  // Admin: show stock field only when tracking stock
  document.querySelectorAll('[data-toggle-target]').forEach((checkbox) => {
    const target = document.querySelector(checkbox.dataset.toggleTarget);
    if (!target) return;
    const sync = () => {
      target.hidden = !checkbox.checked;
    };
    checkbox.addEventListener('change', sync);
    sync();
  });
});
