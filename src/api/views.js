/**
 * Single-page operator console for the job queue: work the dead letter queue,
 * enqueue a job, and follow one job's progress.
 *
 * Constraints this design holds itself to:
 *
 * - Nothing from a job payload is ever interpolated into markup. Every value
 *   that originates from the database is written with textContent, so a payload
 *   containing markup is displayed, not executed.
 * - Status is never encoded in colour alone. Each state carries its own word.
 * - Every interactive element is reachable and visibly focused by keyboard.
 * - Async results are announced, not just drawn.
 *
 * The dead letter queue is the first tab because it is the only surface here
 * that represents work a human has to deal with.
 */

const TABS = [
  { id: 'dead', label: 'Dead letters' },
  { id: 'enqueue', label: 'Enqueue' },
  { id: 'status', label: 'Job status' },
];

export function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Queue Console</title>
<style>
  /* ---------------------------------------------------------------------
     Tokens. Dark surface, but every text/background pair below is at or
     above WCAG AA for its size, which the previous all-monospace version
     was not.
     --------------------------------------------------------------------- */
  :root {
    /* Palette values are copied from design-tokens.tokens.json (Figma Tokens
       Studio export). Each line names the token it came from.

       The token set has no surface or status roles, so neutrals carry the
       surfaces and the primary/tertiary/error families carry accent and
       failure. Success and warning have no counterpart in the token set and
       are the only colours here that are not token values. */
    --bg:            #000000;  /* nuetral0   */
    --surface:       #18191b;  /* nuetral10  */
    --surface-2:     #303236;  /* nuetral20  */
    --surface-3:     #55585e;  /* nuetral30  */
    --line:          #303236;  /* nuetral20  */
    --line-strong:   #61646b;  /* nuetral40  */

    --text:          #fafafa;  /* nuetral98  */
    --text-muted:    #d9dbdd;  /* nuetral80  */
    --text-faint:    #aeb1b7;  /* nuetral70  */

    /* Material 3 splits the accent in two: a light tone for text, outlines and
       icons on the dark surface, and a deep tone for filled controls so white
       ink on top of it clears AA. One tone cannot do both. */
    --accent:          #83a1fc;  /* primary70 - text, focus ring, icons */
    --accent-solid:    #0742f8;  /* primary50 - filled buttons */
    --accent-solid-hover: #0635c6;  /* primary40 */
    --accent-ink:      #ffffff;  /* primary100 */
    --accent-tint:     #4b76fa0c;

    --ok:            #5ed36a;  /* no token equivalent */
    --ok-bg:         #10261a;
    --warn:          #e8b53c;  /* no token equivalent */
    --warn-bg:       #2a2211;
    --bad:           #f99f9f;  /* error80 (dark role) */
    --bad-bg:        #3a0303;  /* error10 */
    --bad-line:      #7d0808;  /* error20 */
    --ok-line:       #1d4529;
    --warn-line:     #4a3c15;
    --info:          #83a1fc;  /* primary70  */
    --info-bg:       #031a63;  /* primary20  */
    --info-line:     #042895;  /* primary30  */
    --idle:          #aeb1b7;  /* nuetral70  */
    --idle-bg:       #303236;  /* nuetral20  */
    --idle-line:     #55585e;  /* nuetral30  */

    --r-sm: 6px;
    --r-md: 10px;
    --r-lg: 14px;

    --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px;
    --s-5: 24px; --s-6: 32px; --s-7: 48px;

    --shadow: 0 1px 2px #0000006b, 0 8px 24px #00000047;

    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace;

    --dur: 140ms;
  }

  * { box-sizing: border-box; }

  html { -webkit-text-size-adjust: 100%; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 var(--sans);
    -webkit-font-smoothing: antialiased;
  }

  /* Visible focus everywhere. This was entirely absent before, which made
     the console unusable without a mouse. */
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--r-sm);
  }
  :focus:not(:focus-visible) { outline: none; }

  .sr-only {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  .skip-link {
    position: absolute; left: var(--s-3); top: -60px;
    background: var(--accent); color: var(--accent-ink);
    padding: var(--s-2) var(--s-4); border-radius: var(--r-sm);
    font-weight: 600; text-decoration: none; z-index: 20;
    transition: top var(--dur) ease;
  }
  .skip-link:focus { top: var(--s-3); }

  /* ---------------------------------------------------------------- header */
  .masthead {
    border-bottom: 1px solid var(--line);
    background: linear-gradient(180deg, var(--surface) 0%, var(--bg) 100%);
  }
  .masthead-inner {
    max-width: 1240px; margin: 0 auto;
    padding: var(--s-5) var(--s-5) 0;
  }
  .masthead h1 {
    margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -.01em;
  }
  .masthead p {
    margin: var(--s-1) 0 var(--s-4);
    color: var(--text-muted); font-size: 14px; max-width: 68ch;
  }

  /* ------------------------------------------------------------------ tabs */
  .tabs {
    display: flex; gap: var(--s-1);
    overflow-x: auto; scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    appearance: none; background: none; border: 0;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font: 500 14px/1 var(--sans);
    padding: var(--s-3) var(--s-4);
    cursor: pointer; white-space: nowrap;
    display: inline-flex; align-items: center; gap: var(--s-2);
    border-radius: var(--r-sm) var(--r-sm) 0 0;
    transition: color var(--dur) ease, border-color var(--dur) ease;
  }
  .tab:hover { color: var(--text); }
  .tab[aria-selected="true"] {
    color: var(--text); border-bottom-color: var(--accent);
  }
  .tab-count {
    font: 600 11px/1 var(--mono);
    background: var(--surface-3); color: var(--text-muted);
    padding: 3px 7px; border-radius: 999px;
    border: 1px solid var(--line);
  }
  .tab-count[data-alert="true"] {
    background: var(--bad-bg); color: var(--bad); border-color: var(--bad-line);
  }

  /* ------------------------------------------------------------------ main */
  main {
    max-width: 1240px; margin: 0 auto;
    padding: var(--s-5);
  }
  [role="tabpanel"]:focus { outline: none; }
  [role="tabpanel"]:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 4px;
  }

  .panel-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: var(--s-4); flex-wrap: wrap; margin-bottom: var(--s-4);
  }
  .panel-head h2 {
    margin: 0; font-size: 17px; font-weight: 620; letter-spacing: -.01em;
  }
  .panel-head .sub {
    margin: var(--s-1) 0 0; color: var(--text-muted); font-size: 13.5px;
    max-width: 72ch;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow);
  }

  /* -------------------------------------------------------------- controls */
  /* Every field in a toolbar is a label band of one fixed height, a gap, and a
     control of one fixed height. Pinning both bands is what makes the filter
     input, the per-page select and the action buttons share one baseline row
     instead of each finding its own. */
  .toolbar {
    display: flex; gap: var(--s-3); flex-wrap: wrap; align-items: flex-start;
    padding: var(--s-4);
    /* Extra bottom room for the hint, which is taken out of flow below. */
    padding-bottom: calc(var(--s-4) + 22px);
    border-bottom: 1px solid var(--line);
  }
  .field { display: flex; flex-direction: column; gap: var(--s-1); min-width: 0; }
  .field > label {
    font-size: 12.5px; font-weight: 600; color: var(--text-muted);
    letter-spacing: .01em;
  }
  .field .hint { font: 400 11.5px/1.4 var(--mono); color: var(--text-faint); }
  .field.grow { flex: 1 1 200px; }

  /* A 12.5px label on the inherited 1.55 line-height is 19.375px tall, so a
     min-height smaller than that would not make the bands equal. Pinning the
     band to 20px on both the real labels and the action spacer is what makes
     the controls line up exactly rather than approximately. */
  .toolbar .field > label {
    height: 20px; display: flex; align-items: center;
  }
  .toolbar input[type="text"], .toolbar select { height: 38px; }

  /* A hint is the one child allowed to differ in height, so inside a toolbar it
     is positioned out of flow rather than pushing its own control down a line
     and out of alignment with its neighbours. The toolbar reserves the space. */
  .toolbar .field { position: relative; }
  .toolbar .field .hint { position: absolute; top: calc(100% + 5px); left: 0; }

  /* Action buttons ride the same control row and sit at the far side, so the
     filter and per-page controls group on the left. */
  .toolbar-actions {
    display: flex; flex-direction: column; gap: var(--s-1);
    margin-left: auto;
  }
  .toolbar-actions .label-spacer { height: 20px; flex: none; }
  .toolbar-actions .btn-row { display: flex; gap: var(--s-2); }
  .toolbar-actions .btn-row .btn { height: 38px; }

  input[type="text"], input[type="number"], select, textarea {
    font: 13.5px/1.5 var(--mono);
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-sm);
    padding: 8px 10px;
    width: 100%;
    transition: border-color var(--dur) ease;
  }
  input:hover, select:hover, textarea:hover { border-color: var(--line-strong); }
  input::placeholder, textarea::placeholder { color: var(--text-faint); }
  textarea { resize: vertical; min-height: 96px; }

  .btn {
    appearance: none; cursor: pointer;
    font: 600 13.5px/1 var(--sans);
    padding: 9px 15px; border-radius: var(--r-sm);
    border: 1px solid transparent;
    display: inline-flex; align-items: center; gap: var(--s-2);
    transition: background var(--dur) ease, border-color var(--dur) ease,
                opacity var(--dur) ease;
    white-space: nowrap;
  }
  .btn-primary { background: var(--accent-solid); color: var(--accent-ink); }
  .btn-primary:hover { background: var(--accent-solid-hover); }
  .btn-ghost {
    background: var(--surface-2); color: var(--text); border-color: var(--line-strong);
  }
  .btn-ghost:hover { background: var(--surface-3); }
  .btn-quiet {
    background: transparent; color: var(--text-muted); border-color: var(--line);
  }
  .btn-quiet:hover { color: var(--text); border-color: var(--line-strong); }
  .btn-sm { padding: 6px 11px; font-size: 12.5px; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn[aria-pressed="true"] {
    background: var(--info-bg); color: var(--info);
    border-color: var(--info-line);
  }

  /* ------------------------------------------------------------------ chips */
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    font: 600 11.5px/1 var(--mono);
    letter-spacing: .02em;
    padding: 4px 9px; border-radius: 999px;
    border: 1px solid transparent; white-space: nowrap;
  }
  .chip-pending    { background: var(--idle-bg);  color: var(--idle);  border-color: var(--idle-line); }
  .chip-processing { background: var(--info-bg);  color: var(--info);  border-color: var(--info-line); }
  .chip-succeeded  { background: var(--ok-bg);    color: var(--ok);    border-color: var(--ok-line); }
  .chip-failed     { background: var(--warn-bg);  color: var(--warn);  border-color: var(--warn-line); }
  .chip-dead       { background: var(--bad-bg);   color: var(--bad);   border-color: var(--bad-line); }
  .chip-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

  /* ------------------------------------------------------------------ table */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  caption { text-align: left; padding: var(--s-3) var(--s-4); color: var(--text-muted); font-size: 13px; }
  th, td {
    text-align: left; padding: var(--s-3) var(--s-4);
    border-bottom: 1px solid var(--line);
    vertical-align: top;
  }
  th {
    font: 600 11.5px/1.3 var(--sans);
    text-transform: uppercase; letter-spacing: .06em;
    color: var(--text-faint); white-space: nowrap;
    background: var(--surface-2);
    position: sticky; top: 0; z-index: 1;
  }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: var(--accent-tint); }

  .mono { font-family: var(--mono); font-size: 12.5px; }
  .muted { color: var(--text-muted); }
  .faint { color: var(--text-faint); }
  .err-text { color: var(--bad); }
  .nowrap { white-space: nowrap; }

  .job-cell { display: flex; flex-direction: column; gap: 3px; }
  .job-id {
    font-family: var(--mono); font-size: 12.5px; color: var(--text);
    display: inline-flex; align-items: center; gap: var(--s-2);
  }
  .job-type { font: 12px/1 var(--mono); color: var(--accent); }

  .copy {
    appearance: none; background: none; border: 0; cursor: pointer;
    color: var(--text-faint); padding: 2px 4px; border-radius: 4px;
    line-height: 1; font-size: 13px;
  }
  .copy:hover { color: var(--accent); background: var(--surface-3); }

  details > summary {
    cursor: pointer; color: var(--text-muted); font-size: 12.5px;
    list-style: none; display: inline-flex; align-items: center; gap: 5px;
  }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: "\\25B8"; font-size: 10px; transition: transform var(--dur) ease; }
  details[open] > summary::before { transform: rotate(90deg); }
  details > summary:hover { color: var(--text); }
  pre.json {
    font: 12px/1.5 var(--mono);
    background: var(--bg); border: 1px solid var(--line);
    border-radius: var(--r-sm); padding: var(--s-3);
    margin: var(--s-2) 0 0; overflow: auto; max-height: 220px;
    white-space: pre-wrap; word-break: break-word; color: var(--text-muted);
  }

  /* ------------------------------------------------------------- pagination */
  .pager {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--s-3); flex-wrap: wrap;
    padding: var(--s-3) var(--s-4);
    border-top: 1px solid var(--line);
    background: var(--surface-2);
  }
  .pager-info { font-size: 13px; color: var(--text-muted); }
  .pager-btns { display: flex; gap: var(--s-2); }

  /* ------------------------------------------------------- states & notices */
  .state {
    padding: var(--s-7) var(--s-5); text-align: center;
  }
  .state h3 { margin: 0 0 var(--s-2); font-size: 15px; font-weight: 620; }
  .state p { margin: 0 auto; color: var(--text-muted); font-size: 13.5px; max-width: 46ch; }
  .state .state-mark {
    width: 40px; height: 40px; border-radius: 50%;
    display: grid; place-items: center; margin: 0 auto var(--s-4);
    font-size: 19px;
  }
  .state-mark.ok   { background: var(--ok-bg);  color: var(--ok);  border: 1px solid var(--ok-line); }
  .state-mark.bad  { background: var(--bad-bg); color: var(--bad); border: 1px solid var(--bad-line); }

  .skeleton {
    background: linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 37%, var(--surface-2) 63%);
    background-size: 400% 100%;
    animation: shimmer 1.3s ease-in-out infinite;
    border-radius: 4px; height: 12px;
  }
  @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

  .banner {
    display: flex; gap: var(--s-3); align-items: flex-start;
    padding: var(--s-3) var(--s-4);
    border-radius: var(--r-md); font-size: 13.5px;
    border: 1px solid transparent; margin-bottom: var(--s-4);
  }
  .banner-ok  { background: var(--ok-bg);  color: var(--ok);  border-color: var(--ok-line); }
  .banner-bad { background: var(--bad-bg); color: var(--bad); border-color: var(--bad-line); }
  .banner strong { color: inherit; }

  /* --------------------------------------------------------------- readouts */
  .readout {
    display: grid; gap: 1px;
    background: var(--line); border: 1px solid var(--line);
    border-radius: var(--r-md); overflow: hidden;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  }
  .readout div { background: var(--surface); padding: var(--s-3) var(--s-4); }
  .readout dt {
    font: 600 11px/1.3 var(--sans); text-transform: uppercase;
    letter-spacing: .06em; color: var(--text-faint); margin-bottom: 5px;
  }
  .readout dd { margin: 0; font: 13px/1.5 var(--mono); word-break: break-word; }

  .stack { display: grid; gap: var(--s-4); }
  .grid-2 { display: grid; gap: var(--s-4); grid-template-columns: 1fr 1fr; }

  /* ----------------------------------------------------------------- toasts */
  .toasts {
    position: fixed; right: var(--s-5); bottom: var(--s-5);
    display: flex; flex-direction: column; gap: var(--s-2);
    z-index: 30; max-width: min(380px, calc(100vw - 2 * var(--s-5)));
  }
  .toast {
    background: var(--surface-3); color: var(--text);
    border: 1px solid var(--line-strong); border-left-width: 3px;
    border-radius: var(--r-md); padding: var(--s-3) var(--s-4);
    font-size: 13.5px; box-shadow: var(--shadow);
    animation: rise var(--dur) ease;
  }
  .toast.ok  { border-left-color: var(--ok); }
  .toast.bad { border-left-color: var(--bad); }
  @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

  footer {
    max-width: 1240px; margin: 0 auto;
    padding: var(--s-5); color: var(--text-faint); font-size: 12.5px;
    border-top: 1px solid var(--line); margin-top: var(--s-6);
  }
  footer code { font-family: var(--mono); }

  /* ------------------------------------------------------------ responsive */
  @media (max-width: 860px) {
    .grid-2 { grid-template-columns: 1fr; }
  }

  /* Below this width the eight-column table stops being readable, so each row
     becomes a stacked card with its own labels. */
  @media (max-width: 720px) {
    .masthead-inner, main, footer { padding-left: var(--s-4); padding-right: var(--s-4); }
    thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    table, tbody, tr, td { display: block; width: 100%; }
    tbody tr {
      border-bottom: 1px solid var(--line);
      padding: var(--s-3) 0;
    }
    tbody tr:last-child { border-bottom: 0; }
    td { border: 0; padding: var(--s-1) var(--s-4); }
    td::before {
      content: attr(data-label);
      display: block;
      font: 600 10.5px/1.4 var(--sans); text-transform: uppercase;
      letter-spacing: .06em; color: var(--text-faint);
      margin-bottom: 2px;
    }
    .toasts { left: var(--s-4); right: var(--s-4); max-width: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: .001ms !important;
    }
  }
</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to main content</a>

<header class="masthead">
  <div class="masthead-inner">
    <h1>Job Queue Console</h1>
    <p>Jobs are enqueued over HTTP and executed by a separate worker process. This console is for
       the jobs that stopped on their own and need a person to decide what happens next.</p>
    <div class="tabs" role="tablist" aria-label="Console sections">
${TABS.map(
  (t, i) => `      <button class="tab" role="tab" id="tab-${t.id}"
        aria-controls="panel-${t.id}" aria-selected="${i === 0}"
        tabindex="${i === 0 ? 0 : -1}" data-tab="${t.id}">${t.label}${
          t.id === 'dead' ? ' <span class="tab-count" id="tab-count">&mdash;</span>' : ''
        }</button>`
).join('\n')}
    </div>
  </div>
</header>

<main id="main">
  <div id="live-polite" class="sr-only" role="status" aria-live="polite"></div>

  <!-- ================================================== dead letter queue -->
  <section id="panel-dead" role="tabpanel" aria-labelledby="tab-dead" tabindex="0">
    <div class="panel-head">
      <div>
        <h2>Dead letter queue</h2>
        <p class="sub">These jobs exhausted every retry. Retrying raises the attempt ceiling by two
           so a second failure cannot kill the job immediately again.</p>
      </div>
    </div>

    <div class="card">
      <div class="toolbar">
        <div class="field grow">
          <label for="f-type">Filter by job type</label>
          <input type="text" id="f-type" placeholder="All types" autocomplete="off" spellcheck="false">
          <span class="hint">server-side, so it searches every page</span>
        </div>
        <div class="field">
          <label for="f-limit">Per page</label>
          <select id="f-limit">
            <option value="10">10</option>
            <option value="20" selected>20</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </div>
        <div class="toolbar-actions">
          <span class="label-spacer" aria-hidden="true"></span>
          <div class="btn-row">
            <button class="btn btn-ghost" id="btn-dead">Refresh</button>
            <button class="btn btn-quiet" id="btn-auto" aria-pressed="false">Auto&#8209;refresh</button>
          </div>
        </div>
      </div>

      <div id="dead-body" aria-busy="false"></div>

      <div class="pager" id="dead-pager" hidden>
        <span class="pager-info" id="dead-pageinfo"></span>
        <span class="pager-btns">
          <button class="btn btn-ghost btn-sm" id="btn-prev">Previous</button>
          <button class="btn btn-ghost btn-sm" id="btn-next">Next</button>
        </span>
      </div>
    </div>
  </section>

  <!-- ============================================================= enqueue -->
  <section id="panel-enqueue" role="tabpanel" aria-labelledby="tab-enqueue" tabindex="0" hidden>
    <div class="panel-head">
      <div>
        <h2>Enqueue a job</h2>
        <p class="sub">The request handler writes one row and returns 202. The work itself runs in
           the worker, so a slow handler never blocks this response.</p>
      </div>
    </div>

    <div class="card">
      <div class="stack" style="padding:var(--s-4)">
        <div class="grid-2">
          <div class="field">
            <label for="f-jobtype">Job type</label>
            <select id="f-jobtype">
              <option>send_email</option>
              <option>generate_pdf</option>
              <option>charge_card</option>
              <option>quick_work</option>
              <option>slow_work</option>
              <option>always_fails</option>
            </select>
          </div>
          <div class="field">
            <label for="f-key">Idempotency key</label>
            <input type="text" id="f-key" placeholder="user_123_welcome" autocomplete="off" spellcheck="false">
            <span class="hint">unique; resubmitting the same key returns the same job</span>
          </div>
        </div>

        <div class="field">
          <label for="f-payload">Payload (JSON)</label>
          <textarea id="f-payload" spellcheck="false">{"to":"user@example.com","subject":"Welcome","template":"welcome"}</textarea>
        </div>

        <div style="display:flex;gap:var(--s-2);flex-wrap:wrap">
          <button class="btn btn-primary" id="btn-enqueue">Enqueue job</button>
          <button class="btn btn-quiet" id="btn-genkey">Generate key</button>
        </div>

        <div id="enq-result"></div>
      </div>
    </div>
  </section>

  <!-- ========================================================= job status -->
  <section id="panel-status" role="tabpanel" aria-labelledby="tab-status" tabindex="0" hidden>
    <div class="panel-head">
      <div>
        <h2>Job status</h2>
        <p class="sub">Poll one job by id. Polling stops on its own once the job reaches a
           terminal state.</p>
      </div>
    </div>

    <div class="card">
      <div class="stack" style="padding:var(--s-4)">
        <div style="display:flex;gap:var(--s-2);flex-wrap:wrap;align-items:flex-end">
          <div class="field grow">
            <label for="f-jobid">Job id</label>
            <input type="text" id="f-jobid" placeholder="job_..." autocomplete="off" spellcheck="false">
          </div>
          <button class="btn btn-ghost" id="btn-lookup">Look up</button>
          <button class="btn btn-ghost" id="btn-poll" aria-pressed="false">Poll every 1s</button>
        </div>
        <div id="status-result"></div>
      </div>
    </div>
  </section>
</main>

<footer>
  <p>Retry raises <code>max_attempts</code> by two and returns the job to <code>pending</code>.
     Unresolved jobs stay here until someone acts on them.</p>
</footer>

<div class="toasts" id="toasts" aria-live="polite" aria-atomic="false"></div>

<script>
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var announce = function (msg) { $('live-polite').textContent = msg; };

  function el(tag, opts, kids) {
    var n = document.createElement(tag);
    opts = opts || {};
    if (opts.class) n.className = opts.class;
    if (opts.text !== undefined && opts.text !== null) n.textContent = String(opts.text);
    if (opts.attrs) {
      for (var k in opts.attrs) {
        if (Object.prototype.hasOwnProperty.call(opts.attrs, k)) n.setAttribute(k, opts.attrs[k]);
      }
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ----------------------------------------------------------------- toasts
  function toast(kind, message) {
    var t = el('div', { class: 'toast ' + kind, text: message });
    t.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
    $('toasts').appendChild(t);
    announce(message);
    setTimeout(function () { t.remove(); }, 5200);
  }

  // -------------------------------------------------------------------- api
  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, body: body };
      });
    });
  }

  // ------------------------------------------------------------------- time
  function relTime(iso) {
    if (!iso) return null;
    var t = new Date(iso).getTime();
    if (isNaN(t)) return null;
    var secs = Math.round((Date.now() - t) / 1000);
    var future = secs < 0;
    var s = Math.abs(secs);
    var out;
    if (s < 60) out = s + 's';
    else if (s < 3600) out = Math.floor(s / 60) + 'm';
    else if (s < 86400) out = Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    else out = Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
    return future ? 'in ' + out : out + ' ago';
  }

  function timeCell(iso) {
    if (!iso) return el('span', { class: 'faint', text: '-' });
    var wrap = el('span', { class: 'nowrap' });
    var rel = relTime(iso);
    wrap.appendChild(el('span', { text: rel || '-' }));
    if (rel) wrap.title = iso;
    return wrap;
  }

  function chip(status) {
    return el('span', { class: 'chip chip-' + status }, [
      el('span', { class: 'chip-dot', attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: status }),
    ]);
  }

  function copyButton(value, label) {
    var b = el('button', { class: 'copy', text: '\\u29C9' });
    b.type = 'button';
    b.title = 'Copy ' + label;
    b.setAttribute('aria-label', 'Copy ' + label);
    b.addEventListener('click', function () {
      var done = function () { toast('ok', label + ' copied'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () { toast('bad', 'Could not copy'); });
      } else {
        done();
      }
    });
    return b;
  }

  // ------------------------------------------------------------------- tabs
  var tabIds = ${JSON.stringify(TABS.map((t) => t.id))};

  function selectTab(id, moveFocus) {
    tabIds.forEach(function (tid) {
      var tab = $('tab-' + tid);
      var panel = $('panel-' + tid);
      var on = tid === id;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    });
    if (moveFocus) $('tab-' + id).focus();
    if (id === 'dead') loadDead();
  }

  tabIds.forEach(function (id, i) {
    var tab = $('tab-' + id);
    tab.addEventListener('click', function () { selectTab(id, false); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = tabIds[(i + 1) % tabIds.length];
      else if (e.key === 'ArrowLeft') next = tabIds[(i - 1 + tabIds.length) % tabIds.length];
      else if (e.key === 'Home') next = tabIds[0];
      else if (e.key === 'End') next = tabIds[tabIds.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });

  // ------------------------------------------------------- dead letter queue
  var deadState = { offset: 0, limit: 20, type: '', total: 0, hasMore: false, loading: false };
  var autoTimer = null;

  function skeletonRows(host) {
    var tbody = el('tbody');
    for (var i = 0; i < 5; i++) {
      var tr = el('tr');
      [3, 1, 4, 2, 2].forEach(function (w) {
        var td = el('td');
        td.appendChild(el('div', { class: 'skeleton' }));
        td.firstChild.style.width = (w * 11) + '%';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    var table = el('table');
    var thead = el('thead');
    var htr = el('tr');
    ['Job', 'Attempts', 'Last error', 'Age', ''].forEach(function (h) {
      htr.appendChild(el('th', { text: h, attrs: { scope: 'col' } }));
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    table.appendChild(tbody);
    var wrap = el('div', { class: 'table-wrap' });
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  function retryJob(job, button) {
    button.disabled = true;
    var original = button.textContent;
    button.textContent = 'Retrying\\u2026';
    api('/api/v1/jobs/' + encodeURIComponent(job.id) + '/retry', { method: 'POST' })
      .then(function (res) {
        if (res.status === 202) {
          toast('ok', job.type + ' requeued as pending (max_attempts ' + res.body.max_attempts + ')');
          return loadDead();
        }
        button.disabled = false;
        button.textContent = original;
        var msg = res.body && res.body.error ? res.body.error.message : 'HTTP ' + res.status;
        toast('bad', 'Retry failed: ' + msg);
      });
  }

  function deadRow(job) {
    var tr = el('tr');

    // Job identity, with the payload tucked away rather than shown as a wall of text.
    var idTd = el('td', { attrs: { 'data-label': 'Job' } });
    var stack = el('div', { class: 'job-cell' });
    var idLine = el('span', { class: 'job-id' });
    idLine.appendChild(el('span', { text: job.id }));
    idLine.appendChild(copyButton(job.id, 'job id'));
    stack.appendChild(idLine);
    stack.appendChild(el('span', { class: 'job-type', text: job.type }));
    var det = el('details');
    var sum = el('summary', { text: 'payload' });
    det.appendChild(sum);
    det.appendChild(el('pre', { class: 'json', text: JSON.stringify(job.payload, null, 2) }));
    stack.appendChild(det);
    idTd.appendChild(stack);
    tr.appendChild(idTd);

    var attTd = el('td', { attrs: { 'data-label': 'Attempts' } });
    attTd.appendChild(el('span', { class: 'chip chip-dead', text: job.attempts + ' / ' + job.max_attempts }));
    tr.appendChild(attTd);

    // last_error is the reason a human is looking at this row, so it gets the
    // strongest text treatment in the table.
    var errTd = el('td', { attrs: { 'data-label': 'Last error' } });
    errTd.appendChild(el('span', { class: 'err-text', text: job.last_error || 'No error recorded' }));
    tr.appendChild(errTd);

    var ageTd = el('td', { attrs: { 'data-label': 'Age' } });
    ageTd.appendChild(timeCell(job.finished_at));
    tr.appendChild(ageTd);

    var actTd = el('td', { attrs: { 'data-label': 'Action' } });
    var btn = el('button', { class: 'btn btn-ghost btn-sm', text: 'Retry' });
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Retry dead job ' + job.id + ' of type ' + job.type);
    btn.addEventListener('click', function () { retryJob(job, btn); });
    actTd.appendChild(btn);
    tr.appendChild(actTd);

    return tr;
  }

  function renderDead(body) {
    var host = $('dead-body');
    clear(host);
    var meta = body.meta;

    $('tab-count').textContent = meta.total;
    $('tab-count').setAttribute('data-alert', meta.total > 0 ? 'true' : 'false');

    if (body.jobs.length === 0) {
      var hasFilter = deadState.type !== '';
      host.appendChild(el('div', { class: 'state' }, [
        el('div', { class: 'state-mark ok', text: '\\u2713' }),
        el('h3', { text: hasFilter ? 'No dead jobs of this type' : 'Nothing needs attention' }),
        el('p', {
          text: hasFilter
            ? 'No dead jobs with type "' + deadState.type + '". Clear the filter to see all ' + meta.total + '.'
            : 'Every job either succeeded or is still retrying. This queue will list a job here once it exhausts all its attempts.',
        }),
      ]));
      $('dead-pager').hidden = true;
      return;
    }

    var table = el('table');
    var caption = el('caption', {
      text: meta.total + ' dead job' + (meta.total === 1 ? '' : 's') +
            (deadState.type ? ' of type ' + deadState.type : '') +
            ', showing ' + (meta.offset + 1) + ' to ' + (meta.offset + body.jobs.length),
    });
    table.appendChild(caption);

    var thead = el('thead');
    var htr = el('tr');
    ['Job', 'Attempts', 'Last error', 'Age', 'Action'].forEach(function (h) {
      htr.appendChild(el('th', { text: h, attrs: { scope: 'col' } }));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el('tbody');
    body.jobs.forEach(function (job) { tbody.appendChild(deadRow(job)); });
    table.appendChild(tbody);

    var wrap = el('div', { class: 'table-wrap' });
    wrap.appendChild(table);
    host.appendChild(wrap);

    var pages = Math.max(1, Math.ceil(meta.total / meta.limit));
    var page = Math.floor(meta.offset / meta.limit) + 1;
    $('dead-pageinfo').textContent = 'Page ' + page + ' of ' + pages + ' \\u00b7 ' + meta.total + ' total';
    $('dead-pager').hidden = false;
    $('btn-prev').disabled = meta.offset <= 0;
    $('btn-next').disabled = !meta.has_more;
  }

  function renderDeadError(message) {
    var host = $('dead-body');
    clear(host);
    var retry = el('button', { class: 'btn btn-ghost btn-sm', text: 'Try again' });
    retry.type = 'button';
    retry.addEventListener('click', loadDead);
    host.appendChild(el('div', { class: 'state' }, [
      el('div', { class: 'state-mark bad', text: '!' }),
      el('h3', { text: 'Could not load the dead letter queue' }),
      el('p', { text: message }),
      el('div', { style: 'margin-top:var(--s-4)' }, [retry]),
    ]));
    $('dead-pager').hidden = true;
  }

  function loadDead() {
    if (deadState.loading) return;
    deadState.loading = true;

    var host = $('dead-body');
    host.setAttribute('aria-busy', 'true');
    clear(host);
    skeletonRows(host);

    var params = new URLSearchParams({
      limit: String(deadState.limit),
      offset: String(deadState.offset),
    });
    if (deadState.type) params.set('type', deadState.type);

    api('/api/v1/jobs/dead?' + params.toString())
      .then(function (res) {
        if (res.status !== 200) {
          var msg = res.body && res.body.error ? res.body.error.message : 'HTTP ' + res.status;
          renderDeadError(msg);
          return;
        }
        renderDead(res.body);
      })
      .catch(function (e) { renderDeadError(e.message); })
      .then(function () {
        deadState.loading = false;
        host.setAttribute('aria-busy', 'false');
      });
  }

  $('btn-dead').addEventListener('click', loadDead);

  $('btn-prev').addEventListener('click', function () {
    deadState.offset = Math.max(0, deadState.offset - deadState.limit);
    loadDead();
  });
  $('btn-next').addEventListener('click', function () {
    deadState.offset = deadState.offset + deadState.limit;
    loadDead();
  });
  $('f-type').addEventListener('change', function (e) {
    deadState.type = e.target.value.trim();
    deadState.offset = 0;
    loadDead();
  });
  $('f-limit').addEventListener('change', function (e) {
    deadState.limit = parseInt(e.target.value, 10);
    deadState.offset = 0;
    loadDead();
  });
  $('btn-auto').addEventListener('click', function (e) {
    var btn = e.currentTarget;
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = 'Auto-refresh';
    } else {
      autoTimer = setInterval(loadDead, 5000);
      btn.setAttribute('aria-pressed', 'true');
      btn.textContent = 'Auto-refresh on';
    }
  });

  // --------------------------------------------------------------- enqueue
  $('btn-genkey').addEventListener('click', function () {
    var rand = Math.random().toString(36).slice(2, 10);
    $('f-key').value = 'manual_' + Date.now().toString(36) + '_' + rand;
  });

  $('btn-enqueue').addEventListener('click', function () {
    var btn = this;
    var host = $('enq-result');
    clear(host);

    var payload;
    try {
      payload = JSON.parse($('f-payload').value);
    } catch (e) {
      host.appendChild(el('div', { class: 'banner banner-bad' }, [
        el('span', {}, [el('strong', { text: 'Invalid JSON. ' }), el('span', { text: e.message })]),
      ]));
      $('f-payload').focus();
      return;
    }

    var key = $('f-key').value.trim();
    if (!key) {
      host.appendChild(el('div', { class: 'banner banner-bad' }, [
        el('strong', { text: 'An idempotency key is required.' }),
      ]));
      $('f-key').focus();
      return;
    }

    btn.disabled = true;
    api('/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: $('f-jobtype').value, payload: payload, idempotency_key: key }),
    }).then(function (res) {
      btn.disabled = false;
      if (res.status !== 202) {
        var msg = res.body && res.body.error ? res.body.error.code + ': ' + res.body.error.message : 'HTTP ' + res.status;
        host.appendChild(el('div', { class: 'banner banner-bad' }, [el('strong', { text: msg })]));
        announce('Enqueue failed. ' + msg);
        return;
      }
      host.appendChild(el('div', { class: 'banner banner-ok' }, [
        el('span', {}, [
          el('strong', { text: 'Accepted 202. ' }),
          el('span', { text: 'The worker will pick this up; the request did not wait for it.' }),
        ]),
      ]));
      var idLine = el('div', { class: 'job-cell', style: 'margin-top:var(--s-3)' });
      var row = el('span', { class: 'job-id' });
      row.appendChild(el('span', { text: res.body.job_id }));
      row.appendChild(copyButton(res.body.job_id, 'job id'));
      idLine.appendChild(row);
      host.appendChild(idLine);
      host.appendChild(el('pre', { class: 'json', text: JSON.stringify(res.body, null, 2) }));
      $('f-jobid').value = res.body.job_id;
      announce('Job ' + res.body.job_id + ' accepted.');
    }).catch(function (e) {
      btn.disabled = false;
      host.appendChild(el('div', { class: 'banner banner-bad' }, [el('strong', { text: e.message })]));
    });
  });

  // ----------------------------------------------------------- job status
  var pollTimer = null;

  function renderStatus(body) {
    var host = $('status-result');
    clear(host);

    var list = el('dl', { class: 'readout' });
    function pair(label, value) {
      list.appendChild(el('div', {}, [
        el('dt', { text: label }),
        el('dd', {}, [value instanceof Node ? value : el('span', { text: value })]),
      ]));
    }
    pair('Status', chip(body.status));
    pair('Attempts', body.attempts + ' of ' + body.max_attempts);
    pair('Type', body.type);
    pair('Last error', body.last_error
      ? el('span', { class: 'err-text', text: body.last_error })
      : el('span', { class: 'faint', text: 'none' }));
    pair('Scheduled', timeCellFor(body.run_at));
    pair('Started', timeCellFor(body.started_at));
    pair('Finished', timeCellFor(body.finished_at));
    host.appendChild(list);

    var det = el('details');
    det.appendChild(el('summary', { text: 'Raw response' }));
    det.appendChild(el('pre', { class: 'json', text: JSON.stringify(body, null, 2) }));
    host.appendChild(det);

    if (body.status === 'succeeded' || body.status === 'dead') {
      stopPolling();
      announce('Job reached terminal state: ' + body.status + '.');
    }
  }

  function timeCellFor(iso) {
    if (!iso) return el('span', { class: 'faint', text: '-' });
    var s = el('span', { class: 'nowrap' });
    s.appendChild(el('span', { text: relTime(iso) || iso }));
    s.title = iso;
    return s;
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    var btn = $('btn-poll');
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = 'Poll every 1s';
  }

  function lookupStatus() {
    var id = $('f-jobid').value.trim();
    var host = $('status-result');
    if (!id) {
      clear(host);
      host.appendChild(el('div', { class: 'banner banner-bad' }, [
        el('strong', { text: 'Enter a job id first.' }),
      ]));
      $('f-jobid').focus();
      return;
    }
    api('/api/v1/jobs/' + encodeURIComponent(id)).then(function (res) {
      if (res.status !== 200) {
        clear(host);
        var msg = res.body && res.body.error ? res.body.error.code + ': ' + res.body.error.message : 'HTTP ' + res.status;
        host.appendChild(el('div', { class: 'banner banner-bad' }, [el('strong', { text: msg })]));
        announce('Lookup failed. ' + msg);
        stopPolling();
        return;
      }
      renderStatus(res.body);
    }).catch(function (e) {
      clear(host);
      host.appendChild(el('div', { class: 'banner banner-bad' }, [el('strong', { text: e.message })]));
    });
  }

  $('btn-lookup').addEventListener('click', lookupStatus);
  $('f-jobid').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); lookupStatus(); }
  });
  $('btn-poll').addEventListener('click', function () {
    if (pollTimer) { stopPolling(); return; }
    var btn = this;
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = 'Stop polling';
    lookupStatus();
    pollTimer = setInterval(lookupStatus, 1000);
  });

  // ------------------------------------------------------------------ boot
  loadDead();
})();
</script>
</body>
</html>`;
}
