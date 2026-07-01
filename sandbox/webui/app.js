/* ── Enterprise Sandbox WebUI · app.js ──────────────────────────────── */

const API = ''; // Same-origin (sandbox service serves both API and webui)

// ─── Tab Switching ─────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.getElementById(`panel-${tab.dataset.tab}`);
    if (panel) panel.classList.add('active');
  });
});

// ─── API Helpers ───────────────────────────────────────────────────
async function api(path, options = {}) {
  const resp = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status}: ${text || resp.statusText}`);
  return text ? JSON.parse(text) : null;
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text ?? '';
  return d.innerHTML;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ─── Dashboard ─────────────────────────────────────────────────────
async function refreshDashboard() {
  try {
    const h = await api('/health');
    document.getElementById('healthDot').className = 'status-dot online';
    document.getElementById('healthText').textContent = `online · ${h.status}`;
    document.getElementById('version').textContent = `v${h.version}`;
    document.getElementById('statSessions').textContent = h.sessions_active;
    document.getElementById('statExecutions').textContent = h.executions_total;
    document.getElementById('statDisk').textContent = `${h.disk_free_mb.toFixed(0)} MB`;
    document.getElementById('statStatus').textContent = h.status.toUpperCase();
    // Runtimes
    for (const [name, ok] of Object.entries(h.runtimes)) {
      const el = document.querySelector(`[data-runtime="${name}"]`);
      if (el) { el.className = `runtime-badge ${ok ? 'online' : 'offline'}`; }
    }
  } catch (e) {
    document.getElementById('healthDot').className = 'status-dot offline';
    document.getElementById('healthText').textContent = `offline · ${e.message}`;
  }
}

// ─── Sessions ──────────────────────────────────────────────────────
async function refreshSessions() {
  const tbody = document.getElementById('sessionsBody');
  try {
    // We fetch all sessions via the health endpoint's active count, but
    // to list individual sessions we need the session manager's list.
    // For now, show health info and the create-flow.
    // The sessions are listed individually when created.
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Use "New Session" to create one.</td></tr>';
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
}

document.getElementById('btnCreateSession').addEventListener('click', async () => {
  try {
    const session = await api('/sessions', {
      method: 'POST',
      body: JSON.stringify({ caller_id: 'webui' }),
    });
    addSessionRow(session);
    updateSessionSelects();
    addActivity('Created session', session.session_id, 'ok');
    // Show success
    const tbody = document.getElementById('sessionsBody');
    if (tbody.querySelector('.empty')) tbody.innerHTML = '';
    addSessionRow(session);
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
});

function addSessionRow(s) {
  const tbody = document.getElementById('sessionsBody');
  const tr = document.createElement('tr');
  tr.dataset.sid = s.session_id;
  tr.innerHTML = `
    <td title="${escapeHtml(s.session_id)}">${escapeHtml(s.session_id.slice(0, 20))}…</td>
    <td><span class="status-badge status-${s.status}">${escapeHtml(s.status)}</span></td>
    <td>${escapeHtml(s.caller_id)}</td>
    <td>${escapeHtml(s.user_id || '—')}</td>
    <td>${timeAgo(s.created_at)}</td>
    <td><button class="btn-small btn-danger" data-action="delete-session" data-sid="${s.session_id}">Delete</button></td>
  `;
  tbody.prepend(tr);

  tr.querySelector('[data-action="delete-session"]').addEventListener('click', async () => {
    try {
      await api(`/sessions/${s.session_id}`, { method: 'DELETE' });
      tr.remove();
      updateSessionSelects();
      addActivity('Deleted session', s.session_id, 'warn');
    } catch (e) { alert(`Failed: ${e.message}`); }
  });
}

// ─── Session select helpers ────────────────────────────────────────
async function updateSessionSelects() {
  // We can't list all sessions from the API directly (no list endpoint),
  // so we populate from the table rows.
  const sids = [...document.querySelectorAll('#sessionsBody tr[data-sid]')].map(
    tr => tr.dataset.sid
  );
  for (const id of ['execSessionSelect', 'fileSessionSelect', 'artifactSessionSelect']) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = '<option value="">— select a session —</option>';
    for (const sid of sids) {
      const opt = document.createElement('option');
      opt.value = sid;
      opt.textContent = sid.slice(0, 20) + '…';
      if (sid === current) opt.selected = true;
      sel.appendChild(opt);
    }
  }
}

// ─── Activity Log ──────────────────────────────────────────────────
function addActivity(msg, detail, type = 'ok') {
  const log = document.getElementById('activityLog');
  const placeholder = log.querySelector('.placeholder');
  if (placeholder) placeholder.remove();
  const entry = document.createElement('div');
  entry.className = 'activity-entry';
  const now = new Date().toLocaleTimeString();
  entry.innerHTML = `
    <span class="activity-time">${now}</span>
    <span class="activity-msg">${escapeHtml(msg)} <code>${escapeHtml(detail)}</code></span>
    <span class="activity-badge badge-${type}">${type}</span>
  `;
  log.prepend(entry);
  // Keep last 50
  while (log.children.length > 50) log.lastChild.remove();
}

// ─── Executions ────────────────────────────────────────────────────
document.getElementById('btnRunExec').addEventListener('click', async () => {
  const sid = document.getElementById('execSessionSelect').value;
  if (!sid) return alert('Select a session first.');
  const type = document.querySelector('input[name="execType"]:checked').value;
  const code = document.getElementById('execCode').value.trim();
  if (!code) return alert('Enter code or command.');
  const timeout = parseInt(document.getElementById('execTimeout').value) || undefined;

  const btn = document.getElementById('btnRunExec');
  btn.disabled = true; btn.textContent = '⏳ Running…';
  document.getElementById('execResult').style.display = 'none';

  try {
    const endpoint = type === 'python' ? 'python' : 'command';
    const body = type === 'python' ? { code } : { command: code };
    if (timeout) body.timeout = timeout;

    const result = await api(`/sessions/${sid}/executions/${endpoint}`, {
      method: 'POST', body: JSON.stringify(body),
    });

    document.getElementById('execStdout').textContent = result.stdout_preview || '(no output)';
    document.getElementById('execStderr').textContent = result.stderr_preview || '';
    document.getElementById('execMeta').innerHTML = `
      <span>exit: <strong>${result.exit_code ?? '—'}</strong></span>
      <span>duration: <strong>${result.duration_ms?.toFixed(0) ?? '—'}ms</strong></span>
      <span>truncated: <strong>${result.truncated ? 'yes' : 'no'}</strong></span>
      <span>status: <strong class="status-${result.status}">${result.status}</strong></span>
    `;
    document.getElementById('execResult').style.display = 'block';
    addActivity(`Ran ${type}`, `${sid.slice(0, 16)}… → ${result.status}`, result.exit_code === 0 ? 'ok' : 'err');
  } catch (e) {
    document.getElementById('execStdout').textContent = '';
    document.getElementById('execStderr').textContent = `Error: ${e.message}`;
    document.getElementById('execMeta').innerHTML = '';
    document.getElementById('execResult').style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = '▶ Run';
  }
});

document.getElementById('btnClearExec').addEventListener('click', () => {
  document.getElementById('execResult').style.display = 'none';
  document.getElementById('execCode').value = '';
});

// ─── Files ─────────────────────────────────────────────────────────
document.getElementById('btnListFiles').addEventListener('click', async () => {
  const sid = document.getElementById('fileSessionSelect').value;
  if (!sid) return alert('Select a session first.');
  const path = document.getElementById('filePath').value || '.';

  try {
    const data = await api(`/sessions/${sid}/files?path=${encodeURIComponent(path)}`);
    const container = document.getElementById('fileList');
    if (!data.files || data.files.length === 0) {
      container.innerHTML = '<p class="placeholder">(empty directory)</p>';
      return;
    }
    container.innerHTML = '';
    // .. parent link
    if (path !== '.') {
      const parent = path.split('/').slice(0, -1).join('/') || '.';
      const item = document.createElement('div');
      item.className = 'file-item dir';
      item.textContent = '📁 ..';
      item.addEventListener('click', () => { document.getElementById('filePath').value = parent; document.getElementById('btnListFiles').click(); });
      container.appendChild(item);
    }
    for (const f of data.files) {
      const item = document.createElement('div');
      item.className = `file-item ${f.is_dir ? 'dir' : ''}`;
      item.innerHTML = `${f.is_dir ? '📁' : '📄'} ${escapeHtml(f.name)} <span class="f-size">${f.is_dir ? '—' : formatSize(f.size)}</span>`;
      if (f.is_dir) {
        item.addEventListener('click', () => {
          document.getElementById('filePath').value = f.path;
          document.getElementById('btnListFiles').click();
        });
      } else {
        item.addEventListener('click', () => {
          document.getElementById('fileReadPath').value = f.path;
          document.getElementById('btnReadFile').click();
        });
      }
      container.appendChild(item);
    }
    addActivity('Listed files', `${sid.slice(0, 16)}… ${path}`, 'ok');
  } catch (e) {
    document.getElementById('fileList').innerHTML = `<p class="placeholder">Error: ${escapeHtml(e.message)}</p>`;
  }
});

document.getElementById('btnReadFile').addEventListener('click', async () => {
  const sid = document.getElementById('fileSessionSelect').value;
  if (!sid) return alert('Select a session first.');
  const path = document.getElementById('fileReadPath').value.trim();
  if (!path) return;

  try {
    const data = await api(`/sessions/${sid}/files/read?path=${encodeURIComponent(path)}`);
    document.getElementById('filePreview').textContent = data.content || '(empty file)';
    addActivity('Read file', path, 'ok');
  } catch (e) {
    document.getElementById('filePreview').textContent = `Error: ${e.message}`;
  }
});

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}

// ─── Artifacts ─────────────────────────────────────────────────────
document.getElementById('btnRefreshArtifacts').addEventListener('click', async () => {
  const sid = document.getElementById('artifactSessionSelect').value;
  if (!sid) return;
  try {
    const data = await api(`/sessions/${sid}/artifacts`);
    const tbody = document.getElementById('artifactsBody');
    tbody.innerHTML = '';
    if (data.artifacts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">No artifacts in this session.</td></tr>';
      return;
    }
    for (const a of data.artifacts) {
      const tr = document.createElement('tr');
      const dlUrl = `/sessions/${sid}/artifacts/${a.artifact_id}/download`;
      tr.innerHTML = `
        <td title="${escapeHtml(a.artifact_id)}">${escapeHtml(a.artifact_id.slice(0, 16))}…</td>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.path)}</td>
        <td>${escapeHtml(a.mime_type)}</td>
        <td>${formatSize(a.size)}</td>
        <td><a href="${dlUrl}" class="btn-small" download>⬇ Download</a></td>
      `;
      tbody.appendChild(tr);
    }
  } catch (e) {
    document.getElementById('artifactsBody').innerHTML = `<tr><td colspan="6" class="empty">Error: ${escapeHtml(e.message)}</td></tr>`;
  }
});

// ─── Settings ──────────────────────────────────────────────────────
async function refreshSettings() {
  try {
    const h = await api('/health');
    const grid = document.getElementById('settingsDisplay');
    // Show what we can infer about configuration
    const items = [
      ['Version', h.version],
      ['Sessions Active', h.sessions_active],
      ['Executions Total', h.executions_total],
      ['Disk Free', `${h.disk_free_mb.toFixed(0)} MB`],
      ['Python Available', h.runtimes?.python ? '✅' : '❌'],
      ['Bash Available', h.runtimes?.bash ? '✅' : '❌'],
      ['Node.js Available', h.runtimes?.node ? '✅' : '❌'],
    ];
    grid.innerHTML = items.map(([k, v]) =>
      `<div class="settings-item"><div class="key">${escapeHtml(k)}</div><div class="value">${escapeHtml(String(v))}</div></div>`
    ).join('');
  } catch (e) {
    document.getElementById('settingsDisplay').innerHTML = `<p class="placeholder">Could not load: ${escapeHtml(e.message)}</p>`;
  }
}

// ─── Auto-refresh loop ─────────────────────────────────────────────
async function refreshAll() {
  await refreshDashboard();
  // Refresh dependent views if their selects have values
  for (const id of ['artifactSessionSelect']) {
    const sel = document.getElementById(id);
    if (sel && sel.value) {
      if (id === 'artifactSessionSelect') document.getElementById('btnRefreshArtifacts').click();
    }
  }
}

// Start refresh loop
refreshAll();
setInterval(refreshAll, 5000); // every 5 seconds

// Initial session select update
setTimeout(updateSessionSelects, 1000);
