const token = localStorage.getItem('rlf_token');
if (!token) { location.href = '/login.html'; }

const patternsEl = document.getElementById('patterns');
const dataList = document.getElementById('dataList');
const panelTitle = document.getElementById('panelTitle');
const dataInfo = document.getElementById('dataInfo');
const searchInput = document.getElementById('search');
const logoutBtn = document.getElementById('logoutBtn');

logoutBtn.addEventListener('click', ()=>{
  localStorage.removeItem('rlf_token');
  location.href = '/login.html';
});

let ws;
let activePattern = null;

async function fetchAllowed() {
  const resp = await fetch('/allowed-keys', { headers: { 'Authorization': 'Bearer ' + token } });
  if (!resp.ok) { localStorage.removeItem('rlf_token'); location.href = '/login.html'; }
  const data = await resp.json();
  renderPatterns(data.allowed || []);
}

function renderPatterns(list) {
  patternsEl.innerHTML = '';
  list.forEach(p => {
    const div = document.createElement('div');
    div.className = 'pattern-item';
    div.textContent = p;
    div.addEventListener('click', ()=> loadData(p));
    patternsEl.appendChild(div);
  });
}

async function loadData(pattern) {
  activePattern = pattern;
  panelTitle.textContent = 'Data: ' + pattern;
  dataInfo.textContent = 'Loading...';
  dataList.innerHTML = '';
  try {
    const resp = await fetch('/get-data?pattern=' + encodeURIComponent(pattern), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!resp.ok) { dataInfo.textContent = 'error loading data'; return; }
    const json = await resp.json();
    dataInfo.textContent = 'Count: ' + json.count;
    if (!json.data.length) { dataList.innerHTML = '<div class="muted small">No keys found</div>'; return; }
    json.data.forEach(item => {
      const el = document.createElement('div');
      el.className = 'data-card';
      el.innerHTML = '<strong>' + escapeHtml(item.key) + '</strong><div class="muted small">' + escapeHtml(String(item.value)) + '</div>';
      dataList.appendChild(el);
    });
  } catch (e) {
    dataInfo.textContent = 'network error';
  }
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// filter both pattern list and data list
searchInput.addEventListener('input', (e)=>{
  const term = e.target.value.toLowerCase();
  document.querySelectorAll('.pattern-item').forEach(el=>{
    el.style.display = el.textContent.toLowerCase().includes(term) ? '' : 'none';
  });
  // also filter data cards
  document.querySelectorAll('.data-card').forEach(el=>{
    el.style.display = el.textContent.toLowerCase().includes(term) ? '' : 'none';
  });
});

// websocket for live updates
function connectWS() {
  ws = new WebSocket((location.protocol === 'https:'? 'wss://' : 'ws://') + location.host + '/ws/redis?token=' + encodeURIComponent(token));
  ws.addEventListener('open', ()=> console.log('ws open'));

  const latestKeys = []; // { key, value }

function updateKeyUI(key, value) {
  const existingEl = [...dataList.children].find(el => el.querySelector('strong').textContent === key);
  
  if (existingEl) {
    // update existing
    existingEl.querySelector('.muted').textContent = value;
    // move to top
    dataList.prepend(existingEl);
    latestKeys.unshift(latestKeys.splice(latestKeys.findIndex(k => k.key === key), 1)[0]);
  } else {
    // new key
    const el = document.createElement('div');
    el.className = 'data-card';
    el.innerHTML = `<strong>${escapeHtml(key)}</strong><div class="muted small">${escapeHtml(String(value))}</div>`;
    dataList.prepend(el);
    latestKeys.unshift({ key, value });
    
    // keep only last 100
    if (latestKeys.length > 100) {
      const removed = latestKeys.pop();
      const removeEl = [...dataList.children].find(el => el.querySelector('strong').textContent === removed.key);
      if (removeEl) removeEl.remove();
    }
    dataInfo.textContent = 'Count: ' + dataList.children.length;
  }
}

// websocket message handler
ws.addEventListener('message', ev => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'update') {
      if (!activePattern) return;
      const patt = activePattern.replace(/\*/g, '.*');
      const re = new RegExp('^'+patt+'$');
      if (re.test(msg.key)) {
        updateKeyUI(msg.key, msg.value);
      }
    }
  } catch {}
});


  // ws.addEventListener('message', (ev)=>{
  //   try {
  //     const msg = JSON.parse(ev.data);
  //     if (msg.type === 'initial') {
  //       // ignore - we show list via allowed-keys
  //     } else if (msg.type === 'update') {
  //       // if update matches activePattern, refresh that key in UI or refetch
  //       if (!activePattern) return;
  //       // check if key matches activePattern (client side simple match)
  //       const patt = activePattern.replace(/\*/g, '.*');
  //       const re = new RegExp('^'+patt+'$');
  //       if (re.test(msg.key)) {
  //         // refresh UI: easiest is to refetch pattern
  //         loadData(activePattern);
  //       }
  //     }
  //   } catch (e){}
  // });
  ws.addEventListener('close', ()=> console.log('ws closed'));
}

// init
fetchAllowed();
connectWS();
