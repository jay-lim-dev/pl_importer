# PL Importer Widget — Claude Code Session Brief

> Read this entire document before writing a single line of code.
> This is a fully spec'd build — do not make architectural decisions not covered here without asking first.

---

## What We Are Building

A Zoho CRM Widget (ZET Web Tab) that lets a user upload a monthly PL loans spreadsheet and automatically transition matching Deals through the blueprint to their correct PL stages. It includes a confirmation screen before execution and a full audit report after.

---

## Environment

| Item | Detail |
|---|---|
| ZET CLI | `/Users/jaylim/.npm-global/bin/zet` |
| Widget type | ZET Web Tab (single widget, single HTML page) |
| CRM region | `.com` (api.zoho.com / crm.zoho.com) |
| Local dev server | `https://127.0.0.1:5000` |
| ngrok static domain | `decompose-pennant-hedge.ngrok-free.dev` |
| Tech stack | Vanilla HTML / CSS / JS only — no React, no Tailwind, no external libraries |
| SDK CDN | `https://live.zwidgets.com/js-sdk/1.0/ZohoEmbededAppSDK.min.js` |

**ZET cannot run inside Claude Code.** All `zet` commands must be run by the user in their own terminal.

---

## Project Setup

```bash
mkdir pl_importer && cd pl_importer
zet init
# Select: Zoho CRM
# Project name: pl_importer   ← underscores only, no hyphens
```

ZET creates `pl_importer/` containing: `app/`, `plugin-manifest.json`, `package.json`, `server/index.js`, `cert.pem`, `key.pem`

### File Structure

```
pl_importer/
  app/
    index.html       ← single entry point
    styles.css
    app.js
  plugin-manifest.json
  package.json
  server/
    index.js
```

### .gitignore
```
node_modules/
dist/
cert.pem
key.pem
.DS_Store
```

### plugin-manifest.json
```json
{
  "service": "CRM",
  "name": "PL Importer",
  "version": "1.0",
  "platform_version": "1.0",
  "modules": {
    "widgets": [
      {
        "location": "crm.webtab",
        "url": "app/index.html"
      }
    ]
  }
}
```

Note: `storage: true` is NOT needed — we use localStorage (namespaced by user ID) instead. `ZOHO.CRM.WIDGET.STORE` does not exist in this SDK version.

---

## Spreadsheet Format (Rigid — V1)

The widget accepts exactly this column structure. Any deviation throws a visible error to the user.

| Column | Maps To (CRM Field) | CRM API Name | Notes |
|---|---|---|---|
| `Affiliate Rep` | PL Sender Name | `PL_Sender_Name` | User lookup field — name must be resolved to User ID |
| `Date Enrolled in PL` | PL Enrolled Date | `PL_Enrolled_Date` | Date field |
| `Client Name` | (matching only) | — | Used as Tier 3 fallback for deal matching |
| `Loan Amount` | Loan Amount | `Loan_Amount` | Number field |
| `Ref Fee` | Revenue | `Revenue` | Number field |
| `Email` | (matching only) | — | Tier 1 for deal matching |
| `Phone` | (matching only) | — | Tier 2 for deal matching |
| `Stage` | (determines transition) | — | See Status Mapping below |

**Required columns check:** On file parse, verify all 8 column headers exist exactly. If any are missing, show error: `"Column '[name]' not found — please check the file format."` and halt.

---

## Status → Blueprint Transition Mapping

| Spreadsheet Stage Value | CRM Transition | Transition ID |
|---|---|---|
| `Closed-Won` | Enrolled PL | `5428089000006963030` |
| `CHARGEBACK`, `CHARGABACK` (typo variant in data) | Pending clarification | — |
| `FEE ADJUSTMENT`, `Fee Adjustment` | Pending clarification | — |

**Important:** Chargeback and Fee Adjustment rows must be placed in the ⚠️ Review bucket with status `"Pending clarification — skip for now"`. Do NOT attempt to transition them. This will be wired up once Jeff confirms the target stage.

The status matching must be **case-insensitive** to handle the inconsistencies seen in the real data.

---

## Affiliate Rep → User ID Resolution

**Critical data quality issue:** The real spreadsheet has severely inconsistent rep name spelling across ~100+ variants (e.g. "Meg Lapicz", "MEG LAPIZZ", "Meg Lapics", "Meg Lapis", "MEG LAPIZ" all refer to the same person). A simple exact-match lookup will fail for the majority of rows.

### Resolution Strategy

1. On widget load, fetch all CRM users once via `ZOHO.CRM.CONFIG.getCurrentUser()` and `ZOHO.CRM.API.getAllUsers({ Type: "ActiveUsers" })`. Build a map of `fullName (lowercase) → userId`.

2. For each row's Affiliate Rep value:
   - **Step 1:** Try exact match (case-insensitive)
   - **Step 2:** Try fuzzy match — implement a simple fuzzy scorer (see below)
   - **Step 3:** If match confidence < threshold → flag as ⚠️ "Rep name unresolvable — will default to Kyle"
   - **Unassigned / N/A / affiliates / sales agent / blank:** Default to Kyle without flagging

3. **Default User (Kyle):**
   - Name: Kyle
   - User ID: `5428089000000380001`
   - Applied to: `Unassigned`, `N/A`, `n/a`, `affiliates`, `sales agent`, empty/blank, and any unresolvable name

### Simple Fuzzy Matcher (implement this)

```javascript
// Normalize: lowercase, remove punctuation, collapse spaces
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Score: what fraction of words in the CRM name appear in the input name
function fuzzyScore(input, crmName) {
  var a = normalize(input).split(' ');
  var b = normalize(crmName).split(' ');
  var matches = b.filter(function(word) { return a.includes(word); });
  return matches.length / b.length;
}

// Usage: score >= 0.6 = accept match, < 0.6 = flag for default
```

Show the resolved name and confidence on the confirmation screen so the user can spot bad matches.

---

## Deal Matching Logic

For each spreadsheet row, find the matching CRM Deal using this tiered approach. The deal **must be in "Sent to PL" stage** to be eligible.

### CRM Field API Names for Search
| Spreadsheet Column | CRM Field | API Name |
|---|---|---|
| Email | Email | `Email` |
| Phone | Mobile Unformatted | `Mobile_Unformatted` |
| Client Name | Contact Name (lookup — string subfield) | `Contact_Name.name` |

### Tier 1 — Email
```javascript
ZOHO.CRM.API.searchRecord({
  Entity: "Deals",
  Type: "criteria",
  Query: "(Email:equals:" + email + ")and(Stage:equals:Sent to PL)"
})
```

### Tier 2 — Phone (if Tier 1 fails or no email in row)
`Mobile_Unformatted` stores phone numbers as digits only with country code, e.g. `19173528296`.
Normalize the spreadsheet phone value before searching:

```javascript
function normalizePhone(raw) {
  var digits = String(raw).replace(/\D/g, '');   // strip all non-digits
  if (digits.length === 10) digits = '1' + digits; // add US country code if missing
  if (digits.length !== 11) return null;           // malformed — skip Tier 2
  return digits;
}

var normalizedPhone = normalizePhone(row['Phone']);
if (normalizedPhone) {
  ZOHO.CRM.API.searchRecord({
    Entity: "Deals",
    Type: "criteria",
    Query: "(Mobile_Unformatted:equals:" + normalizedPhone + ")and(Stage:equals:Sent to PL)"
  });
}
// If normalizedPhone is null, skip Tier 2 and fall through to Tier 3
```

### Tier 3 — Client Name (last resort, single-step)
`Contact_Name` on a Deal is a lookup field that returns `{ name: "Cesar Serrano", id: "..." }`. Use the `.name` subfield to search directly on Deals — no need to go through Contacts first.

```javascript
ZOHO.CRM.API.searchRecord({
  Entity: "Deals",
  Type: "criteria",
  Query: "(Contact_Name.name:equals:" + clientName + ")and(Stage:equals:Sent to PL)"
})
```

Note: this is an exact match — if the name in the spreadsheet has a typo or formatting difference vs CRM, it will not match. Tier 3 misses go to ❌ No Match rather than attempting further fuzzy logic.

### Match Rules
- **One deal found in "Sent to PL"** → proceed, note match tier (Email / Phone / Name)
- **Multiple deals found in "Sent to PL" for same contact** → flag as ⚠️ "Multiple candidates — manual review required", skip execution (V2: inline picker)
- **Deal found but NOT in "Sent to PL"** → check if it's in a PL end stage (see below)
- **No deal found at any tier** → flag as ❌ "No match found"

### PL End Stages (already dispositioned — skip)
If a matched deal is already in one of these stages, place in 🔄 Skip bucket:
- `Enrolled PL`
- `Ghosted PL`
- `Turned Down for PL`

Also note: if the deal's current stage doesn't match what the spreadsheet says (e.g., CRM shows "Enrolled PL" but spreadsheet says "Closed-Won"), flag it as ⚠️ Review rather than silently skipping — this is important for the audit trail.

---

## Blueprint Transition API Call

When executing a transition, use `ZOHO.CRM.API.updateBluePrint`:

```javascript
ZOHO.CRM.API.updateBluePrint({
  Entity: "Deals",
  RecordID: dealId,
  BlueprintData: {
    blueprint: [{
      transition_id: transitionId,   // e.g. "5428089000006963030"
      data: {
        PL_Sender_Name: { id: userId },   // user lookup field — pass as object with id
        PL_Enrolled_Date: enrolledDate,   // ISO date string "YYYY-MM-DD" — verify format on first test
        Loan_Amount: loanAmount,          // number
        Revenue: refFee                   // number
      }
  // ⚠️ VERIFY ON FIRST TEST: Confirm PL_Sender_Name accepts { id: userId } format.
  // If the transition returns a field validation error, try passing the user ID as a plain string instead.
  // ⚠️ VERIFY ON FIRST TEST: Confirm PL_Enrolled_Date accepts "YYYY-MM-DD" string format.
  // Log the raw parsed date from SheetJS before the first transition call to confirm.
    }]
  }
})
```

**Error handling:** Wrap every transition call in try/catch. On failure, capture the exact error message/code from the response and store it in the audit log for that row. Never fail silently.

---

## Widget UI — Four Screens

### Screen 1: Upload
- Clean drag-and-drop + file picker for `.xlsx` files
- "Upload & Analyze" button
- Shows loading spinner during parse + matching + user lookup

### Screen 2: Confirmation
**Summary bar at top:**
```
✅ 23 ready   ⚠️ 4 need review   🔄 2 already done   ❌ 1 no match
```

**Four collapsible sections:**

| Bucket | Icon | Description |
|---|---|---|
| Ready | ✅ | Matched, fields resolved, in Sent to PL, transition known |
| Review | ⚠️ | Needs attention — see sub-reasons below |
| Skip | 🔄 | Already in a PL end stage |
| No Match | ❌ | No deal found at any tier |

**⚠️ Review sub-reasons:**
- `Multiple candidates found — select manually`
- `Rep name unresolvable — will default to Kyle` (with what name was in file)
- `Chargeback/Fee Adjustment — pending clarification, will be skipped`
- `Stage mismatch — deal already in [stage] but file says [status]`
- `Name-only match — low confidence`

**Each row in ✅ Ready is expandable** to show:
- Matched deal name + ID
- Match method (Email / Phone / Name)
- Fields that will be written
- Resolved rep name + confidence

**⚠️ Review rows have individual checkboxes** — user can include/exclude before confirming.

**"Run Import" button** — only enabled if at least one ✅ Ready row exists.

### Screen 3: Execution Progress
- Per-row progress as transitions fire
- Real-time status: processing / success / failed
- Cannot be cancelled mid-run

### Screen 4: Audit Report
**Summary counts** + **full table** with every row:

| Column | Detail |
|---|---|
| Client Name | From spreadsheet |
| Email | From spreadsheet |
| Outcome | `Transitioned` / `Skipped` / `Failed` / `No Match` / `Pending Clarification` |
| Transition | Which transition was called (if any) |
| Deal ID | Matched deal ID |
| Match Method | Email / Phone / Name / — |
| Rep Resolved | Name used for PL Sender Name |
| Error | Error message if failed |
| Timestamp | When this row was processed |

**Export as CSV button** — generates downloadable CSV of the full table.

**Run timestamp + CRM user who ran it** shown at top of report.

---

## SDK Patterns to Use

### Initialization (Web Tab)
```javascript
ZOHO.embeddedApp.on("PageLoad", function(data) {
  // data may be empty for a web tab — that's fine, we don't need record context
  init();
});
ZOHO.embeddedApp.init();
```

### Get Current User (for audit log)
```javascript
ZOHO.CRM.CONFIG.getCurrentUser().then(function(data) {
  currentUser = data; // { id, full_name, email }
});
```

### Fetch All Active Users (for rep name resolution)
```javascript
ZOHO.CRM.API.getAllUsers({ Type: "ActiveUsers" }).then(function(data) {
  // data.users = [{ id, full_name, email, ... }]
  // Default page size is 200. If org grows beyond 200 active users, add pagination.
  // For current org size this single call is sufficient.
});
```

### localStorage (namespaced — for any state persistence needed)
```javascript
var _key = null;
function getStorageKey() {
  if (_key) return Promise.resolve(_key);
  return ZOHO.CRM.CONFIG.getCurrentUser()
    .then(function(d) { _key = 'pl_importer_' + ((d && d.id) || 'default'); return _key; })
    .catch(function() { _key = 'pl_importer_default'; return _key; });
}
```

### HTML Escaping (always escape CRM data before innerHTML)
```javascript
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```

---

## xlsx Parsing (Browser-Side)

Use **SheetJS (xlsx)** loaded from CDN — it's the only external library allowed for this project since we need browser-side xlsx parsing:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
```

```javascript
function parseXlsx(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var workbook = XLSX.read(e.target.result, { type: 'array', cellDates: true });
        var sheet = workbook.Sheets[workbook.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(sheet, { raw: false, dateNF: 'yyyy-mm-dd' });
        resolve(rows);
      } catch(err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
```

**Required columns** (validate on parse — exact header match after trim):
`['Affiliate Rep', 'Date Enrolled in PL', 'Client Name', 'Loan Amount', 'Ref Fee', 'Email', 'Phone', 'Stage']`

---

## Known Data Quality Issues (from real file analysis)

These are real issues observed in the `Puridy 2026 PL Loans.xlsx` file. The widget must handle them gracefully:

| Issue | Detail | Handling |
|---|---|---|
| Rep name inconsistency | ~100 spelling variants for ~15 actual reps | Fuzzy matching + default to Kyle |
| Stage typos | `CHARGABACK` (typo for CHARGEBACK) | Case-insensitive + normalize known typos |
| Missing emails | 32 rows have no email | Fall through to phone/name matching |
| Missing phones | 19 rows have no phone | Fall through to name matching |
| Phone number formatting | Spreadsheet values like "1 205-446-9454" — symbols and spaces vary | Normalize to digits-only with country code using normalizePhone() before Tier 2 search. Malformed numbers (not 10 or 11 digits) skip Tier 2 and fall to Tier 3. |
| N/A rep values | Literal "N/A", "n/a" | Treat as Unassigned → Kyle |
| "affiliates", "sales agent" | Generic non-person values | Treat as Unassigned → Kyle |
| Mixed case stage values | "Closed-Won", "closed-won", etc. | Case-insensitive comparison |

---

## Constants (Hardcode These)

```javascript
var CONSTANTS = {
  KYLE_USER_ID: '5428089000000380001',
  TRANSITIONS: {
    'enrolled_pl':      { id: '5428089000006963030', label: 'Enrolled PL' },
    'ghosted_pl':       { id: '5428089000006963038', label: 'Ghosted PL' },
    'turned_down_pl':   { id: '5428089000280561156', label: 'Turned Down for PL' }
  },
  STATUS_MAP: {
    'closed-won': 'enrolled_pl'
    // chargeback and fee adjustment TBD — handled as PENDING_CLARIFICATION for now
  },
  PENDING_CLARIFICATION_STATUSES: ['chargeback', 'chargaback', 'fee adjustment'],
  PL_END_STAGES: ['Enrolled PL', 'Ghosted PL', 'Turned Down for PL'],
  SENT_TO_PL_STAGE: 'Sent to PL',
  FUZZY_MATCH_THRESHOLD: 0.6,
  UNASSIGNED_VALUES: ['unassigned', 'n/a', 'affiliates', 'sales agent', '']
};
```

---

## Testing Approach

### Local dev loop
```bash
# User runs in their terminal:
zet run
# Then in separate terminal:
ngrok http https://localhost:5000 --domain=decompose-pennant-hedge.ngrok-free.dev
```

Open the widget via the sandbox URL in Zoho CRM Developer Console → Test your Extension.

### Test Cases to Build Against

| Test | Expected Outcome |
|---|---|
| Upload valid file | Parses, shows confirmation screen |
| Row with email match in "Sent to PL" | ✅ Ready |
| Row with phone match only | ✅ Ready, noted as Phone match |
| Row with name match only | ⚠️ Review (low confidence) |
| Row with no match | ❌ No Match |
| Deal already in Enrolled PL | 🔄 Skip |
| Deal already in Enrolled PL but file says different status | ⚠️ Review |
| Affiliate Rep = "Unassigned" | Resolved to Kyle silently |
| Affiliate Rep = "Meg Lapicz" (spelling variant) | Fuzzy-matched to correct user |
| Stage = "CHARGABACK" | ⚠️ Pending Clarification |
| Missing email AND phone | Falls to name match |
| Missing all three (email, phone, name) | Should not happen — but handle gracefully |
| API transition call fails | Row shows as Failed with error in audit log |
| Upload wrong column structure | Clear error message, halt |

---

## Open Items (Do Not Block On These — Handle Gracefully)

| Item | Current Handling |
|---|---|
| Chargeback transition stage | Flag as Pending Clarification, skip |
| Fee Adjustment transition stage | Flag as Pending Clarification, skip |
| Multiple "Sent to PL" deals for same contact | Flag as multiple candidates, skip (V2: picker) |
| Column mapping UI | Not in V1 — rigid column check only |

---

## V2 Notes (Do Not Build Now)

- Inline deal picker for multiple-candidate rows
- Column mapping UI on upload
- Chargeback → Enrolled PL → Clawback two-step flow
- Scheduled/automated monthly run

---

## Build Order

1. `index.html` — structure + SDK init + SheetJS CDN
2. `app.js` — in this order:
   - Constants
   - xlsx parser + column validator
   - User lookup + fuzzy matcher
   - Deal matching engine (all 3 tiers)
   - Confirmation screen renderer
   - Execution engine (transition API calls)
   - Audit report renderer + CSV export
3. `styles.css` — clean, professional, functional

Build all three files completely before testing. Do not build incrementally.
