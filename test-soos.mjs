// test-soos.mjs — Node.js test harness for BAS_PM_Generator parser logic
// Usage: node test-soos.mjs
// Output goes to stdout; nothing written to the repo directory.

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs');
GlobalWorkerOptions.workerSrc = new URL(
  './node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url
).href;

// ── PDF files to test ────────────────────────────────────────────────────────
const PDF_FILES = [
  'B101-102_Reheat_Sequence Rev1.pdf',
  'B101_102_AHU-S1_SoO.pdf',
  'B204_AHU-S1-6 SoO_Rev9.pdf',
  'B207_Split-Air AHU Sequence of Operation Rev 05.pdf',
  'CH3a3bSoo.pdf',
  'SecCHWPumpsSoO.pdf',
  'B106_CHWP_SoO.pdf',
];

// ════════════════════════════════════════════════════════════════════════════
// Parser logic extracted verbatim from BAS_PM_Generator_v10.html
// ════════════════════════════════════════════════════════════════════════════

// ── DBSCAN ───────────────────────────────────────────────────────────────────
function dbscan(points, eps, minPts, distFn) {
  const n = points.length;
  const labels = new Array(n).fill(-1);
  let clusterId = 0;
  const neighborsOf = (i) => {
    const out = [];
    for (let j = 0; j < n; j++) {
      if (j !== i && distFn(points[i], points[j]) <= eps) out.push(j);
    }
    return out;
  };
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -1) continue;
    const neighbors = neighborsOf(i);
    if (neighbors.length < minPts) { labels[i] = -2; continue; }
    labels[i] = clusterId;
    const queue = [...neighbors];
    while (queue.length) {
      const j = queue.shift();
      if (labels[j] === -2) labels[j] = clusterId;
      if (labels[j] !== -1) continue;
      labels[j] = clusterId;
      const nn = neighborsOf(j);
      if (nn.length >= minPts) queue.push(...nn);
    }
    clusterId++;
  }
  return { labels, nClusters: clusterId };
}

// ── Rotation-aware coordinates ────────────────────────────────────────────────
function rotateItemsToVisualCoords(items, viewport) {
  const [a, b, c, d, e, f] = viewport.transform;
  return items.map(it => {
    const rx = it.transform[4], ry = it.transform[5];
    const tx = a * rx + c * ry + e;
    const ty = b * rx + d * ry + f;
    const rotSwapsAxes = Math.abs(a) < 0.01;
    const w = rotSwapsAxes ? (it.height || 0) : (it.width || 0);
    const h = rotSwapsAxes ? (it.width  || 0) : (it.height || 0);
    return { vx: tx, vy: ty - h, vw: w, vh: h, str: it.str };
  });
}

// ── Drawing-sheet detection ───────────────────────────────────────────────────
function isDrawingSheetPage(page, items) {
  const vp = page.getViewport({ scale: 1 });
  const longSide = Math.max(vp.width / 72, vp.height / 72);
  const isLargeSheet = longSide >= 20;
  if (!items.length) return false;
  const vItems = rotateItemsToVisualCoords(items, vp);
  const xs = vItems.map(it => it.vx);
  const xSpread = Math.max(...xs) - Math.min(...xs);
  return isLargeSheet && xSpread > 900;
}

// ── Line fragments ────────────────────────────────────────────────────────────
function buildLineFragments(vItems) {
  const Y_TOL = 5;
  const sorted = [...vItems].sort((a, b) => a.vy - b.vy);
  const lines = [];
  let current = [], currentY = null;
  for (const it of sorted) {
    if (currentY === null || Math.abs(it.vy - currentY) > Y_TOL) {
      if (current.length) lines.push(current);
      current = [it]; currentY = it.vy;
    } else { current.push(it); }
  }
  if (current.length) lines.push(current);

  const fragments = [];
  for (const line of lines) {
    line.sort((a, b) => a.vx - b.vx);
    let frag = [line[0]];
    for (let i = 1; i < line.length; i++) {
      const prev = frag[frag.length - 1];
      const gap = line[i].vx - (prev.vx + (prev.vw || 0));
      if (gap > 30) { fragments.push(frag); frag = [line[i]]; }
      else frag.push(line[i]);
    }
    if (frag.length) fragments.push(frag);
  }
  return fragments.map(items => {
    const xs = items.map(it => it.vx);
    const xEnds = items.map(it => it.vx + (it.vw || 0));
    const ys = items.map(it => it.vy);
    const heights = items.map(it => it.vh || 10);
    let text = '';
    for (let i = 0; i < items.length; i++) {
      if (i > 0) {
        const prev = items[i - 1];
        const gap = items[i].vx - (prev.vx + (prev.vw || 0));
        if (gap > 1) text += ' ';
      }
      text += items[i].str;
    }
    return {
      xMin: Math.min(...xs), xMax: Math.max(...xEnds),
      y: ys.reduce((a, b) => a + b, 0) / ys.length,
      text: text.trim(), height: Math.max(...heights)
    };
  }).filter(f => f.text);
}

function serializeColumn(frags) {
  if (!frags.length) return '';
  const sorted = [...frags].sort((a, b) => a.y - b.y);
  const colLeft = Math.min(...sorted.map(f => f.xMin));
  return sorted.map(f => {
    const indent = Math.max(0, Math.round((f.xMin - colLeft) / 8));
    return ' '.repeat(indent) + f.text;
  }).join('\n');
}

function clusterFragmentsIntoColumns(fragments) {
  if (fragments.length < 2) return [fragments];
  const pts = fragments.map(f => ({ x: f.xMin }));
  const { labels } = dbscan(pts, 60, 2, (a, b) => Math.abs(a.x - b.x));
  const cols = new Map();
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] >= 0) {
      if (!cols.has(labels[i])) cols.set(labels[i], []);
      cols.get(labels[i]).push(fragments[i]);
    }
  }
  const centers = new Map();
  for (const [id, frags] of cols)
    centers.set(id, frags.reduce((s, f) => s + f.xMin, 0) / frags.length);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] < 0) {
      let best = -1, bestDist = Infinity;
      for (const [id, center] of centers) {
        const d = Math.abs(fragments[i].xMin - center);
        if (d < bestDist) { bestDist = d; best = id; }
      }
      if (best >= 0 && bestDist < 150) cols.get(best).push(fragments[i]);
    }
  }
  return [...cols.values()]
    .map(frags => ({ frags, xMin: Math.min(...frags.map(f => f.xMin)) }))
    .sort((a, b) => a.xMin - b.xMin)
    .map(c => c.frags);
}

function isNarrativeColumn(frags, pageWidth) {
  if (frags.length < 2) return false;
  const meanX = frags.reduce((s, f) => s + f.xMin, 0) / frags.length;
  if (meanX > pageWidth * 0.88) return false;
  return frags.filter(f => f.text.length > 30).length >= 1;
}

const TITLE_BLOCK_LABELS_RX = [
  /^(solicitation|contract|file|sheet|project|job|drawing|contract)\s*(no|number|name)?\.?\s*:?$/i,
  /^(dwn|ckd|chkd|designed|submitted|approved|drawn|checked|reviewed)\s*by\s*:?$/i,
  /^(plot\s*scale|issue\s*date|scale|date|rev|revision|size|sheet)\s*:?$/i,
  /^(appr\.?|mark|description|author|of)\s*:?$/i,
  /^(sheet\s*identification|sheet\s*of|sheet\s*\d+\s*of\s*\d+)$/i,
  /^(us\s*army\s*corps|of\s*engineers|ansi\s*[a-e]|[a-e]\s*size)$/i,
  /^w\d{3,}[-\w]*$/i,
  /^i-\d+(\.\d+)*$/i,
  /^[a-z]\s*$/i,
  /^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
  /^tdp-\d/i,
  /^\d+\s*(of|\/)\s*\d+$/i,
];
const isTitleBlockLine = (line) => {
  const t = line.trim();
  if (!t || t.length > 80) return false;
  return TITLE_BLOCK_LABELS_RX.some(rx => rx.test(t));
};
const stripTitleBlockLines = (lines) => lines.filter(l => !isTitleBlockLine(l));

// ── PDF text extraction ───────────────────────────────────────────────────────
async function extractPdfText(uint8arr) {
  const pdf = await getDocument({ data: uint8arr }).promise;
  const pages = [];
  let pagesUsedColumnMode = 0;

  for (let p = 1; p <= pdf.numPages; p++) {
    const page    = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items   = content.items;
    const vp      = page.getViewport({ scale: 1 });

    const useColumnMode = isDrawingSheetPage(page, items);
    let pageText;

    if (useColumnMode) {
      const vItems    = rotateItemsToVisualCoords(items, vp);
      const fragments = buildLineFragments(vItems);
      const columns   = clusterFragmentsIntoColumns(fragments);
      const narrative = columns.filter(c => isNarrativeColumn(c, vp.width));

      if (narrative.length >= 1) {
        pagesUsedColumnMode++;
        const columnTexts = narrative.map(col => {
          const serialized = serializeColumn(col);
          return stripTitleBlockLines(serialized.split('\n')).join('\n');
        });
        pageText = columnTexts.join('\n\n');
      } else {
        const vItems2 = rotateItemsToVisualCoords(items, vp);
        const frags   = buildLineFragments(vItems2);
        pageText = stripTitleBlockLines(serializeColumn(frags).split('\n')).join('\n');
      }
    } else {
      const vItems = rotateItemsToVisualCoords(items, vp);
      const frags  = buildLineFragments(vItems);
      pageText = stripTitleBlockLines(serializeColumn(frags).split('\n')).join('\n');
    }
    pages.push(pageText);
  }

  // Remove page headers/footers (lines on ≥50% of pages)
  const PROTECTED_RX = [
    /^alarms?\s*shall\s*be\s*provided/i, /^alarms?\s*:?\s*$/i,
    /^if\s*:?\s*$/i, /^or\s+if\s*:?\s*$/i, /^end\s+of\s+sequence\s*$/i,
  ];
  const pagesPerLine = new Map();
  for (let pi = 0; pi < pages.length; pi++) {
    const seen = new Set();
    for (const raw of pages[pi].split('\n')) {
      const t = raw.trim();
      if (!t || t.length >= 80) continue;
      seen.add(t);
    }
    for (const t of seen) {
      if (!pagesPerLine.has(t)) pagesPerLine.set(t, new Set());
      pagesPerLine.get(t).add(pi);
    }
  }
  const minPages = Math.max(2, Math.ceil(pdf.numPages * 0.5));
  const repeats  = new Set();
  for (const [t, pageSet] of pagesPerLine) {
    if (pageSet.size >= minPages && !PROTECTED_RX.some(rx => rx.test(t))) repeats.add(t);
  }

  const combined = pages.join('\n');
  return {
    text: combined.split('\n').filter(l => !repeats.has(l.trim())).join('\n'),
    numPages: pdf.numPages,
    columnPages: pagesUsedColumnMode,
    repeatsRemoved: repeats.size,
  };
}

// ── GROUP_MAP ─────────────────────────────────────────────────────────────────
const GROUP_MAP = [
  { group: 'Safety and Smoke Purge Modes', patterns: [/fire\s*mode/i,/freeze\s*(mode|protect)/i,/smoke\s*(control|purge|detect|mode)/i,/low\s*temp(erature)?\s*(detect|protect)/i,/water\s*leak/i] },
  { group: 'Normal Operating Modes',       patterns: [/occupied\s*mode/i,/unoccupied\s*mode/i,/bypass\s*mode/i,/optimal\s*start/i,/run\s*condition/i,/space\s*temp/i,/space\s*humid/i] },
  { group: 'Startup Sequence',             patterns: [/startup/i,/start[\s-]*up/i] },
  { group: 'Fans',                         patterns: [/\bsa\s*(and\s*ra\s*)?fan\b/i,/\bra\s*fan\b/i,/\bea\s*fan\b/i,/\bma\s*stir\s*fan\b/i,/\bfan\s*track/i] },
  { group: 'Pumps',                        patterns: [/circ(ulation)?\s*pump/i,/reheat\s*pump/i,/re[\s-]*heat\s*(heating\s*)?pump/i,/radiant\s*(circuit\s*)?pump/i,/boiler/i,/heating\s*plant/i,/re[\s-]*heat\s*(heating\s*)?water/i,/chilled\s*water\s*pump/i,/secondary.*pump/i,/schwp/i,/condenser\s*water\s*(pump|flow)/i,/cooling\s*tower/i,/chiller.*sequenc/i,/chiller.*operation/i] },
  { group: 'Temperature and Coil Control', patterns: [/sa\s*temp(erature)?\s*control/i,/sa\s*temp(erature)?\s*setpoint/i,/cool(ing)?\s*coil/i,/heat(ing)?\s*coil/i,/preheat\s*control/i,/economizer/i,/(?<!de)humidif/i,/cold\s*deck/i,/hot\s*deck/i,/ma\/oa\s*(heating|cooling)/i,/ma\/ra\s*(heating|cooling)/i,/damper\s*operat/i,/building\s*hot\s*water/i,/temperature\s*reset/i,/trim\s*and\s*respond/i] },
  { group: 'Pressure and Flow Control',    patterns: [/duct\s*static/i,/static\s*pressure/i,/plenum\s*static/i,/minimum\s*oa/i,/min(imum)?\s*oa\s*control/i,/ra\s*fan\s*track/i,/smoke\s*purge/i,/unoccupied\s*(build|protect)/i] },
  { group: 'Dehumidification Control',     patterns: [/dehumidif/i] },
];
const ALARM_ONLY_RX = [/^monitoring/i,/^boiler\s*alarm/i,/^alarms?\s*shall/i,/^alarms?\s*:?\s*$/i];
const SKIP_SECTION_RX = [/^run\s*condition.*requested/i,/^end\s*of\s*sequence/i,/^page\s*\d/i,/^see\s*(below|above|table)/i,/^note\s*:/i,/^modes\s*:/i];

function classifySection(headerText) {
  const h = headerText.trim();
  if (SKIP_SECTION_RX.some(rx => rx.test(h))) return null;
  if (ALARM_ONLY_RX.some(rx => rx.test(h))) return '_alarms';
  for (const entry of GROUP_MAP)
    if (entry.patterns.some(rx => rx.test(h))) return entry.group;
  return '_misc';
}

// ── Header detection ──────────────────────────────────────────────────────────
function isHeaderLine(line) {
  const originalIndent = line.length - line.trimStart().length;
  const t = line.trim();
  if (!t || t.length < 3 || t.length > 100) return false;
  if (t.endsWith(':') && /^[a-z]/.test(t)) return false;
  if (originalIndent > 3) return false;
  if (/^[•\-–—*·●∙▪]/.test(t)) return false;
  if (/^(if:|or if:|and |not in |the |to |when |once |as |for |in |on |at )/i.test(t)) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^(arl|alc|primary integration|sequence of operation|page \d|b\d{3})/i.test(t)) return false;
  if (/^alarms?\s*shall\s*be\s*provided/i.test(t)) return false;
  if (/^note:/i.test(t)) return false;
  if (/^(see\s*(below|above)|end\s*of\s*sequence)/i.test(t)) return false;
  if (/^(whenever|however|unless|except|provided that|subject to)\s*:?\s*$/i.test(t)) return false;
  if (/\b(shall|will|may|must|should)\s+be\s+(enabled|disabled|activated|deactivated|controlled|permitted|allowed|started|stopped|set)\s+whenever\s*:?\s*$/i.test(t)) return false;
  if (/\bwhenever\s*:\s*$/i.test(t) && t.split(/\s+/).length > 2) return false;
  if (t.endsWith(':')) {
    const inner = t.slice(0, -1);
    if (/\b(see\s+(below|above|table|figure)|as\s+follows|per\s+the|following\s+(conditions|requirements|alarms|items))\b/i.test(inner)) return false;
    if (/\b(shall\s+be|will\s+be|is\s+to|are\s+to|should\s+be|must\s+be)\b.*\b(when|unless|if)\b/i.test(inner)) return false;
    if (inner.split(/\s+/).length > 12) return false;
  }
  if (isTitleBlockLine(t)) return false;
  const tokens = t.split(/\s+/);
  if (tokens.length >= 2 && tokens.length <= 8 && tokens.every(tok => tok.length <= 6 && /^[,a-z0-9#.-]+$/i.test(tok))) return false;
  if (/^(be|is|are|was|were|has|have|had|shall|will|may|must|should|can|could|would|do|does|did|not|to)\b/i.test(t)) return false;
  if (t.endsWith(':') && /\b(as\s+follows|as\s+described|as\s+noted|as\s+required|so\s+that|such\s+that|in\s+order\s+to)\s*:?\s*$/i.test(t)) return false;
  if (/^\s*(…|\.{3,})/.test(t)) return false;
  if (/^(…|\.{3,})?\s*the\s+(controller|unit|system|fan|pump|damper|valve|plant)\s+(shall|will|may|must|should)\s+(index|command|set|enable|disable|start|stop|energize|de-?energize|run|close|open|operate|modulate|ramp)/i.test(t)) return false;
  if (/^[A-Z][a-zA-Z]+(\s+[A-Z][a-zA-Z]+){0,2}\s+Mode\s*$/.test(t)) return false;
  const titleWithParenMatch = t.match(/^([A-Z][a-zA-Z0-9\-\/ ]{2,40}):\s*\(.+\)\s*$/);
  if (titleWithParenMatch && titleWithParenMatch[1].split(/\s+/).length <= 10) return true;
  const hasPredicate =
    /\b(shall|will|may|must|should)\s+(be\s+)?[a-z]/.test(t) ||
    /\b(is|are|was|were|has|have|does|do)\s+(not\s+)?[a-z]/.test(t) ||
    /\bNOT\s+(allowed|permitted|enabled|active|required|applicable)/i.test(t);
  if (hasPredicate && !t.endsWith(':')) return false;
  const endsWithColon = t.endsWith(':');
  const looksLikeTitle = /^[A-Z]/.test(t) && t.split(/\s+/).length <= 10 && !/[.?!]$/.test(t);
  return endsWithColon || looksLikeTitle;
}

// ── buildCheckText ────────────────────────────────────────────────────────────
function buildCheckText(headerText, bodyLines) {
  const name = headerText.replace(/:$/, '').trim();
  const conditions = [], outcomes = [], alarmLines = [], tableLines = [];
  let inAlarmBlock = false, ifState = 'none';

  const ALARM_LINE_RX = /^(high|low|fan|pump|boiler|radiant|re-?heat|prht|ma |ra |sa |ea |oa |chw|hw|water\s*leak|smoke|filter|freeze|static)[^.]*?:.*$/i;
  const ALARM_BLOCK_START_RX = /^\s*alarms?\s*shall\s*be\s*provided\b/i;
  const IF_START_RX  = /^\s*(if|or\s+if|and\s+if)\s*:\s*$/i;
  const IF_THEN_RX   = /^\s*(…|\.{3,}).*\bshall\s+(index|command|set|run|stop|operate|close|open|enable|disable|energize|de-?energize|ramp|start)/i;
  const TABLE_ROW_RX       = /^([A-Z0-9]+(?:[-\/][A-Z0-9]+){1,2})\s+(\d{2,6})\s*$/i;
  const TABLE_LABEL_ONLY_RX = /^([A-Z0-9]+(?:[-\/][A-Z0-9]+){1,2})\s*$/i;
  const TABLE_VALUE_ONLY_RX = /^(\d{2,6}(?:\.\d+)?)\s*$/;

  const processedBody = [...bodyLines];
  for (let i = 0; i < processedBody.length - 1; i++) {
    const a = processedBody[i].trim();
    if (!TABLE_LABEL_ONLY_RX.test(a)) continue;
    let j = i + 1;
    while (j < processedBody.length && !processedBody[j].trim()) j++;
    if (j >= processedBody.length) continue;
    const b = processedBody[j].trim();
    if (!TABLE_VALUE_ONLY_RX.test(b)) continue;
    if (!/[-\/]/.test(a) && a.length > 5) continue;
    processedBody[i] = `${a} ${b}`;
    processedBody[j] = '';
  }

  for (const raw of processedBody) {
    const originalIndent = raw.length - raw.trimStart().length;
    const line  = raw.trim();
    const clean = line.replace(/^[•\-–—*·●∙▪]\s*/, '').trim();
    if (!clean || clean.length < 4) continue;
    if (/^(arl|alc|primary integration|sequence of operation|page \d|b\d{3})/i.test(clean)) continue;
    if (/^[\d.,\s()°F%]+$/.test(clean) && clean.length < 10) continue;

    if (IF_START_RX.test(line)) { ifState = 'in_if'; continue; }
    if (IF_THEN_RX.test(line))  { ifState = 'post_then'; continue; }
    if (/^(…|\.{3,})\s*$/.test(clean)) continue;

    const tableMatch = clean.match(TABLE_ROW_RX);
    if (tableMatch) { tableLines.push({ label: tableMatch[1], value: tableMatch[2] }); continue; }

    if (ALARM_BLOCK_START_RX.test(raw)) { inAlarmBlock = true; continue; }

    const isBullet = /^\s*[•\-–—*·●∙▪]/.test(raw);
    const looksLikeAlarmPattern = ALARM_LINE_RX.test(clean);
    const startsLower = /^[a-z]/.test(clean);
    const startsDigit = /^[\d°]/.test(clean);
    const looksLikeContinuation = startsLower || startsDigit ||
      /^(scheduled|setpoint|operating|commanded|value|limited|for\s+\d|and\s+after|after\s+the)/i.test(clean);

    if (inAlarmBlock) {
      if (isBullet || looksLikeAlarmPattern) { alarmLines.push(clean); continue; }
      if (looksLikeContinuation && alarmLines.length > 0) {
        alarmLines[alarmLines.length - 1] = (alarmLines[alarmLines.length - 1] + ' ' + clean).replace(/\s+/g, ' ').trim();
        continue;
      }
      inAlarmBlock = false;
    }

    const isExplicit = /^(high|low)\s+\w+[\w\s\/]*?:/i.test(clean) ||
      /\b(fan\s+failure|fan\s+in\s+hand|locally\s+switched\s+off)\b/i.test(clean);
    if (isExplicit) { alarmLines.push(clean); continue; }

    if (ifState === 'in_if')    { conditions.push(clean); continue; }
    if (ifState === 'post_then'){ outcomes.push(clean);   continue; }

    const isCondition = isBullet || /^(not in |and |or |if )/i.test(clean);
    const isOutcome   = /^(the (controller|unit|sa fan|ra fan|ea fan|oa damper|ra damper|ea damper|pump|valve|fan|boiler|hot water))/i.test(clean)
      || /^(to prevent|when the |once the |note:|the setpoint|the speed)/i.test(clean);

    if (isCondition && outcomes.length === 0) conditions.push(clean);
    else if (isOutcome || outcomes.length > 0) outcomes.push(clean);
    else {
      if (clean.length > 30 && /[a-z]/.test(clean[0])) outcomes.push(clean);
      else conditions.push(clean);
    }
  }

  const normalizeForDedup = s => s.toLowerCase()
    .replace(/^(and|or|if|not)\s+/i,'').replace(/^in\s+/i,'')
    .replace(/["'"'`]/g,'').replace(/[.,;:\s]+$/g,'').replace(/\s+/g,' ').trim();
  const textDedup = arr => {
    const seen = new Map();
    for (const line of arr) {
      const k = normalizeForDedup(line);
      if (!k) continue;
      const prev = seen.get(k);
      if (!prev || line.length > prev.length) seen.set(k, line);
    }
    return [...seen.values()];
  };

  const finalConditions = textDedup(conditions);
  const finalOutcomes   = textDedup(outcomes);
  const isAlarmsOnly    = alarmLines.length > 0 && finalConditions.length === 0 && finalOutcomes.length <= 1;

  let text = `Verify ${name} operates correctly per SoO:`;
  if (finalConditions.length) text += `\nConditions: ${finalConditions.slice(0,5).join('; ')}.`;
  if (finalOutcomes.length)   {
    text += `\nExpected outcomes: ${finalOutcomes.slice(0,8).join(' ')}`;
    if (!text.endsWith('.')) text += '.';
  }
  if (tableLines.length >= 3) text += `\nTable values: ` + tableLines.map(t => `${t.label}=${t.value}`).join('; ') + '.';

  return { checkText: text.trim(), alarmLines, isAlarmsOnly };
}

// ── Jaccard dedup ─────────────────────────────────────────────────────────────
function jaccardSim(a, b) {
  const words = s => new Set(s.split(/\s+/).filter(w => w.length > 2 || /^\d+$/.test(w)));
  const setA = words(a), setB = words(b);
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
function normalizeCheckHeader(h) {
  return h.toLowerCase()
    .replace(/\bsa\b/g,'supply air').replace(/\bra\b/g,'return air')
    .replace(/\bea\b/g,'exhaust air').replace(/\boa\b/g,'outdoor air')
    .replace(/\bma\b/g,'mixed air').replace(/\bchw\b/g,'chilled water')
    .replace(/\bhw\b/g,'hot water').replace(/\bahu\b/g,'air handling unit')
    .replace(/\bvav\b/g,'variable air volume').replace(/\bvfd\b/g,'variable frequency drive')
    .replace(/\brtu\b/g,'rooftop unit')
    .replace(/\bverify\b/g,'').replace(/\boperates?\s+correctly\b/g,'')
    .replace(/\bper\s+so+\b/g,'').replace(/\bsequence\s+of\s+operations?\b/g,'')
    .replace(/\b(control|operation|sequence|mode|system|unit|the|a|an|and|or|in|of|for|to|from|with|is|are)\b/g,'')
    .replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}
function dedupeChecksJaccard(groupedChecks) {
  const THRESHOLD = 0.70;
  const out = {};
  for (const [group, checks] of Object.entries(groupedChecks)) {
    if (checks.length <= 1) { out[group] = checks; continue; }
    const kept = [];
    for (const check of checks) {
      const header = normalizeCheckHeader(check.split('\n')[0]);
      let dupIdx = -1;
      for (let j = 0; j < kept.length; j++) {
        const keptHeader = normalizeCheckHeader(kept[j].split('\n')[0]);
        if (jaccardSim(header, keptHeader) >= THRESHOLD) {
          dupIdx = j; break;
        }
      }
      if (dupIdx < 0) kept.push(check);
      else if (check.length > kept[dupIdx].length) kept[dupIdx] = check;
    }
    out[group] = kept;
  }
  return out;
}

// ── Main parser ───────────────────────────────────────────────────────────────
async function parseSoO(rawText) {
  const rawLines = rawText.split('\n');
  const lines    = rawLines.map(l => l.trim());
  const result   = { functional: [], alarms: [] };

  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHeaderLine(rawLines[i])) sections.push({ header: lines[i], startLine: i });
  }
  for (let s = 0; s < sections.length; s++)
    sections[s].endLine = s + 1 < sections.length ? sections[s+1].startLine : lines.length;

  const groupMap = new Map();
  let skippedCount = 0;

  for (const sec of sections) {
    let group = classifySection(sec.header);
    if (!group) { skippedCount++; continue; }
    const bodyLines = rawLines.slice(sec.startLine + 1, sec.endLine);
    const { checkText, alarmLines, isAlarmsOnly } = buildCheckText(sec.header, bodyLines);
    for (const al of alarmLines)
      if (!result.alarms.includes(al)) result.alarms.push(al);
    if (group === '_alarms' || group === null) { skippedCount++; continue; }
    if (isAlarmsOnly) { skippedCount++; continue; }
    if (group === '_misc') {
      if (bodyLines.filter(l => l.trim().length > 20).length < 2) continue;
      group = 'Other Checks';
    }
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group).push(checkText);
  }

  // Full-doc alarm sweep
  for (const raw of lines) {
    const clean = raw.replace(/^[•\-–—*·●∙▪]\s*/, '').trim();
    if (clean.length < 20 || clean.length > 200) continue;
    const isAlarmBullet = /^[•\-]\s*(high|low|sa fan|ra fan|ea fan|pump|boiler|radiant)/i.test(raw);
    const hasAlarmWord  = /\balarm\b/i.test(clean) && (clean.includes(':') || /fail|hand|switch/i.test(clean));
    if ((isAlarmBullet || hasAlarmWord) && !result.alarms.includes(clean)) result.alarms.push(clean);
  }

  result.alarms = [...new Set(result.alarms)]
    .filter(a => a.length > 15 && a.length < 220)
    .map(a => a.replace(/:?\s*$/, '').trim())
    .sort((a, b) => b.length - a.length)
    .filter((alarm, i, arr) => !arr.slice(0, i).some(longer => longer.startsWith(alarm)))
    .slice(0, 60);

  const grouped = Object.fromEntries(groupMap);
  const deduped = dedupeChecksJaccard(grouped);

  const groupOrder = [
    'Safety and Smoke Purge Modes','Normal Operating Modes','Startup Sequence',
    'Fans','Pumps','Temperature and Coil Control','Pressure and Flow Control',
    'Dehumidification Control','Other Checks',
  ];
  for (const grp of groupOrder) {
    const checks = deduped[grp];
    if (checks && checks.length) result.functional.push({ subsection: grp, checks });
  }

  return { result, totalHeaders: sections.length, skipped: skippedCount };
}

// ════════════════════════════════════════════════════════════════════════════
// Test runner
// ════════════════════════════════════════════════════════════════════════════
const DIVIDER = '═'.repeat(70);
const THIN    = '─'.repeat(70);

for (const filename of PDF_FILES) {
  const filepath = join(__dirname, filename);
  console.log(`\n${DIVIDER}`);
  console.log(`FILE: ${filename}`);
  console.log(DIVIDER);

  let buf;
  try {
    buf = readFileSync(filepath);
  } catch {
    console.log('  ERROR: file not found');
    continue;
  }

  // ── Step 1: Extract text ──────────────────────────────────────────────────
  let extracted;
  try {
    extracted = await extractPdfText(new Uint8Array(buf));
  } catch (e) {
    console.log(`  PDF EXTRACT ERROR: ${e.message}`);
    continue;
  }

  const { text, numPages, columnPages, repeatsRemoved } = extracted;
  const charCount = text.length;
  const lineCount = text.split('\n').filter(l => l.trim()).length;

  console.log(`  Pages: ${numPages}  |  Column-mode pages: ${columnPages}  |  Header/footer lines removed: ${repeatsRemoved}`);
  console.log(`  Extracted: ${charCount.toLocaleString()} chars, ${lineCount} non-blank lines`);

  if (charCount < 200) {
    console.log('  WARNING: Very little text extracted — PDF may be image-based or scanned');
  }

  // ── Step 2: Parse SoO ─────────────────────────────────────────────────────
  let parsed, totalHeaders, skipped;
  try {
    ({ result: parsed, totalHeaders, skipped } = await parseSoO(text));
  } catch (e) {
    console.log(`  PARSE ERROR: ${e.message}`);
    continue;
  }

  const totalChecks = parsed.functional.reduce((n, s) => n + s.checks.length, 0);
  console.log(`  Headers detected: ${totalHeaders}  |  Skipped: ${skipped}  |  Functional checks: ${totalChecks}  |  Alarms: ${parsed.alarms.length}`);

  // ── Step 3: Functional checks breakdown ───────────────────────────────────
  if (parsed.functional.length === 0) {
    console.log('  WARNING: No functional checks generated');
  } else {
    console.log(`\n  Functional Checks by Section:`);
    for (const sub of parsed.functional) {
      console.log(`  ${THIN.slice(0, 50)}`);
      console.log(`  [${sub.subsection}] — ${sub.checks.length} check(s)`);
      for (const c of sub.checks) {
        const firstLine = c.split('\n')[0];
        console.log(`    • ${firstLine}`);
      }
    }
  }

  // ── Step 4: Alarm items ───────────────────────────────────────────────────
  if (parsed.alarms.length > 0) {
    console.log(`\n  Alarms (${parsed.alarms.length}):`);
    for (const a of parsed.alarms.slice(0, 15)) {
      console.log(`    ⚠ ${a}`);
    }
    if (parsed.alarms.length > 15) console.log(`    … and ${parsed.alarms.length - 15} more`);
  }

  // ── Step 5: First 30 lines of extracted text (for debugging) ─────────────
  console.log(`\n  First 30 non-blank extracted lines:`);
  text.split('\n').filter(l => l.trim()).slice(0, 30).forEach((l, i) => {
    console.log(`    ${String(i+1).padStart(2)}: ${l.slice(0, 100)}`);
  });
}

console.log(`\n${DIVIDER}`);
console.log('Done.');
