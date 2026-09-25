/**
 * Minimal single-page view: enqueue a job, poll one job's status, and work the
 * dead letter queue. Rendered entirely client-side with DOM APIs and
 * textContent, so nothing from a job payload is ever interpolated into markup.
 */
export function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Background Jobs - Dead Letter Queue</title>
<style>
  :root {
    --bg: #0f1117; --panel: #171a23; --line: #262b38; --text: #e6e8ee;
    --muted: #99a0b0; --accent: #5b8cff; --ok: #3fb950; --warn: #d29922;
    --bad: #f85149; --dead: #a371f7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { padding: 20px 24px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 4px; font-size: 18px; }
  header p { margin: 0; color: var(--muted); }
  main { padding: 24px; display: grid; gap: 24px; max-width: 1200px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; }
  h2 { margin: 0 0 12px; font-size: 14px; text-transform: uppercase;
       letter-spacing: .08em; color: var(--muted); }
  label { display: block; color: var(--muted); margin: 8px 0 4px; }
  input, textarea, select {
    width: 100%; padding: 8px 10px; background: #0d0f15; color: var(--text);
    border: 1px solid var(--line); border-radius: 5px; font: inherit;
  }
  textarea { min-height: 76px; resize: vertical; }
  button {
    padding: 8px 14px; background: var(--accent); color: #06080f; border: 0;
    border-radius: 5px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > div { flex: 1 1 180px; }
  pre { background: #0d0f15; border: 1px solid var(--line); border-radius: 5px;
        padding: 12px; overflow: auto; max-height: 340px; margin: 10px 0 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line);
           vertical-align: top; font-size: 13px; }
  th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  .status { padding: 1px 7px; border-radius: 10px; font-size: 12px; font-weight: 600; }
  .s-pending { background: #1f2937; color: #9ca3af; }
  .s-processing { background: #1e3a5f; color: #7cc0ff; }
  .s-succeeded { background: #12321f; color: var(--ok); }
  .s-failed { background: #3a2a12; color: var(--warn); }
  .s-dead { background: #2e1f47; color: var(--dead); }
  .msg { margin-top: 10px; padding: 8px 10px; border-radius: 5px; display: none; }
  .msg.ok { display: block; background: #12321f; color: var(--ok); }
  .msg.err { display: block; background: #3a1a1a; color: var(--bad); }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 14px 0; }
</style>
</head>
<body>
<header>
  <h1>Background Jobs</h1>
  <p>Enqueue work, poll a job, and work the dead letter queue.</p>
</header>
<main>

<section>
  <h2>Enqueue a job</h2>
  <div class="row">
    <div>
      <label for="f-type">type</label>
      <select id="f-type">
        <option>send_email</option>
        <option>generate_pdf</option>
        <option>charge_card</option>
        <option>quick_work</option>
        <option>slow_work</option>
        <option>always_fails</option>
      </select>
    </div>
    <div>
      <label for="f-key">idempotency_key</label>
      <input id="f-key" placeholder="user_alice_welcome">
    </div>
  </div>
  <label for="f-payload">payload (JSON)</label>
  <textarea id="f-payload">{"to":"user@example.com","subject":"Welcome","template":"welcome"}</textarea>
  <div class="row" style="margin-top:10px">
    <div style="flex:0 0 auto"><button id="btn-enqueue">Enqueue</button></div>
  </div>
  <div class="msg" id="enq-msg"></div>
  <pre id="enq-out" style="display:none"></pre>
</section>

<section>
  <h2>Job status</h2>
  <div class="row">
    <div>
      <label for="f-jobid">job_id</label>
      <input id="f-jobid" placeholder="job_...">
    </div>
    <div style="flex:0 0 auto">
      <button id="btn-status" class="ghost">Look up</button>
      <button id="btn-poll" class="ghost">Poll every 1s</button>
    </div>
  </div>
  <pre id="status-out" style="display:none"></pre>
</section>

<section>
  <h2>Dead letter queue</h2>
  <div class="row">
    <div>
      <label for="f-type-filter">filter by type</label>
      <input id="f-type-filter" placeholder="leave blank for all">
    </div>
    <div style="flex:0 0 auto"><button id="btn-dead" class="ghost">Refresh</button></div>
    <div style="flex:0 0 auto"><span class="muted" id="dead-meta"></span></div>
  </div>
  <div id="dead-body"></div>
</section>

</main>
<script>
const $ = (id) => document.getElementById(id);
const show = (el, text, kind) => {
  el.textContent = text;
  el.className = 'msg ' + kind;
};

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

$('btn-enqueue').addEventListener('click', async () => {
  let payload;
  try {
    payload = JSON.parse($('f-payload').value);
  } catch (e) {
    show($('enq-msg'), 'Payload is not valid JSON: ' + e.message, 'err');
    return;
  }
  const { status, body } = await api('/api/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: $('f-type').value,
      payload,
      idempotency_key: $('f-key').value,
    }),
  });
  if (status === 202) {
    show($('enq-msg'), 'Accepted (202). Job id: ' + body.job_id, 'ok');
    $('f-jobid').value = body.job_id;
    $('enq-out').style.display = 'block';
    $('enq-out').textContent = JSON.stringify(body, null, 2);
  } else {
    show($('enq-msg'), status + ' ' + (body && body.error ? body.error.code + ': ' + body.error.message : ''), 'err');
  }
});

let pollTimer = null;
async function pollStatus() {
  const id = $('f-jobid').value.trim();
  if (!id) return;
  const { status, body } = await api('/api/v1/jobs/' + encodeURIComponent(id));
  $('status-out').style.display = 'block';
  if (status !== 200) {
    $('status-out').textContent = JSON.stringify(body, null, 2);
    return;
  }
  const badge = ' [' + body.status.toUpperCase() + ']';
  $('status-out').textContent =
    'status' + badge + '  attempts ' + body.attempts + '/' + body.max_attempts + '\\n' +
    'last_error  ' + (body.last_error || '-') + '\\n' +
    'run_at      ' + body.run_at + '\\n' +
    'started_at  ' + (body.started_at || '-') + '\\n' +
    'finished_at ' + (body.finished_at || '-') + '\\n\\n' +
    JSON.stringify(body, null, 2);
  if (body.status === 'succeeded' || body.status === 'dead') {
    clearInterval(pollTimer);
    pollTimer = null;
    $('btn-poll').textContent = 'Poll every 1s';
  }
}
$('btn-status').addEventListener('click', pollStatus);
$('btn-poll').addEventListener('click', () => {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; $('btn-poll').textContent = 'Poll every 1s'; return; }
  $('btn-poll').textContent = 'Stop polling';
  pollTimer = setInterval(pollStatus, 1000);
  pollStatus();
});

function cell(row, value, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (value instanceof Node) td.appendChild(value);
  else td.textContent = value === null || value === undefined ? '-' : String(value);
  row.appendChild(td);
  return td;
}

async function loadDead() {
  const host = $('dead-body');
  host.textContent = '';
  const typeFilter = $('f-type-filter').value.trim();
  const params = new URLSearchParams({ limit: '50' });
  const { status, body } = await api('/api/v1/jobs/dead?' + params.toString());

  if (status !== 200) {
    host.textContent = 'Failed to load dead letters: ' + status;
    return;
  }
  $('dead-meta').textContent = 'total ' + body.meta.total +
    ' | showing ' + body.jobs.length +
    ' | has_more ' + body.meta.has_more;

  const rows = typeFilter
    ? body.jobs.filter((j) => j.type === typeFilter)
    : body.jobs;

  if (rows.length === 0) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = body.meta.total === 0
      ? 'No dead jobs. Nothing needs a human.'
      : 'No dead jobs of type "' + typeFilter + '".';
    host.appendChild(p);
    return;
  }

  const table = document.createElement('table');
  const head = document.createElement('tr');
  ['id', 'type', 'attempts', 'last_error', 'payload', 'created', 'finished', ''].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  });
  table.appendChild(head);

  rows.forEach((job) => {
    const tr = document.createElement('tr');

    const idCell = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = job.id;
    idCell.appendChild(code);
    tr.appendChild(idCell);

    cell(tr, job.type);

    const att = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'status s-dead';
    badge.textContent = job.attempts + '/' + job.max_attempts;
    att.appendChild(badge);
    tr.appendChild(att);

    cell(tr, job.last_error, 'muted');
    cell(tr, JSON.stringify(job.payload), 'muted');
    cell(tr, (job.created_at || '').slice(0, 19).replace('T', ' '), 'muted');
    cell(tr, (job.finished_at || '').slice(0, 19).replace('T', ' '), 'muted');

    const actions = document.createElement('td');
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      retry.textContent = 'Retrying...';
      const res = await api('/api/v1/jobs/' + encodeURIComponent(job.id) + '/retry', { method: 'POST' });
      if (res.status === 202) {
        retry.textContent = 'Requeued';
        loadDead();
      } else {
        retry.disabled = false;
        retry.textContent = 'Retry';
        const msg = res.body && res.body.error ? res.body.error.message : String(res.status);
        alert('Retry failed: ' + msg);
      }
    });
    actions.appendChild(retry);
    tr.appendChild(actions);

    table.appendChild(tr);
  });

  host.appendChild(table);
}
$('btn-dead').addEventListener('click', loadDead);
loadDead();
</script>
</body>
</html>`;
}
