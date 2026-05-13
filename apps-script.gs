// ===== CONFIG =====
const GITHUB_OWNER = 'USERNAME';
const GITHUB_REPO = 'daily-logs';
const GITHUB_BRANCH = 'main';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const LLM_ENDPOINT = 'https://ollama.com/api/chat';
const LLM_MODEL = 'gemma4:31b-cloud';
const LLM_API_KEY_PROP = 'OLLAMA_API_KEY';

const ECHO_ANCHORS_MONTHS = [1, 3, 6, 12];
const ECHO_INTERVAL_DAYS = 4;

const POSTHOG_HOST = 'https://us.i.posthog.com'; // use 'https://eu.i.posthog.com' if EU
const POSTHOG_API_KEY_PROP = 'POSTHOG_API_KEY';
const POSTHOG_EVENT_NAME = 'EVENT_NAME';

// ===== AUTH =====
function getToken_() {
  const t = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!t) throw new Error('Set GITHUB_TOKEN in Script Properties');
  return t;
}

// ===== ENTRY POINTS =====
function testAuth() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;
  const resp = UrlFetchApp.fetch(url, { method: 'get', headers: ghHeaders_(), muteHttpExceptions: true });
  Logger.log(`GitHub: ${resp.getResponseCode()}`);
  Logger.log(resp.getContentText().slice(0, 300));

  const apiKey = PropertiesService.getScriptProperties().getProperty(LLM_API_KEY_PROP);
  Logger.log(`LLM key set: ${apiKey ? 'yes' : 'NO'}`);
}

function backfillAll() {
  const docs = findAllLogDocs_();
  if (!docs.length) { Logger.log('no log Docs found in Drive'); return; }
  for (const entry of docs) {
    Logger.log(`processing: ${entry.name}`);
    processDoc_(entry.doc, entry.year);
  }
}

function backfillPosthog() {
  const apiKey = PropertiesService.getScriptProperties().getProperty(POSTHOG_API_KEY_PROP);
  if (!apiKey) { Logger.log(`missing ${POSTHOG_API_KEY_PROP}`); return; }

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  const resp = UrlFetchApp.fetch(url, { method: 'get', headers: ghHeaders_(), muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) { Logger.log(`tree fail: ${resp.getContentText().slice(0, 200)}`); return; }

  const files = JSON.parse(resp.getContentText()).tree
    .filter(t => t.type === 'blob' && /^\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}.*\.md$/.test(t.path));
  Logger.log(`found ${files.length} log files`);

  const distinctId = Session.getActiveUser().getEmail() || 'daily-logs-script';
  const events = [];

  for (const f of files) {
    const r = UrlFetchApp.fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${f.sha}`,
      { method: 'get', headers: ghHeaders_(), muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) { Logger.log(`blob fail ${f.path}`); continue; }
    const blob = JSON.parse(r.getContentText());
    const text = Utilities.newBlob(Utilities.base64Decode(blob.content.replace(/\n/g, ''))).getDataAsString();
    const { fm, content: body } = splitFrontmatter_(text);
    const tags = fm ? parseFrontmatter_(fm) : {};

    const dateStr = (f.path.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
    if (!dateStr) continue;
    const [yy, mm, dd] = dateStr.split('-').map(Number);

    const titleLine = (body.match(/^#\s+(.+)$/m) || [])[1] || '';
    const heading = titleLine.replace(/^[A-Za-z]{3,9}\s+\d{1,2}\s*[-:,–]\s*/, '').trim();

    events.push({
      event: POSTHOG_EVENT_NAME,
      distinct_id: distinctId,
      uuid: deterministicUuid_(`${POSTHOG_EVENT_NAME}:${f.path}`),
      timestamp: `${dateStr}T12:00:00Z`,
      properties: buildDailyLogProps_({
        dateStr, year: yy, monthNum: mm, dayNum: dd,
        path: f.path, title: titleLine, heading, body, tags,
        isUpdate: false,
        source: 'apps-script:daily-logs-backfill',
      }),
    });
  }

  Logger.log(`emitting ${events.length} events to PostHog`);
  for (let i = 0; i < events.length; i += 50) {
    posthogBatch_(events.slice(i, i + 50), apiKey);
  }
  Logger.log('backfill done');
}

function deterministicUuid_(seed) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, seed);
  const hex = bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

function posthogBatch_(batch, apiKey) {
  const resp = UrlFetchApp.fetch(`${POSTHOG_HOST}/batch/`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ api_key: apiKey, batch }),
    muteHttpExceptions: true,
  });
  Logger.log(`posthog batch (${batch.length}): ${resp.getResponseCode()} ${resp.getContentText().slice(0, 200)}`);
}

function dailyRun() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const y = yesterday.getFullYear();
  const m = yesterday.getMonth() + 1;
  const d = yesterday.getDate();
  const docName = `${MONTHS[m-1]} daily log ${y}`;
  const doc = findDocByName_(docName);
  if (!doc) { Logger.log(`doc not found: ${docName}`); return; }
  processOneDay_(doc, y, m, d);
}

function echoesDigest() {
  const today = new Date();
  const sections = [];
  for (const n of ECHO_ANCHORS_MONTHS) {
    const d = new Date(today);
    if (n === 12) d.setFullYear(d.getFullYear() - 1);
    else d.setMonth(d.getMonth() - n);
    const entry = fetchEntryAt_(d);
    if (entry) {
      const summary = llmHighlight_(entry.content);
      Logger.log(`llm highlight ${summary ? 'ok' : 'skipped'}: ${entry.name}`);
      sections.push({
        label: n === 12 ? '1 year ago' : `${n} month${n>1?'s':''} ago`,
        date: d,
        entry,
        summary,
      });
    }
  }
  if (!sections.length) { Logger.log('no echoes — skip'); return; }
  const recipient = Session.getActiveUser().getEmail();
  MailApp.sendEmail({
    to: recipient,
    subject: `📅 Echoes — ${formatDate_(today)}`,
    htmlBody: renderEchoesEmail_(today, sections),
  });
  Logger.log(`echoes sent to ${recipient}: ${sections.length} anchors`);
}

function generateSentimentReport() {
  const entries = fetchAllTaggedEntries_();
  const data = entries
    .filter(e => e.tags.mood != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!data.length) { Logger.log('no tagged entries yet'); return; }
  const html = renderSentimentHtml_(data);
  const existing = fetchExistingFile_('reports/sentiment.html');
  upsertFileWithSha_('reports/sentiment.html', html, 'reports: sentiment update', existing && existing.sha);
}

// ===== TRIGGERS =====
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyRun') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRun').timeBased().everyDays(1).atHour(9).create();
  Logger.log('trigger: dailyRun @ 9am');
}

function installEchoesTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'echoesDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('echoesDigest').timeBased().everyDays(ECHO_INTERVAL_DAYS).atHour(8).create();
  Logger.log(`trigger: echoesDigest every ${ECHO_INTERVAL_DAYS} days @ 8am`);
}

function installSentimentTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'generateSentimentReport') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('generateSentimentReport').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).create();
  Logger.log('trigger: generateSentimentReport Sunday @ 2am');
}

// ===== DOC LAYER =====
function findDocByName_(name) {
  const it = DriveApp.getFilesByName(name);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getMimeType() === MimeType.GOOGLE_DOCS) return DocumentApp.openById(f.getId());
  }
  return null;
}

function findAllLogDocs_() {
  const out = [];
  const it = DriveApp.searchFiles('mimeType = "application/vnd.google-apps.document" and title contains "daily log"');
  while (it.hasNext()) {
    const f = it.next();
    const m = f.getName().match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+daily\s+log\s+(\d{4})$/i);
    if (!m) continue;
    out.push({
      doc: DocumentApp.openById(f.getId()),
      year: parseInt(m[2], 10),
      monthNum: MONTHS.findIndex(x => x.toLowerCase() === m[1].toLowerCase()) + 1,
      name: f.getName(),
    });
  }
  out.sort((a, b) => a.year - b.year || a.monthNum - b.monthNum);
  return out;
}

function processDoc_(doc, year) {
  const tabs = flattenTabs_(doc.getTabs());
  for (const tab of tabs) {
    const date = parseDateFromTitle_(tab.getTitle());
    if (!date) continue;
    pushTab_(tab, year, date.month, date.day);
  }
}

function processOneDay_(doc, year, monthNum, dayNum) {
  const tabs = flattenTabs_(doc.getTabs());
  for (const tab of tabs) {
    const date = parseDateFromTitle_(tab.getTitle());
    if (date && date.month === monthNum && date.day === dayNum) {
      pushTab_(tab, year, monthNum, dayNum);
      return;
    }
  }
  Logger.log(`no tab found for ${MONTHS[monthNum-1]} ${dayNum} ${year}`);
}

function flattenTabs_(tabs) {
  const out = [];
  for (const t of tabs) {
    out.push(t);
    const kids = t.getChildTabs && t.getChildTabs();
    if (kids && kids.length) out.push(...flattenTabs_(kids));
  }
  return out;
}

function parseDateFromTitle_(title) {
  if (!title) return null;
  const re = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i;
  const m = title.match(re);
  if (!m) return null;
  const monStr = m[1].toLowerCase().slice(0, 3);
  const mon = MONTHS.findIndex(x => x.toLowerCase() === monStr) + 1;
  return { month: mon, day: parseInt(m[2], 10) };
}

function pushTab_(tab, year, monthNum, dayNum) {
  const docTab = tab.asDocumentTab();
  const title = tab.getTitle();
  const md = bodyToMarkdown_(docTab.getBody(), title);
  const slug = slugifyTitle_(title);
  const heading = title.replace(/^[A-Za-z]{3,9}\s+\d{1,2}\s*[-:,–]\s*/, '').trim();
  const dateStr = `${year}-${pad2_(monthNum)}-${pad2_(dayNum)}`;
  const fname = slug ? `${dateStr}--${slug}.md` : `${dateStr}.md`;
  const path = `${year}/${pad2_(monthNum)}/${fname}`;

  const existing = fetchExistingFile_(path);
  if (existing) {
    const { fm: existingFm, content: existingBody } = splitFrontmatter_(existing.content);
    if (existingFm && existingBody === md) {
      Logger.log(`unchanged: ${path}`);
      return; // no push, no event — duplicate runs are no-ops
    }
  }

  const tags = llmTag_(md);
  const fm = tagsToFrontmatter_(tags);
  const finalContent = fm + md;
  upsertFileWithSha_(path, finalContent, `log: ${dateStr}`, existing && existing.sha);

  posthogCapture_(POSTHOG_EVENT_NAME, buildDailyLogProps_({
    dateStr, year, monthNum, dayNum,
    path, title, heading, body: md, tags,
    isUpdate: !!existing,
    source: 'apps-script:daily-logs-sync',
  }));
}

function buildDailyLogProps_({ dateStr, year, monthNum, dayNum, path, title, heading, body, tags, isUpdate, source }) {
  const t = tags || {};
  const scores = t.emotion_scores || {};
  const scoreEntries = Object.entries(scores).filter(([, v]) => typeof v === 'number');
  const dominant = scoreEntries.sort((a, b) => b[1] - a[1])[0];
  const dateObj = new Date(`${dateStr}T12:00:00Z`);
  const dow = dateObj.getUTCDay(); // 0=Sun

  return {
    date: dateStr,
    year, month: monthNum, day: dayNum,
    day_of_week: dow,
    is_weekend: dow === 0 || dow === 6,
    file_path: path,
    title,
    heading,
    body,
    body_length: body.length,
    word_count: body.split(/\s+/).filter(Boolean).length,
    has_tags: !!tags,
    mood: t.mood,
    emotions: t.emotions || [],
    emotions_count: (t.emotions || []).length,
    emotion_scores: scores,
    emotion_scores_json: JSON.stringify(scores),
    dominant_emotion: dominant ? dominant[0] : null,
    dominant_emotion_score: dominant ? dominant[1] : null,
    people: t.people || [],
    people_count: (t.people || []).length,
    activities: t.activities || [],
    activities_count: (t.activities || []).length,
    themes: t.themes || [],
    themes_count: (t.themes || []).length,
    summary: t.summary,
    is_update: isUpdate,
    source,
  };
}

// ===== MARKDOWN =====
function bodyToMarkdown_(body, tabTitle) {
  const lines = [`# ${tabTitle}`, ''];
  const n = body.getNumChildren();
  for (let i = 0; i < n; i++) {
    const el = body.getChild(i);
    const type = el.getType();
    if (type === DocumentApp.ElementType.PARAGRAPH) {
      const p = el.asParagraph();
      const text = p.getText();
      const heading = p.getHeading();
      if (!text.trim()) { lines.push(''); continue; }
      switch (heading) {
        case DocumentApp.ParagraphHeading.TITLE:    lines.push(`# ${text}`); break;
        case DocumentApp.ParagraphHeading.HEADING1: lines.push(`## ${text}`); break;
        case DocumentApp.ParagraphHeading.HEADING2: lines.push(`### ${text}`); break;
        case DocumentApp.ParagraphHeading.HEADING3: lines.push(`#### ${text}`); break;
        default: lines.push(text);
      }
    } else if (type === DocumentApp.ElementType.LIST_ITEM) {
      const li = el.asListItem();
      const indent = '  '.repeat(li.getNestingLevel());
      lines.push(`${indent}- ${li.getText()}`);
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function slugifyTitle_(title) {
  const stripped = title.replace(/^[A-Za-z]{3,9}\s+\d{1,2}\s*[-:,–]\s*/, '');
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function pad2_(n) { return String(n).padStart(2, '0'); }

// ===== GITHUB =====
function ghHeaders_() {
  return {
    Authorization: `Bearer ${getToken_()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function ghContentsUrl_(path) {
  return `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
}

function fetchExistingFile_(path) {
  const resp = UrlFetchApp.fetch(`${ghContentsUrl_(path)}?ref=${GITHUB_BRANCH}`, {
    method: 'get', headers: ghHeaders_(), muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) return null;
  const j = JSON.parse(resp.getContentText());
  const content = Utilities.newBlob(Utilities.base64Decode(j.content.replace(/\n/g, ''))).getDataAsString();
  return { sha: j.sha, content };
}

function upsertFileWithSha_(path, content, message, sha) {
  const body = {
    message,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const resp = UrlFetchApp.fetch(ghContentsUrl_(path), {
    method: 'put', headers: ghHeaders_(), contentType: 'application/json',
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  Logger.log(`${code >= 200 && code < 300 ? 'pushed' : 'FAIL ' + code}: ${path}`);
  if (code >= 400) Logger.log(resp.getContentText());
}

// ===== FRONTMATTER =====
function splitFrontmatter_(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n*([\s\S]*)$/);
  if (!m) return { fm: '', content: text };
  return { fm: m[1], content: m[2] };
}

function tagsToFrontmatter_(t) {
  if (!t) return '';
  const L = ['---'];
  if (t.mood != null) L.push(`mood: ${t.mood}`);
  if (t.emotions && t.emotions.length) L.push(`emotions: [${t.emotions.map(yamlStr_).join(', ')}]`);
  if (t.emotion_scores && Object.keys(t.emotion_scores).length) {
    L.push('emotion_scores:');
    for (const [k, v] of Object.entries(t.emotion_scores)) L.push(`  ${k}: ${v}`);
  }
  if (t.people && t.people.length) L.push(`people: [${t.people.map(yamlStr_).join(', ')}]`);
  if (t.activities && t.activities.length) L.push(`activities: [${t.activities.map(yamlStr_).join(', ')}]`);
  if (t.themes && t.themes.length) L.push(`themes: [${t.themes.map(yamlStr_).join(', ')}]`);
  if (t.summary) L.push(`summary: ${yamlStr_(t.summary)}`);
  L.push('---', '');
  return L.join('\n');
}

function yamlStr_(s) {
  s = String(s);
  if (/^[\w\-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function parseFrontmatter_(fm) {
  const out = {};
  let cur = null;
  for (const line of fm.split('\n')) {
    let m;
    if ((m = line.match(/^([a-z_]+):\s*$/))) { cur = m[1]; out[cur] = {}; }
    else if ((m = line.match(/^([a-z_]+):\s*(.+)$/))) { cur = null; out[m[1]] = parseYamlValue_(m[2]); }
    else if ((m = line.match(/^\s+([a-z_]+):\s*(.+)$/)) && cur) { out[cur][m[1]] = parseYamlValue_(m[2]); }
  }
  return out;
}

function parseYamlValue_(v) {
  v = v.trim();
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return v.replace(/^["']|["']$/g, '');
}

// ===== LLM =====
function llmTag_(entryText) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(LLM_API_KEY_PROP);
  if (!apiKey) { Logger.log(`missing ${LLM_API_KEY_PROP} — pushing without tags`); return null; }

  const system = `You tag personal journal entries. Output ONLY valid JSON, no prose, no code fences. Schema:
{
  "mood": <int 1-10, overall day mood>,
  "emotions": [<lowercase strings, max 5>],
  "emotion_scores": {<emotion>: <int 1-10>, ...},
  "people": [<lowercase first names>],
  "activities": [<lowercase activity tags>],
  "themes": [<lowercase topics>],
  "summary": "<one sentence under 120 chars>"
}`;

  const body = {
    model: LLM_MODEL,
    stream: false,
    format: 'json',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: entryText },
    ],
  };

  const resp = UrlFetchApp.fetch(LLM_ENDPOINT, {
    method: 'post',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log(`LLM ${resp.getResponseCode()}: ${resp.getContentText().slice(0, 300)}`);
    return null;
  }

  let outer;
  try { outer = JSON.parse(resp.getContentText()); } catch (e) { return null; }
  const content = outer.message && outer.message.content;
  if (!content) return null;
  try { return JSON.parse(content); } catch (e) {
    Logger.log(`LLM bad JSON: ${content.slice(0, 300)}`);
    return null;
  }
}

function llmHighlight_(entryText) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(LLM_API_KEY_PROP);
  if (!apiKey) { Logger.log(`missing ${LLM_API_KEY_PROP} — echo will use full body`); return null; }

  const system = `You summarize personal journal entries for a "memories" digest email.
Output ONLY valid JSON, no prose, no code fences. Schema:
{
  "one_liner": "<one short sentence under 100 chars capturing the day's vibe>",
  "highlights": [<3-5 short bullets, each under 100 chars, present tense, lowercase first letter, no trailing period>]
}
Focus on: what happened, who was there, how they felt, decisions made.
Skip: filler, weather, generic todos.`;

  const body = {
    model: LLM_MODEL,
    stream: false,
    format: 'json',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: entryText },
    ],
  };

  const resp = UrlFetchApp.fetch(LLM_ENDPOINT, {
    method: 'post',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log(`LLM highlight ${resp.getResponseCode()}: ${resp.getContentText().slice(0, 300)}`);
    return null;
  }

  let outer;
  try { outer = JSON.parse(resp.getContentText()); } catch (e) { return null; }
  const content = outer.message && outer.message.content;
  if (!content) return null;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || (!parsed.one_liner && !(parsed.highlights && parsed.highlights.length))) return null;
    return parsed;
  } catch (e) {
    Logger.log(`LLM highlight bad JSON: ${content.slice(0, 300)}`);
    return null;
  }
}

// ===== ECHOES =====
function fetchEntryAt_(date) {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  const url = `${ghContentsUrl_(`${y}/${pad2_(m)}`)}?ref=${GITHUB_BRANCH}`;
  const resp = UrlFetchApp.fetch(url, { method: 'get', headers: ghHeaders_(), muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;
  const files = JSON.parse(resp.getContentText());
  const prefix = `${y}-${pad2_(m)}-${pad2_(d)}`;
  const f = files.find(x => x.name === `${prefix}.md` || x.name.startsWith(`${prefix}--`));
  if (!f) return null;
  const r = UrlFetchApp.fetch(f.download_url, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  const { content } = splitFrontmatter_(r.getContentText());
  return { name: f.name, content };
}

function renderEchoesEmail_(today, sections) {
  let h = `<div style="font-family:-apple-system,sans-serif;max-width:640px;color:#222;">`;
  h += `<h1 style="font-size:22px;">📅 Echoes for ${formatDate_(today)}</h1>`;
  for (const s of sections) {
    h += `<hr style="border:0;border-top:1px solid #eee;margin:24px 0;">`;
    h += `<h2 style="font-size:17px;color:#666;">🗓 ${s.label} — ${formatDate_(s.date)}</h2>`;
    if (s.summary) {
      if (s.summary.one_liner) {
        h += `<p style="font-style:italic;font-size:16px;color:#444;margin:8px 0 12px;">${escapeHtml_(s.summary.one_liner)}</p>`;
      }
      if (s.summary.highlights && s.summary.highlights.length) {
        h += `<ul style="font-size:15px;line-height:1.6;padding-left:20px;margin:8px 0;">`;
        for (const b of s.summary.highlights) {
          h += `<li style="margin-bottom:4px;">${escapeHtml_(b)}</li>`;
        }
        h += `</ul>`;
      }
      h += `<details style="margin-top:12px;"><summary style="cursor:pointer;color:#888;font-size:13px;">show full entry</summary>`;
      h += `<div style="white-space:pre-wrap;line-height:1.6;font-size:14px;color:#555;margin-top:8px;">${escapeHtml_(s.entry.content)}</div>`;
      h += `</details>`;
    } else {
      h += `<div style="white-space:pre-wrap;line-height:1.6;font-size:15px;">${escapeHtml_(s.entry.content)}</div>`;
    }
  }
  return h + `</div>`;
}

function formatDate_(d) {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ===== HELPER =====
function posthogCapture_(event, properties) {
  const apiKey = PropertiesService.getScriptProperties().getProperty(POSTHOG_API_KEY_PROP);
  if (!apiKey) { Logger.log(`posthog: missing ${POSTHOG_API_KEY_PROP} — skipping`); return; }

  const payload = {
    api_key: apiKey,
    event,
    distinct_id: Session.getActiveUser().getEmail() || 'daily-logs-script',
    properties: { ...properties, source: 'apps-script:daily-logs-sync' },
    timestamp: new Date().toISOString(),
  };

  const resp = UrlFetchApp.fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  Logger.log(`posthog ${event}: ${resp.getResponseCode()} ${resp.getContentText().slice(0, 200)}`);
}

// ===== SENTIMENT =====
function fetchAllTaggedEntries_() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  const resp = UrlFetchApp.fetch(url, { method: 'get', headers: ghHeaders_(), muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) { Logger.log(`tree fail: ${resp.getContentText().slice(0, 200)}`); return []; }
  const files = JSON.parse(resp.getContentText()).tree
    .filter(t => t.type === 'blob' && /^\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}.*\.md$/.test(t.path));

  const out = [];
  for (const f of files) {
    const r = UrlFetchApp.fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${f.sha}`,
      { method: 'get', headers: ghHeaders_(), muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) continue;
    const j = JSON.parse(r.getContentText());
    const text = Utilities.newBlob(Utilities.base64Decode(j.content.replace(/\n/g, ''))).getDataAsString();
    const { fm } = splitFrontmatter_(text);
    if (!fm) continue;
    const date = (f.path.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
    if (!date) continue;
    out.push({ date, tags: parseFrontmatter_(fm), path: f.path });
  }
  return out;
}

function renderSentimentHtml_(data) {
  const labels = data.map(d => d.date);
  const moods = data.map(d => d.tags.mood);
  const allEmo = new Set();
  data.forEach(d => Object.keys(d.tags.emotion_scores || {}).forEach(e => allEmo.add(e)));
  const emoSets = [...allEmo].map(emotion => ({
    label: emotion,
    data: data.map(d => (d.tags.emotion_scores && d.tags.emotion_scores[emotion]) || 0),
    fill: false, tension: 0.3,
  }));

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sentiment</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>body{font-family:-apple-system,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#222}
h1{font-size:24px}canvas{margin-bottom:40px;max-height:400px}</style>
</head><body>
<h1>Sentiment over time</h1>
<p>${data.length} entries · generated ${new Date().toISOString()}</p>
<canvas id="mood"></canvas>
<canvas id="emotions"></canvas>
<script>
const labels = ${JSON.stringify(labels)};
new Chart(document.getElementById('mood'), {
  type:'line',
  data:{labels,datasets:[{label:'Mood (1-10)',data:${JSON.stringify(moods)},borderColor:'#3b82f6',fill:false,tension:0.3}]},
  options:{plugins:{title:{display:true,text:'Daily mood'}},scales:{y:{min:0,max:10}}}
});
new Chart(document.getElementById('emotions'), {
  type:'line',
  data:{labels,datasets:${JSON.stringify(emoSets)}},
  options:{plugins:{title:{display:true,text:'Emotion intensity'}},scales:{y:{min:0,max:10}}}
});
</script></body></html>`;
}
