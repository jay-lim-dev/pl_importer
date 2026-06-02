// ─── Constants ────────────────────────────────────────────────────────────────
var CONSTANTS = {
  KYLE_USER_ID: '5428089000000380001',
  KYLE_NAME: 'Kyle Kimball',
  TRANSITIONS: {
    enrolled_pl:    { id: '5428089000006963030', label: 'Enrolled PL' },
    ghosted_pl:     { id: '5428089000006963038', label: 'Ghosted PL' },
    turned_down_pl: { id: '5428089000280561156', label: 'Turned Down for PL' }
  },
  STATUS_MAP: {
    'closed-won': 'enrolled_pl'
  },
  PENDING_CLARIFICATION_STATUSES: ['chargeback', 'chargaback', 'fee adjustment'],
  PL_END_STAGES: ['Enrolled PL', 'Ghosted PL', 'Turned Down for PL'],
  SENT_TO_PL_STAGE: 'Sent to PL',
  FUZZY_MATCH_THRESHOLD: 0.6,
  UNASSIGNED_VALUES: ['unassigned', 'n/a', 'affiliates', 'sales agent', ''],
  REQUIRED_COLUMNS: ['Affiliate Rep', 'Date Enrolled in PL', 'Client Name', 'Loan Amount', 'Ref Fee', 'Email', 'Phone', 'Stage'],
  CRM_ORG_ID: '786428921',
  FUZZY_READY_THRESHOLD: 0.85
};

// ─── State ────────────────────────────────────────────────────────────────────
var state = {
  currentUser: null,
  usersMap: {},
  parsedRows: [],
  analyzedRows: [],
  auditLog: []
};

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
  window.scrollTo(0, 0);
}

function showError(msg) {
  var el = document.getElementById('upload-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('upload-error').style.display = 'none';
}

function setLoading(on, msg) {
  document.getElementById('upload-spinner').style.display = on ? 'flex' : 'none';
  document.getElementById('upload-form').style.display = on ? 'none' : 'block';
  if (on && msg) document.getElementById('analysis-progress').textContent = msg;
}

function setProgress(msg) {
  var el = document.getElementById('analysis-progress');
  if (el) el.textContent = msg;
}

function formatApiError(resp) {
  if (!resp) return 'No response from API';
  var code = resp.code || '';
  var msg  = resp.message || '';
  if (code === 'RATE_LIMIT' || code === 'API_LIMIT_EXCEEDED') {
    return 'API call limit reached — wait before retrying (code: ' + code + ')';
  }
  if (code && msg) return code + ': ' + msg;
  if (msg) return msg;
  return JSON.stringify(resp);
}

function getMissingFields(row) {
  var missing = [];
  if (!String(row['Ref Fee'] || '').trim()) missing.push('Revenue (Ref Fee)');
  if (!String(row['Loan Amount'] || '').trim()) missing.push('Loan Amount');
  if (!String(row['Date Enrolled in PL'] || '').trim()) missing.push('PL Enrolled Date');
  return missing;
}

function repDisplayName(rep) {
  if (!rep) return '—';
  if (rep.defaulted && !rep.flagged) return rep.resolvedName + ' (default for unassigned)';
  return rep.resolvedName;
}

function buildRepSelectHtml(analyzedIdx, currentUserId) {
  var users = Object.values(state.usersMap).sort(function(a, b) {
    return a.full_name.localeCompare(b.full_name);
  });
  var html = '<select class="rep-select" data-analyzed-idx="' + analyzedIdx + '" onclick="event.stopPropagation()">';
  users.forEach(function(u) {
    var sel = u.id === currentUserId ? ' selected' : '';
    html += '<option value="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.full_name) + '"' + sel + '>' + escapeHtml(u.full_name) + '</option>';
  });
  // Kyle as explicit fallback if not already in list
  if (!users.find(function(u) { return u.id === CONSTANTS.KYLE_USER_ID; })) {
    var sel = currentUserId === CONSTANTS.KYLE_USER_ID ? ' selected' : '';
    html += '<option value="' + CONSTANTS.KYLE_USER_ID + '" data-name="Kyle Kimball"' + sel + '>Kyle Kimball (default)</option>';
  }
  html += '</select>';
  return html;
}

function dealUrl(dealId) {
  return 'https://crm.zoho.com/crm/org' + CONSTANTS.CRM_ORG_ID + '/tab/Potentials/' + dealId;
}

function dealLinkHtml(deal) {
  if (!deal || !deal.id) return '';
  var name = escapeHtml(deal.Deal_Name || deal.Name || deal.id);
  var url  = escapeHtml(dealUrl(deal.id));
  return '<a href="' + url + '" target="_blank" class="deal-link">' + name + ' &#8599;</a> <span class="deal-id">' + escapeHtml(deal.id) + '</span>';
}

function dealLinksHtml(deals) {
  return deals.map(function(d, i) {
    var name = escapeHtml(d.Deal_Name || d.Name || d.id);
    var url  = escapeHtml(dealUrl(d.id));
    return '<span class="multi-deal-item">' +
      '<a href="' + url + '" target="_blank" class="deal-link">' + name + ' &#8599;</a>' +
      ' <span class="deal-id">' + escapeHtml(d.id) + '</span>' +
      '</span>';
  }).join('');
}

// ─── xlsx Parsing ─────────────────────────────────────────────────────────────
function parseXlsx(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var workbook = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        var sheet = workbook.Sheets[workbook.SheetNames[0]];
        // Read header row directly so empty cells in row 1 data don't hide column names
        var headerRow = (XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] || [])
          .map(function(h) { return String(h || '').trim(); });
        var rows = XLSX.utils.sheet_to_json(sheet, { raw: false, dateNF: 'yyyy-mm-dd' });
        resolve({ rows: rows, headers: headerRow });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function validateColumns(headers) {
  if (!headers || headers.length === 0) throw new Error('The file appears to be empty.');
  CONSTANTS.REQUIRED_COLUMNS.forEach(function(col) {
    if (!headers.includes(col)) {
      throw new Error("Column '" + col + "' not found — please check the file format.");
    }
  });
}

// ─── Fuzzy Matcher ────────────────────────────────────────────────────────────
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Bigram similarity between two individual words (handles 1-2 char typos)
function wordSimilarity(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0;
  if (a.length === 1 || b.length === 1) return a[0] === b[0] ? 0.5 : 0;
  var map = {};
  for (var i = 0; i < a.length - 1; i++) {
    var bg = a.slice(i, i + 2);
    map[bg] = (map[bg] || 0) + 1;
  }
  var hits = 0;
  for (var j = 0; j < b.length - 1; j++) {
    var bg = b.slice(j, j + 2);
    if (map[bg] > 0) { hits++; map[bg]--; }
  }
  return (2.0 * hits) / (a.length + b.length - 2);
}

// Score: average best word-similarity across all words in the CRM name
function fuzzyScore(input, crmName) {
  var a = normalize(input).split(' ');
  var b = normalize(crmName).split(' ');
  var total = 0;
  b.forEach(function(bWord) {
    var best = 0;
    a.forEach(function(aWord) {
      var s = wordSimilarity(aWord, bWord);
      if (s > best) best = s;
    });
    total += best;
  });
  return total / b.length;
}

function resolveRep(rawName) {
  var trimmed = (rawName || '').trim();
  var lower = trimmed.toLowerCase();

  if (CONSTANTS.UNASSIGNED_VALUES.includes(lower)) {
    return { userId: CONSTANTS.KYLE_USER_ID, resolvedName: CONSTANTS.KYLE_NAME, confidence: null, defaulted: true, flagged: false };
  }

  if (state.usersMap[lower]) {
    var u = state.usersMap[lower];
    return { userId: u.id, resolvedName: u.full_name, confidence: 1.0, defaulted: false, flagged: false };
  }

  var best = null, bestScore = 0;
  Object.keys(state.usersMap).forEach(function(name) {
    var score = fuzzyScore(trimmed, name);
    if (score > bestScore) { bestScore = score; best = state.usersMap[name]; }
  });

  if (bestScore >= CONSTANTS.FUZZY_MATCH_THRESHOLD) {
    return { userId: best.id, resolvedName: best.full_name, confidence: bestScore, defaulted: false, flagged: false };
  }

  return { userId: CONSTANTS.KYLE_USER_ID, resolvedName: CONSTANTS.KYLE_NAME, confidence: bestScore, defaulted: true, flagged: true, originalName: trimmed };
}

// ─── Phone Normalizer ─────────────────────────────────────────────────────────
function normalizePhone(raw) {
  var digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) digits = '1' + digits;
  if (digits.length !== 11) return null;
  return digits;
}

// ─── Deal Matching ────────────────────────────────────────────────────────────
function searchDeals(query) {
  return ZOHO.CRM.API.searchRecord({
    Entity: 'Deals',
    Type: 'criteria',
    Query: query
  }).then(function(resp) {
    // Rate-limited responses come back as { code: 'RATE_LIMIT', ... } — treat as empty, not a match
    if (resp && resp.code && resp.code !== 'SUCCESS' && !resp.data) return [];
    if (resp && resp.data && resp.data.length > 0) return resp.data;
    return [];
  }).catch(function() { return []; });
}

// Try all three tiers; stageFilter is a stage string or null (any stage)
function tryTiers(row, stageFilter) {
  var email = (row['Email'] || '').trim();
  var phone = (row['Phone'] || '').trim();
  var clientName = (row['Client Name'] || '').trim();

  function buildQ(field, value) {
    var q = '(' + field + ':equals:' + value + ')';
    if (stageFilter) q += 'and(Stage:equals:' + stageFilter + ')';
    return q;
  }

  var tier1 = email
    ? searchDeals(buildQ('Email', email))
    : Promise.resolve([]);

  return tier1.then(function(r1) {
    if (r1.length > 0) return { deals: r1, tier: 'Email' };

    var normalizedPhone = normalizePhone(phone);
    var tier2 = normalizedPhone
      ? searchDeals(buildQ('Mobile_Unformatted', normalizedPhone))
      : Promise.resolve([]);

    return tier2.then(function(r2) {
      if (r2.length > 0) return { deals: r2, tier: 'Phone' };

      var tier3 = clientName
        ? searchDeals(buildQ('Contact_Name.name', clientName))
        : Promise.resolve([]);

      return tier3.then(function(r3) {
        return { deals: r3, tier: r3.length > 0 ? 'Name' : null };
      });
    });
  });
}

function matchDeal(row) {
  return tryTiers(row, CONSTANTS.SENT_TO_PL_STAGE).then(function(result) {
    if (result.deals.length > 0) return result;
    // Fallback: search without stage filter to detect wrong-stage deals
    return tryTiers(row, null).then(function(fallback) {
      if (fallback.deals.length === 0) return { deals: [], tier: null };
      // If fallback found deals in Sent to PL, primary search missed them (API quirk) — treat as normal
      var sentToPL = fallback.deals.filter(function(d) { return d.Stage === CONSTANTS.SENT_TO_PL_STAGE; });
      if (sentToPL.length > 0) return { deals: sentToPL, tier: fallback.tier, otherStage: false };
      return { deals: fallback.deals, tier: fallback.tier, otherStage: true };
    });
  });
}

// ─── Row Analysis ─────────────────────────────────────────────────────────────
function analyzeRow(row) {
  var stageRaw = (row['Stage'] || '').trim();
  var stageLower = stageRaw.toLowerCase();
  var rep = resolveRep(row['Affiliate Rep']);

  if (CONSTANTS.PENDING_CLARIFICATION_STATUSES.includes(stageLower)) {
    return Promise.resolve({
      row: row, bucket: 'review', subReason: 'pending_clarification',
      reason: 'Chargeback/Fee Adjustment — pending clarification, will be skipped',
      rep: rep, deal: null, tier: null
    });
  }

  var transitionKey = CONSTANTS.STATUS_MAP[stageLower];
  var transition = transitionKey ? CONSTANTS.TRANSITIONS[transitionKey] : null;

  return matchDeal(row).then(function(matchResult) {
    var deals = matchResult.deals;
    var tier = matchResult.tier;
    var otherStage = matchResult.otherStage;

    if (deals.length === 0) {
      return { row: row, bucket: 'no_match', reason: 'No match found', rep: rep, deal: null, tier: null };
    }

    if (deals.length > 1 && !otherStage) {
      return {
        row: row, bucket: 'review', subReason: 'multiple_candidates',
        reason: deals.length + ' deals found in Sent to PL — go to CRM, resolve the duplicate, then re-upload',
        rep: rep, deal: null, allDeals: deals, tier: tier
      };
    }

    var deal = deals[0];
    var dealStage = deal.Stage || '';

    if (otherStage) {
      // Deal found but NOT in Sent to PL
      if (CONSTANTS.PL_END_STAGES.includes(dealStage)) {
        var skipReason = 'Already in ' + dealStage;
        if (dealStage.toLowerCase() !== stageRaw.toLowerCase()) {
          skipReason += ' (file says "' + stageRaw + '")';
        }
        return { row: row, bucket: 'skip', reason: skipReason, rep: rep, deal: deal, tier: tier };
      }
      return {
        row: row, bucket: 'review', subReason: 'wrong_stage',
        reason: 'Deal found in stage "' + dealStage + '" — not in Sent to PL',
        rep: rep, deal: deal, tier: tier
      };
    }

    if (!transition) {
      return {
        row: row, bucket: 'review', subReason: 'no_transition',
        reason: 'No transition mapped for stage "' + stageRaw + '"',
        rep: rep, deal: deal, tier: tier
      };
    }

    // Validate required fields before any actionable outcome
    var missingFields = getMissingFields(row);
    if (missingFields.length > 0) {
      return {
        row: row, bucket: 'review', subReason: 'missing_fields',
        reason: 'Missing required field' + (missingFields.length > 1 ? 's' : '') + ': ' + missingFields.join(', '),
        rep: rep, deal: deal, tier: tier
      };
    }

    // Name-only match → low-confidence review
    if (tier === 'Name') {
      var nameReason = 'Name-only match — low confidence';
      if (rep.flagged) nameReason += '; rep unresolvable — will default to Kyle (was: "' + rep.originalName + '")';
      return {
        row: row, bucket: 'review', subReason: 'name_match',
        reason: nameReason, rep: rep, deal: deal, tier: tier,
        transition: transition, includeInRun: true
      };
    }

    // Rep unresolvable → review, checkbox only, defaults to Kyle
    if (rep.flagged) {
      return {
        row: row, bucket: 'review', subReason: 'rep_unresolvable',
        reason: 'Rep name unresolvable — will default to Kyle (was: "' + rep.originalName + '")',
        rep: rep, deal: deal, tier: tier,
        transition: transition, includeInRun: true
      };
    }

    // Rep fuzzy-matched below high-confidence threshold → review with rep selector
    if (!rep.defaulted && rep.confidence !== null && rep.confidence < CONSTANTS.FUZZY_READY_THRESHOLD) {
      return {
        row: row, bucket: 'review', subReason: 'rep_fuzzy',
        reason: 'Rep matched at ' + Math.round(rep.confidence * 100) + '% confidence — please confirm',
        rep: rep, deal: deal, tier: tier,
        transition: transition, includeInRun: true
      };
    }

    return { row: row, bucket: 'ready', rep: rep, deal: deal, tier: tier, transition: transition };
  });
}

function analyzeAllRows(rows, onProgress) {
  var CONCURRENCY = 5;
  var results     = new Array(rows.length);
  var started     = 0;
  var completed   = 0;

  return new Promise(function(resolve) {
    function startNext() {
      if (started >= rows.length) return;
      var idx = started++;
      analyzeRow(rows[idx]).then(function(result) {
        results[idx] = result;
        completed++;
        if (onProgress) onProgress(completed, rows.length);
        if (completed === rows.length) {
          resolve(results);
        } else {
          startNext();
        }
      });
    }
    // Seed the initial batch
    var seed = Math.min(CONCURRENCY, rows.length);
    for (var i = 0; i < seed; i++) startNext();
  });
}

// ─── Confirmation Screen ──────────────────────────────────────────────────────
function setBucket(bucketId, summaryId, count) {
  var summaryEl = document.getElementById(summaryId);
  if (summaryEl) {
    summaryEl.textContent = count;
    summaryEl.closest('.sum-item').style.display = count > 0 ? '' : 'none';
  }
  var bodyEl = document.getElementById(bucketId);
  if (bodyEl) bodyEl.closest('.section-card').style.display = count > 0 ? '' : 'none';
}

function renderConfirmationScreen(analyzedRows) {
  var ready   = analyzedRows.filter(function(r) { return r.bucket === 'ready'; });
  var review  = analyzedRows.filter(function(r) { return r.bucket === 'review' && !!(r.transition && r.deal); });
  var fix     = analyzedRows.filter(function(r) { return r.bucket === 'review' && !(r.transition && r.deal); });
  var skip    = analyzedRows.filter(function(r) { return r.bucket === 'skip'; });
  var noMatch = analyzedRows.filter(function(r) { return r.bucket === 'no_match'; });

  setBucket('bucket-ready',   'summary-ready',   ready.length);
  setBucket('bucket-review',  'summary-review',  review.length);
  setBucket('bucket-fix',     'summary-fix',     fix.length);
  setBucket('bucket-skip',    'summary-skip',    skip.length);
  setBucket('bucket-nomatch', 'summary-nomatch', noMatch.length);

  renderReadyBucket(ready);
  renderReviewOnlyBucket(review);
  renderFixBucket(fix);
  renderSimpleBucket('bucket-skip', skip);
  renderSimpleBucket('bucket-nomatch', noMatch);

  document.getElementById('btn-run-import').disabled = ready.length === 0 && review.length === 0;
  showScreen('screen-confirm');
}

function renderReadyBucket(rows) {
  var el = document.getElementById('bucket-ready');
  if (rows.length === 0) { el.innerHTML = '<p class="empty-bucket">None</p>'; return; }
  var html = '';
  rows.forEach(function(r) {
    var confStr = (r.rep.confidence !== null && r.rep.confidence < 1)
      ? ' (' + Math.round(r.rep.confidence * 100) + '%)' : '';
    html += '<div class="row-item">';
    html += '<div class="row-summary clickable" onclick="toggleExpand(this)">';
    html += '<span class="row-name">' + escapeHtml(r.row['Client Name']) + '</span>';
    html += '<span class="row-meta">via ' + escapeHtml(r.tier) + ' &middot; ' + escapeHtml(repDisplayName(r.rep)) + escapeHtml(confStr) + '</span>';
    html += '<span class="expand-arrow">&#9654;</span>';
    html += '</div>';
    html += '<div class="row-detail" style="display:none">';
    html += '<p><strong>Deal:</strong> ' + dealLinkHtml(r.deal) + '</p>';
    html += '<p><strong>Match method:</strong> ' + escapeHtml(r.tier) + '</p>';
    html += '<p><strong>Transition:</strong> ' + escapeHtml(r.transition.label) + '</p>';
    html += '<p><strong>PL Sender Name:</strong> ' + escapeHtml(repDisplayName(r.rep)) + (r.rep.confidence !== null && !r.rep.defaulted ? ' (' + Math.round(r.rep.confidence * 100) + '% confidence)' : '') + '</p>';
    html += '<p><strong>Loan Amount:</strong> ' + escapeHtml(r.row['Loan Amount']) + ' &nbsp; <strong>Revenue:</strong> ' + escapeHtml(r.row['Ref Fee']) + '</p>';
    html += '<p><strong>PL Enrolled Date:</strong> ' + escapeHtml(r.row['Date Enrolled in PL']) + '</p>';
    html += '</div></div>';
  });
  el.innerHTML = html;
}

function renderReviewOnlyBucket(rows) {
  var el = document.getElementById('bucket-review');
  if (rows.length === 0) { el.innerHTML = '<p class="empty-bucket">None</p>'; return; }
  var html = '<p class="review-hint">Uncheck any row to exclude it from this import run.</p>';
  rows.forEach(function(r) {
    var isFuzzy = r.subReason === 'rep_fuzzy';
    html += '<div class="row-item' + (isFuzzy ? ' row-item-fuzzy' : '') + '">';

    html += '<div class="row-summary clickable" onclick="toggleExpand(this)">';
    html += '<input type="checkbox" class="review-checkbox" data-analyzed-idx="' + r._analyzedIdx + '" ' + (r.includeInRun ? 'checked' : '') + ' onclick="event.stopPropagation()">';
    html += '<span class="row-name">' + escapeHtml(r.row['Client Name']) + '</span>';
    html += '<span class="row-reason warning">' + escapeHtml(r.reason) + '</span>';
    html += '<span class="expand-arrow">&#9654;</span>';
    html += '</div>';

    if (isFuzzy) {
      html += '<div class="rep-confirm-row">';
      html += '<label class="rep-confirm-label">PL Sender Name:</label>';
      html += buildRepSelectHtml(r._analyzedIdx, r.rep.userId);
      html += '<span class="rep-file-value">file says: &ldquo;' + escapeHtml(r.row['Affiliate Rep'] || '') + '&rdquo;</span>';
      html += '</div>';
    }

    html += '<div class="row-detail" style="display:none">';
    html += '<p><strong>Deal:</strong> ' + dealLinkHtml(r.deal) + '</p>';
    html += '<p><strong>Match method:</strong> ' + escapeHtml(r.tier) + '</p>';
    if (r.transition) html += '<p><strong>Transition:</strong> ' + escapeHtml(r.transition.label) + '</p>';
    if (!isFuzzy) html += '<p><strong>PL Sender Name:</strong> ' + escapeHtml(repDisplayName(r.rep)) + '</p>';
    html += '</div></div>';
  });
  el.innerHTML = html;
}

function renderFixBucket(rows) {
  var el = document.getElementById('bucket-fix');
  var banner = '<p class="fix-banner">These rows cannot be imported this run. Correct the issues below and re-upload.</p>';
  if (rows.length === 0) { el.innerHTML = banner + '<p class="empty-bucket">None</p>'; return; }
  var html = banner;
  rows.forEach(function(r) {
    var hasDeal      = !!(r.deal && r.deal.id);
    var hasMultiDeal = !!(r.allDeals && r.allDeals.length > 0);
    var expandable   = hasDeal || hasMultiDeal;
    html += '<div class="row-item">';
    html += '<div class="row-summary' + (expandable ? ' clickable' : '') + '"' + (expandable ? ' onclick="toggleExpand(this)"' : '') + '>';
    html += '<span class="row-name">' + escapeHtml(r.row['Client Name']) + '</span>';
    html += '<span class="row-reason fix-reason">' + escapeHtml(r.reason) + '</span>';
    if (expandable) html += '<span class="expand-arrow">&#9654;</span>';
    html += '</div>';
    if (expandable) {
      html += '<div class="row-detail" style="display:none">';
      if (hasMultiDeal) {
        html += '<p><strong>Matching deals:</strong></p>';
        html += '<div class="multi-deal-list">' + dealLinksHtml(r.allDeals) + '</div>';
      } else {
        html += '<p><strong>Deal:</strong> ' + dealLinkHtml(r.deal) + '</p>';
      }
      if (r.tier) html += '<p><strong>Match method:</strong> ' + escapeHtml(r.tier) + '</p>';
      html += '</div>';
    }
    html += '</div>';
  });
  el.innerHTML = html;
}

function renderSimpleBucket(containerId, rows) {
  var el = document.getElementById(containerId);
  if (rows.length === 0) { el.innerHTML = '<p class="empty-bucket">None</p>'; return; }
  var html = '';
  rows.forEach(function(r) {
    var hasDeal = !!(r.deal && r.deal.id);
    html += '<div class="row-item">';
    html += '<div class="row-summary' + (hasDeal ? ' clickable' : '') + '"' + (hasDeal ? ' onclick="toggleExpand(this)"' : '') + '>';
    html += '<span class="row-name">' + escapeHtml(r.row['Client Name']) + '</span>';
    if (r.reason) html += '<span class="row-meta">' + escapeHtml(r.reason) + '</span>';
    if (hasDeal) html += '<span class="expand-arrow">&#9654;</span>';
    html += '</div>';
    if (hasDeal) {
      html += '<div class="row-detail" style="display:none">';
      html += '<p><strong>Deal:</strong> ' + dealLinkHtml(r.deal) + '</p>';
      if (r.tier) html += '<p><strong>Match method:</strong> ' + escapeHtml(r.tier) + '</p>';
      html += '</div>';
    }
    html += '</div>';
  });
  el.innerHTML = html;
}

function toggleExpand(el) {
  var parent = el.closest('.row-item');
  var detail = parent.querySelector('.row-detail');
  var arrow  = el.querySelector('.expand-arrow');
  if (!detail) return;
  if (detail.style.display === 'none') {
    detail.style.display = 'block';
    arrow.innerHTML = '&#9660;';
  } else {
    detail.style.display = 'none';
    arrow.innerHTML = '&#9654;';
  }
}

function toggleSection(id) {
  var body   = document.getElementById(id);
  var toggle = document.getElementById('toggle-' + id);
  body.classList.toggle('collapsed');
  if (toggle) toggle.innerHTML = body.classList.contains('collapsed') ? '&#9654;' : '&#9660;';
}

// ─── Execution Engine ─────────────────────────────────────────────────────────
function runImport() {
  // Sync checkbox states from DOM before filtering
  document.querySelectorAll('.review-checkbox').forEach(function(cb) {
    var idx = parseInt(cb.getAttribute('data-analyzed-idx'), 10);
    if (!isNaN(idx)) state.analyzedRows[idx].includeInRun = cb.checked;
  });

  // Sync rep dropdown selections for fuzzy-matched rows
  document.querySelectorAll('.rep-select').forEach(function(sel) {
    var idx = parseInt(sel.getAttribute('data-analyzed-idx'), 10);
    if (isNaN(idx)) return;
    var r = state.analyzedRows[idx];
    var opt = sel.options[sel.selectedIndex];
    if (opt) {
      r.rep = Object.assign({}, r.rep, {
        userId:      opt.value,
        resolvedName: opt.getAttribute('data-name') || opt.text
      });
    }
  });

  var toProcess = state.analyzedRows.filter(function(r) {
    if (r.bucket === 'ready') return true;
    if (r.bucket === 'review' && r.transition && r.deal && r.includeInRun) return true;
    return false;
  });

  if (toProcess.length === 0) {
    alert('No rows selected to process.');
    return;
  }

  showScreen('screen-progress');
  state.auditLog = [];

  var progressList = document.getElementById('progress-list');
  progressList.innerHTML = '';
  toProcess.forEach(function(r, i) {
    var div = document.createElement('div');
    div.className = 'progress-item';
    div.innerHTML =
      '<span class="progress-name">' + escapeHtml(r.row['Client Name'] || '') + '</span>' +
      '<span class="progress-status status-pending" id="ps-' + i + '">Pending</span>';
    progressList.appendChild(div);
  });

  var i = 0;
  function processNext() {
    if (i >= toProcess.length) {
      buildSkipAndNoMatchAuditEntries();
      renderAuditReport();
      return;
    }

    var r = toProcess[i];
    var idx = i;
    i++;

    var statusEl = document.getElementById('ps-' + idx);
    statusEl.textContent = 'Processing…';
    statusEl.className = 'progress-status status-processing';

    var enrolledDate = (r.row['Date Enrolled in PL'] || '').trim();
    var loanAmount   = parseFloat(String(r.row['Loan Amount']).replace(/[^0-9.]/g, '')) || 0;
    var refFee       = parseFloat(String(r.row['Ref Fee']).replace(/[^0-9.]/g, '')) || 0;

    function recordOutcome(success, errorMsg) {
      statusEl.textContent = success ? 'Success ✓' : 'Failed ✗';
      statusEl.className   = 'progress-status ' + (success ? 'status-success' : 'status-failed');
      state.auditLog.push({
        clientName:  r.row['Client Name'] || '',
        email:       r.row['Email'] || '',
        outcome:     success ? 'Transitioned' : 'Failed',
        transition:  r.transition.label,
        dealId:      r.deal.id,
        matchMethod: r.tier || '—',
        repResolved: repDisplayName(r.rep),
        error:       errorMsg || '',
        timestamp:   new Date().toISOString()
      });
      processNext();
    }

    var callResult;
    try {
      callResult = ZOHO.CRM.API.updateBluePrint({
        Entity: 'Deals',
        RecordID: r.deal.id,
        BlueprintData: {
          blueprint: [{
            transition_id: r.transition.id,
            data: {
              PL_Sender_Name: { id: r.rep.userId },
              PL_Enrolled_Date: enrolledDate,
              Loan_Amount: loanAmount,
              Revenue: refFee
            }
          }]
        }
      });
    } catch (syncErr) {
      console.error('updateBluePrint sync error:', syncErr);
      recordOutcome(false, 'Sync error: ' + String(syncErr));
      return;
    }

    if (!callResult || typeof callResult.then !== 'function') {
      console.error('updateBluePrint did not return a promise:', callResult);
      recordOutcome(false, 'updateBluePrint did not return a promise');
      return;
    }

    // Safety timeout — prevents UI from hanging if the promise never settles
    var settled = false;
    var timeoutId = setTimeout(function() {
      if (settled) return;
      settled = true;
      console.error('updateBluePrint timed out for deal', r.deal.id);
      recordOutcome(false, 'Request timed out after 30s');
    }, 30000);

    callResult.then(function(resp) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      var success = resp && (resp.status === 'success' || resp.code === 'SUCCESS');
      recordOutcome(success, success ? '' : formatApiError(resp));
    }).catch(function(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      console.error('updateBluePrint rejected:', err);
      recordOutcome(false, String(err));
    });
  }

  processNext();
}

function buildSkipAndNoMatchAuditEntries() {
  state.analyzedRows.forEach(function(r) {
    // Skip rows already added via processNext (ready + included review rows)
    var wasProcessed = (r.bucket === 'ready') ||
                       (r.bucket === 'review' && r.transition && r.deal && r.includeInRun);
    if (wasProcessed) return;

    var entry = {
      clientName:  r.row['Client Name'] || '',
      email:       r.row['Email'] || '',
      outcome:     '',
      transition:  '—',
      dealId:      (r.deal && r.deal.id) ? r.deal.id : '—',
      matchMethod: r.tier || '—',
      repResolved: r.rep ? repDisplayName(r.rep) : '—',
      error:       '',
      timestamp:   new Date().toISOString()
    };

    if (r.bucket === 'skip') {
      entry.outcome = 'Skipped';
    } else if (r.bucket === 'no_match') {
      entry.outcome = 'No Match';
    } else if (r.bucket === 'review' && r.subReason === 'pending_clarification') {
      entry.outcome = 'Pending Clarification';
    } else if (r.bucket === 'review' && r.subReason === 'missing_fields') {
      entry.outcome = 'Fix Required';
      entry.error   = r.reason;
    } else if (r.bucket === 'review' && !(r.transition && r.deal)) {
      entry.outcome = 'Skipped';
      entry.error   = r.reason;
    } else if (r.bucket === 'review') {
      entry.outcome = 'Skipped (manual)';
    } else {
      entry.outcome = 'Skipped';
    }

    state.auditLog.push(entry);
  });
}

// ─── Audit Report ─────────────────────────────────────────────────────────────
function renderAuditReport() {
  var runUser = state.currentUser
    ? (state.currentUser.full_name || state.currentUser.email || 'Unknown')
    : 'Unknown';
  document.getElementById('audit-run-info').textContent =
    'Run by: ' + runUser + '  ·  ' + new Date().toLocaleString();

  var counts = { Transitioned: 0, Skipped: 0, Failed: 0, 'No Match': 0, 'Pending Clarification': 0 };
  state.auditLog.forEach(function(l) {
    var k = l.outcome.startsWith('Skipped') ? 'Skipped' : l.outcome;
    if (counts[k] !== undefined) counts[k]++;
  });

  document.getElementById('audit-summary').innerHTML =
    '<span class="audit-count transitioned">' + counts.Transitioned + ' transitioned</span>' +
    '<span class="audit-count skipped">' + counts.Skipped + ' skipped</span>' +
    '<span class="audit-count failed">' + counts.Failed + ' failed</span>' +
    '<span class="audit-count nomatch">' + counts['No Match'] + ' no match</span>' +
    '<span class="audit-count pending">' + counts['Pending Clarification'] + ' pending</span>';

  var rows = '';
  state.auditLog.forEach(function(l) {
    var badgeClass = 'outcome-' + l.outcome.toLowerCase().replace(/[^a-z]/g, '-');
    rows += '<tr>' +
      '<td>' + escapeHtml(l.clientName) + '</td>' +
      '<td>' + escapeHtml(l.email) + '</td>' +
      '<td><span class="outcome-badge ' + badgeClass + '">' + escapeHtml(l.outcome) + '</span></td>' +
      '<td>' + escapeHtml(l.transition) + '</td>' +
      '<td class="monospace">' + escapeHtml(l.dealId) + '</td>' +
      '<td>' + escapeHtml(l.matchMethod) + '</td>' +
      '<td>' + escapeHtml(l.repResolved) + '</td>' +
      '<td class="error-cell">' + escapeHtml(l.error) + '</td>' +
      '<td class="monospace">' + escapeHtml(l.timestamp) + '</td>' +
      '</tr>';
  });
  document.getElementById('audit-tbody').innerHTML = rows;

  showScreen('screen-audit');
}

function exportCsv() {
  var headers = ['Client Name', 'Email', 'Outcome', 'Transition', 'Deal ID', 'Match Method', 'Rep Resolved', 'Error', 'Timestamp'];
  var lines = [headers.map(csvEsc).join(',')];
  state.auditLog.forEach(function(l) {
    lines.push([
      l.clientName, l.email, l.outcome, l.transition,
      l.dealId, l.matchMethod, l.repResolved, l.error, l.timestamp
    ].map(csvEsc).join(','));
  });
  var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url;
  a.download = 'pl_import_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function csvEsc(val) {
  var s = String(val === null || val === undefined ? '' : val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ─── File Handling ────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file.name.match(/\.(xlsx|csv)$/i)) {
    showError('Please upload an .xlsx or .csv file.');
    return;
  }
  hideError();
  setLoading(true, 'Parsing file…');

  parseXlsx(file).then(function(result) {
    var rows = result.rows;
    try {
      validateColumns(result.headers);
    } catch (e) {
      setLoading(false);
      showError(e.message);
      return;
    }
    if (rows.length === 0) {
      setLoading(false);
      showError('The file appears to be empty.');
      return;
    }
    state.parsedRows = rows;
    setProgress('Analyzing row 1 of ' + rows.length + '…');

    analyzeAllRows(rows, function(current, total) {
      setProgress('Analyzing row ' + current + ' of ' + total + '…');
    }).then(function(analyzed) {
      analyzed.forEach(function(r, i) { r._analyzedIdx = i; });
      state.analyzedRows = analyzed;
      setLoading(false);
      renderConfirmationScreen(analyzed);
    });
  }).catch(function(err) {
    setLoading(false);
    showError('Failed to parse file: ' + (err.message || String(err)));
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {

  Promise.all([
    ZOHO.CRM.CONFIG.getCurrentUser().then(function(d) {
      state.currentUser = (d && d.users && d.users[0]) ? d.users[0] : d;
    }).catch(function() {}),
    ZOHO.CRM.API.getAllUsers({ Type: 'ActiveUsers' }).then(function(d) {
      var users = (d && d.users) ? d.users : [];
      users.forEach(function(u) {
        if (u.full_name) state.usersMap[u.full_name.toLowerCase()] = { id: u.id, full_name: u.full_name };
      });
    }).catch(function() {})
  ]).then(function() {
    showScreen('screen-upload');
  });
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  var dropZone  = document.getElementById('drop-zone');
  var fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', function() { fileInput.click(); });
  dropZone.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

  dropZone.addEventListener('dragover', function(e) {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', function() {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', function(e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    var file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener('change', function() {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
    fileInput.value = '';
  });

  document.getElementById('btn-run-import').addEventListener('click', runImport);

  document.getElementById('btn-export-csv').addEventListener('click', exportCsv);

  document.getElementById('btn-new-import').addEventListener('click', function() {
    state.parsedRows = [];
    state.analyzedRows = [];
    state.auditLog = [];
    document.getElementById('file-input').value = '';
    hideError();
    showScreen('screen-upload');
  });
});

// ─── SDK Entry Point ──────────────────────────────────────────────────────────
ZOHO.embeddedApp.on('PageLoad', function() {
  init();
});
ZOHO.embeddedApp.init();
