# PL Importer

A Zoho CRM Widget (ZET Web Tab) that lets a user upload a monthly PL loans spreadsheet and automatically transition matching Deals through the blueprint to their correct PL stages. Includes a confirmation screen before execution and a full audit report after.

---

## Requirements

- [Zoho Extension Toolkit (ZET)](https://www.zoho.com/crm/developer/docs/widgets/install-zet.html)
- ZET CLI path: `/Users/jaylim/.npm-global/bin/zet`
- Node.js (for the ZET local dev server)
- [ngrok](https://ngrok.com/) with static domain `decompose-pennant-hedge.ngrok-free.dev`

---

## Project Structure

```
pl_importer/
  pl_importer/              ← ZET project root (created by zet init)
    app/
      widget.html           ← single entry point
      app.js                ← all widget logic
      styles.css            ← all styles
      translations/
        en.json
    plugin-manifest.json
    package.json
    server/
      index.js              ← ZET local HTTPS dev server (port 5000)
    cert.pem                ← gitignored
    key.pem                 ← gitignored
    node_modules/           ← gitignored
  PL_Importer_Build_Brief.md
  README.md
```

---

## Local Development

**Terminal 1 — ZET dev server:**
```bash
cd pl_importer
zet run
```

**Terminal 2 — ngrok tunnel:**
```bash
ngrok http https://localhost:5000 --domain=decompose-pennant-hedge.ngrok-free.dev
```

Then open the widget via **Zoho CRM Developer Console → Test your Extension**.

On first run, visit `https://127.0.0.1:5000` in a browser tab and click through the SSL warning (Advanced → Proceed) to authorise the local cert.

---

## Spreadsheet Format

The widget accepts `.xlsx` and `.csv` files with **exactly** these column headers (case-sensitive):

| Column | Maps To | CRM API Name |
|---|---|---|
| `Affiliate Rep` | PL Sender Name | `PL_Sender_Name` |
| `Date Enrolled in PL` | PL Enrolled Date | `PL_Enrolled_Date` |
| `Client Name` | Deal matching (Tier 3) | — |
| `Loan Amount` | Loan Amount | `Loan_Amount` |
| `Ref Fee` | Revenue | `Revenue` |
| `Email` | Deal matching (Tier 1) | — |
| `Phone` | Deal matching (Tier 2) | — |
| `Stage` | Determines transition | — |
| `Cancellation Date` | PL Canceled Date (chargeback rows only) | `PL_Canceled_Date` |

`Cancellation Date` is optional — only needed if the file contains chargeback rows. If the column is absent and a row has `Stage = CHARGEBACK`, that row is flagged as Fix Required. All other required columns halt the import if missing.

---

## How It Works

### Deal Matching (3-tier)
Each row is matched to a CRM Deal **currently in "Sent to PL"** stage:

1. **Tier 1 — Email** (`Email:equals:value`)
2. **Tier 2 — Phone** (digits-only with country code, e.g. `19173528296`)
3. **Tier 3 — Client Name** (`Contact_Name.name:equals:value`) — treated as low-confidence

If no match is found in "Sent to PL", a fallback search checks all stages to detect deals already processed.

### Rep Name Resolution
Affiliate Rep values are fuzzy-matched against CRM active users:

| Confidence | Behaviour |
|---|---|
| 1.0 (exact) | ✅ Ready — no review needed |
| ≥ 0.85 (near-exact) | ✅ Ready — shown in expand for visibility |
| 0.60–0.85 (uncertain) | ⚠️ Review — inline rep dropdown for user confirmation |
| < 0.60 (unresolvable) | ⚠️ Review — defaults to Kyle Kimball, checkbox to include/exclude |

**Default user:** Kyle Kimball (`5428089000000380001`) — applied to `Unassigned`, `N/A`, `n/a`, `affiliates`, `sales agent`, blank, and any unresolvable name.

### Stage → Blueprint Transition Mapping

Row type is determined by **cross-validating** the `Stage` column with the `Cancellation Date` column. Both must agree, or the row is flagged for Fix Required.

| Spreadsheet Stage | Cancellation Date | Transition | Transition ID |
|---|---|---|---|
| `Closed-Won` | blank | `Sent to PL → Enrolled PL` | `5428089000006963030` |
| `CHARGEBACK` / `CHARGABACK` (case-insensitive, ignores spaces/dashes) | populated | `Enrolled PL → Canceled PL` | `5428089000739384025` |
| `FEE ADJUSTMENT` / `Fee Adjustment` | — | Pending clarification — skipped | — |
| `CHARGEBACK` variant | **blank** | Fix Required — missing Cancellation Date | — |
| `Closed-Won` | **populated** | Fix Required — Cancellation Date set but Stage isn't CHARGEBACK | — |

### Two-Pass Processing Order

When the file contains both enrollment and chargeback rows for the same deal (same-month scenario), the importer always processes **all enrollments first**, then chargebacks. This guarantees that a deal is in `Enrolled PL` before its chargeback row tries to cancel it.

For chargeback rows, the importer **re-fetches the deal's current stage** immediately before the cancellation transition. If the deal isn't in `Enrolled PL` at that point (e.g. the enrollment failed, or the deal moved elsewhere), the row is logged as failed with: `Deal not in Enrolled PL stage — cannot cancel (currently: ...)`.

---

## Confirmation Screen Buckets

| Bucket | Meaning |
|---|---|
| ✅ Ready to import | Matched, all fields resolved, transition known |
| ⚠️ Review before importing | Can run — user must confirm rep or approve low-confidence match |
| ⛔ Fix required — will be skipped | Missing required fields, multiple candidates, pending config |
| 🔄 Already done | Deal already in a PL end stage |
| ❌ No match found | No CRM deal found at any tier |

Sections and summary counts with zero rows are hidden automatically.

---

## Audit Report

Every row (processed or skipped) appears in the audit report with:

- Client Name, Email, Outcome, Transition called, Deal ID, Match Method, Rep Resolved, Error message, Timestamp

**Outcomes:** `Transitioned` / `Failed` / `Skipped` / `Skipped (manual)` / `No Match` / `Pending Clarification` / `Fix Required`

Failed rows include the exact API error — rate limit errors display as:
`API call limit reached — wait before retrying (code: RATE_LIMIT)`

Export as CSV is available on the report screen.

---

## Key Constants (app.js)

```javascript
KYLE_USER_ID:          '5428089000000380001'
KYLE_NAME:             'Kyle Kimball'
CRM_ORG_ID:            '786428921'
FUZZY_MATCH_THRESHOLD: 0.6     // minimum score to attempt a match
FUZZY_READY_THRESHOLD: 0.85    // minimum score to go straight to Ready
```

Transition IDs:
```javascript
enrolled_pl:    '5428089000006963030'
ghosted_pl:     '5428089000006963038'
turned_down_pl: '5428089000280561156'
canceled_pl:    '5428089000739384025'
```

---

## SDK Notes

- **SDK version:** `https://live.zwidgets.com/js-sdk/1.2/ZohoEmbededAppSDK.min.js`
  - v1.0 does NOT include `ZOHO.CRM.API.updateBluePrint` — v1.2 is required.
  - `ZOHO.CRM.BLUEPRINT.proceed()` exists in v1.2 but only works for widgets embedded inside a blueprint step, not standalone web tabs.
- **Blueprint call:** `ZOHO.CRM.API.updateBluePrint({ Entity, RecordID, BlueprintData })`
- **CRM region:** `.com` (`api.zoho.com` / `crm.zoho.com`)

---

## Open Items (V2)

- [ ] Wire up Fee Adjustment transition once Jeff confirms target stage
- [ ] Inline deal picker for multiple-candidate rows
- [ ] Column mapping UI on upload (V1 uses rigid column check only)
- [ ] Scheduled/automated monthly run
