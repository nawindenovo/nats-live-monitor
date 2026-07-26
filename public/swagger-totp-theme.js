(function () {
  var KEY = 'totp-swagger-theme';

  function apply(theme) {
    var next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    document.documentElement.style.colorScheme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch (_) {}
    var btn = document.getElementById('totp-theme-toggle');
    if (btn) {
      btn.textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
      btn.setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
  }

  function current() {
    try {
      return localStorage.getItem(KEY) || 'light';
    } catch (_) {
      return 'light';
    }
  }

  apply(current());

  function ensureButton() {
    if (document.getElementById('totp-theme-toggle')) return;
    var btn = document.createElement('button');
    btn.id = 'totp-theme-toggle';
    btn.type = 'button';
    btn.textContent = current() === 'dark' ? 'Light mode' : 'Dark mode';
    btn.addEventListener('click', function () {
      apply(current() === 'dark' ? 'light' : 'dark');
    });
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureButton);
  } else {
    ensureButton();
  }
})();
