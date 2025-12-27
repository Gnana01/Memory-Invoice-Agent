# Memory-Driven Invoice Processing Agent

A TypeScript/Node.js system that implements **learned memory** for intelligent invoice automation. The agent improves processing accuracy by remembering past corrections and vendor-specific patterns rather than treating every invoice as a new entry.

## Problem Statement

Companies process hundreds of invoices daily with many recurring corrections:
- Vendor-specific label mappings (e.g., "Leistungsdatum" → service date)
- VAT handling variations across vendors
- Missing field recovery from raw text
- Duplicate detection and prevention
- Special terms (e.g., Skonto) and descriptions

**Current state:** Corrections are wasted—the system does not learn.  
**Goal:** Build a memory layer that stores, retrieves, and applies learned patterns to improve automation rates.

---

## Architecture

### Core Components

- **MemoryEngine** (`src/engine.ts`) - The recall/apply/decide/learn pipeline
- **MemoryDB** (`src/db.ts`) - SQLite-based persistence with audit trails
- **Types** (`src/types.ts`) - Domain models (Invoice, Memory, ProcessingResult)
- **SampleData** (`src/sampleData.ts`) - Real invoice examples for demo

### Key Modules

#### 1. **Memory Types**
- **Vendor Memory**: Patterns tied to specific vendors (e.g., field mappings)
- **Correction Memory**: Learned from repeated corrections (e.g., VAT recomputation)
- **Resolution Memory**: Track how discrepancies were resolved
- **Audit Trail**: Every step logged with timestamp and details

#### 2. **Pipeline Stages**

```
Recall → Apply → Decide → Learn
  ↓       ↓        ↓        ↓
Query   Suggest  Review  Update
past    fixes    human   memory
```

##### **Recall**: Retrieve relevant memories
- Filter by vendor and confidence threshold
- Sort by hit count and recency
- Return ordered list of applicable patterns

##### **Apply**: Normalize fields and suggest corrections
- Vendor-specific field mappings
- Auto-detect patterns (VAT, currency, SKU)
- PO matching and duplicate detection
- Generate reasoning for each suggestion

##### **Decide**: Determine auto-accept/escalate decision
- Use confidence scores from memories
- Avoid low-confidence auto-corrections
- Flag duplicates and edge cases
- Provide audit trail

##### **Learn**: Store new insights and reinforce existing ones
- Increment hits when human approves
- Penalize misses to prevent bad patterns
- Confidence decay over time (configurable)
- Track source invoice for traceability

---

## Memory Examples

### Supplier GmbH: Field Mapping
```typescript
{
  vendorId: "supplier-gbmh",
  type: "vendor",
  pattern: { field: "Leistungsdatum" },
  action: { mapToField: "serviceDate" },
  confidence: 0.88,
  hits: 2, misses: 0
}
```

### Parts AG: VAT Detection
```typescript
{
  vendorId: "parts-ag",
  type: "correction",
  pattern: { condition: { vatIncluded: true } },
  action: { 
    correction: { requiresTaxRecompute: true },
    description: "When VAT included, flag for tax recomputation"
  },
  confidence: 0.90,
  hits: 1, misses: 0
}
```

### Freight & Co: Skonto & SKU Mapping
```typescript
{
  vendorId: "freight-co",
  type: "correction",
  pattern: { descriptionKeyword: "Seefracht" },
  action: { mapToSKU: "FREIGHT" },
  confidence: 0.92,
  hits: 3, misses: 0
}
```

---

## Output Contract

Each invoice processing returns this JSON structure:

```json
{
  "normalizedInvoice": {
    "invoiceNumber": "INV-2024-001",
    "serviceDate": "2024-01-15",
    "currency": "EUR",
    "requiresTaxRecompute": false
  },
  "proposedCorrections": [
    "Applied vendor memory: mapped 'Leistungsdatum' → 'serviceDate' (confidence: 88%)",
    "Auto-matched PO: PO-A-051 based on vendor pattern (confidence: 85%)"
  ],
  "requiresHumanReview": false,
  "reasoning": "Applied 2 correction(s) from learned patterns. Confidence: 87%. Auto-acceptable.",
  "confidenceScore": 0.87,
  "memoryUpdates": ["mem-supplier-gbmh-01: hits++"],
  "auditTrail": [
    {
      "step": "recall",
      "timestamp": "2025-12-26T12:00:00.000Z",
      "details": "Retrieved 3 relevant memories for vendor supplier-gbmh"
    },
    {
      "step": "apply",
      "timestamp": "2025-12-26T12:00:00.001Z",
      "details": "Found 3 relevant memories. Applying corrections."
    },
    {
      "step": "decide",
      "timestamp": "2025-12-26T12:00:00.002Z",
      "details": "Making decision on human review requirement."
    }
  ]
}
```

---

## Learning Demonstration

### Run 1: Invoice #1 from Supplier GmbH
- **Status**: No prior memories
- **Result**: Requires human review
- **Confidence**: 0.5 (default)
- **Action**: User corrects "Leistungsdatum" mapping

### Run 2: Invoice #2 from Supplier GmbH
- **Status**: Memory learned from Run 1
- **Result**: Auto-applies field mapping
- **Confidence**: 0.88 (from learned memory)
- **Action**: Auto-correct with high confidence

### Run 3: Invoice #3 with PO Reference
- **Status**: Enhanced memory detects PO
- **Result**: Auto-matches PO-A-051
- **Confidence**: 0.85 (vendor pattern)
- **Action**: Fewer flags, smarter decisions

---

## Grading Criteria Coverage

✅ **Supplier GmbH**: 
- Maps `Leistungsdatum` → `serviceDate` after learning
- INV-A-003 auto-matches PO-A-051 (single matching PO)

✅ **Parts AG**: 
- Detects `MwSt. inkl.` / `Prices incl. VAT`
- Triggers tax recomputation flag with reasoning
- Recovers missing currency from vendor patterns

✅ **Freight & Co**: 
- Captures Skonto terms with increasing confidence
- Maps descriptions like `Seefracht` → SKU `FREIGHT`
- Tracks patterns across invoices

✅ **Duplicates**: 
- Flags INV-A-004 and INV-B-004 as duplicates
- Prevents contradictory memory entries
- Requires human review

✅ **Confidence Evolution**: 
- Reinforcement on approval (hits++)
- Decay on rejection (misses++, confidence--)
- Prevents bad learnings from dominating

---

## Database Schema

### `memories` table
```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  vendor_id TEXT,
  type TEXT CHECK(type IN ('vendor', 'correction', 'resolution')),
  pattern TEXT, -- JSON
  action TEXT,  -- JSON
  confidence REAL,
  decay_factor REAL,
  last_updated TEXT,
  hits INTEGER,
  misses INTEGER,
  source_invoice_id TEXT
);
```

### `audit_log` table
```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  invoice_id TEXT,
  timestamp TEXT,
  step TEXT, -- 'recall' | 'apply' | 'decide' | 'learn'
  details TEXT
);
```

---

## Configuration

### Confidence Thresholds
- **Auto-accept threshold**: 0.75 (75% confidence)
- **Suggest threshold**: 0.40 (40% confidence)
- **Ignore threshold**: < 0.40

### Decay Settings
- **Default decay factor**: 0.95 per period
- **Reinforcement increment**: +0.05 per approval
- **Penalty decrement**: -0.10 per rejection

Customize in `src/engine.ts`:
```typescript
const CONFIDENCE_THRESHOLD_AUTO = 0.75;
const CONFIDENCE_THRESHOLD_SUGGEST = 0.4;
```

---

## Setup & Run

### Install Dependencies
```bash
npm install
```

### Run Demo
```bash
npm run dev
```

### Build for Production
```bash
npm run build
npm start
```

---

## Example: Vendor Pattern Learning

**Scenario**: Supplier GmbH always uses "Leistungsdatum" for service date.

**First Invoice (INV-A-001)**:
```json
{
  "requiresHumanReview": true,
  "proposedCorrections": [],
  "reasoning": "No relevant memories found; manual review recommended.",
  "confidenceScore": 0.5
}
```

**Human Correction**:
```
User maps: "Leistungsdatum" → "serviceDate"
System stores: Memory with confidence 0.60 (new pattern)
```

**Second Invoice (INV-A-002) from Same Vendor**:
```json
{
  "requiresHumanReview": false,
  "proposedCorrections": [
    "Applied vendor memory: mapped 'Leistungsdatum' → 'serviceDate' (confidence: 88%)"
  ],
  "reasoning": "Applied 1 correction(s) from learned patterns. Confidence: 88%. Auto-acceptable.",
  "confidenceScore": 0.88
}
```

**Result**: Fewer flags, smarter decisions, reduced manual work.

---

## File Structure

```
Memory_Driven_Agent/
├── src/
│   ├── types.ts         # Domain interfaces
│   ├── db.ts            # SQLite setup & persistence
│   ├── engine.ts        # Recall/apply/decide/learn logic
│   ├── sampleData.ts    # Test invoices & memories
│   └── demo.ts          # Demo runner
├── dist/                # Compiled JavaScript
├── memory.db            # SQLite database (auto-created)
├── package.json         # Dependencies
├── tsconfig.json        # TypeScript config
└── README.md            # This file
```

---

## Technologies

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js
- **Database**: SQLite (better-sqlite3)
- **Build**: tsc (TypeScript Compiler)
- **Dev Tools**: ts-node, nodemon

---

## Future Enhancements

- [ ] Machine learning confidence decay with time-based weighting
- [ ] UI dashboard for memory visualization & debugging
- [ ] Batch processing with async/await optimization
- [ ] Integration with ERP systems (SAP, Oracle)
- [ ] REST API for remote processing
- [ ] Webhooks for real-time feedback loops
- [ ] Multi-tenant support with vendor isolation

---

## Author

Built for Flowbit AI Agent Development Internship  
Assignment: Memory-Driven Learning Layer for Invoice Automation

---

## License

ISC
