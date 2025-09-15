const loginBtn = document.getElementById('loginBtn');
const accessKeyInput = document.getElementById('accessKey');
const secretInput = document.getElementById('secret');
const loginError = document.getElementById('loginError');

loginBtn.addEventListener('click', async ()=>{
  loginError.textContent = '';
  const accessKey = accessKeyInput.value.trim();
  const secret = secretInput.value.trim();
  if (!accessKey || !secret) { loginError.textContent = 'enter both fields'; return; }
  try {
    const resp = await fetch('/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ accessKey, secret })
    });
    const data = await resp.json();
    if (!resp.ok) { loginError.textContent = data.error || 'login failed'; return; }
    localStorage.setItem('rlf_token', data.token);
    // go to viewer
    location.href = '/viewer.html';
  } catch (e) {
    loginError.textContent = 'network error';
  }
});

// auto-redirect if already logged in
if (localStorage.getItem('rlf_token')) {
  location.href = '/viewer.html';
}
