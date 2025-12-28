# Memory-Driven Invoice Processing Agent

A TypeScript/Node.js system that implements **learned memory** for intelligent invoice automation. The agent improves processing accuracy by remembering past corrections and vendor-specific patterns rather than treating every invoice as a new entry.

## Problem Statement

Companies process hundreds of invoices daily with many recurring corrections:
- "Corrections are wasted—the system does not learn."
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
### Why Human Review May Still Be Required

Even with strong vendor memory, invoices involving:
- Multiple corrections
- Financial impact (tax recomputation, PO matching)
- Newly reinforced patterns

may still be escalated for one additional approval cycle.
This mirrors real-world accounting workflows where confidence increases gradually.

##### **Learn**: Store new insights and reinforce existing ones
- Increment hits when human approves
- Penalize misses to prevent bad patterns
- Confidence decay over time (configurable)
- Track source invoice for traceability
- Learning is triggered only after explicit human approval or rejection, ensuring that the system never learns from unverified assumptions.

### Duplicate Invoices

Duplicate invoices are flagged early using vendor + invoice number + date proximity.
They are:
- Never auto-approved
- Never used for learning
- Always surfaced for human confirmation

This prevents accidental double payments and avoids corrupting learned memory.

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

## Learning Demonstration (Real System Output)

### Processing Flow with Actual Memory Learning

**Invoice Processing Sequence:**

1. **INV-A-001** (Supplier GmbH)
   - First invoice, no prior memories
   - Detects: Leistungsdatum in rawText
   - Human approves: serviceDate mapping
   - **Result**: Memory stored with confidence 0.95, 1 approval

2. **INV-A-002** (Supplier GmbH)
   - Memory lookup: Finds 4 memories from vendor
   - No matching corrections in data
   - **Result**: Requires review (no applicable patterns)

3. **INV-A-003** (Supplier GmbH)
   - Memory lookup: 4 vendor memories found
   - Detects: Leistungsdatum + PO-A-051 match
   - Confidence: 0.90 (2 corrections both approved)
   - **Result**: Auto-applied (high confidence)
   - **Memory**: PO matching pattern reinforced

4. **INV-A-004** (Duplicate Check)
   - Same invoice number as INV-A-003 (INV-2024-003)
   - Same vendor, dates within 5 days
   - **Result**: Flagged as duplicate, escalated to human review
   - **Prevention**: Not used for learning (avoids memory pollution)

5. **INV-B-001** (Parts AG - New Vendor)
   - First Parts AG invoice, no memories
   - Detects: "MwSt. inkl." (VAT included)
   - Human approves: Tax recalculation
   - **Result**: 2 memories stored (grossTotal & taxTotal) with confidence 0.95

6. **INV-B-002** (Parts AG)
   - Memory lookup: 3 vendor memories found
   - Detects: VAT included flag again
   - **Result**: Requests review (low base confidence 0.60)

7. **INV-C-001** (Freight & Co - New Vendor)
   - First Freight invoice, no memories
   - Detects: "2% Skonto within 10 days" pattern
   - Human approves: Discount term storage
   - **Result**: Skonto memory stored with confidence 0.95

8. **INV-C-002** (Freight & Co)
   - Memory lookup: 3 vendor memories found
   - Detects: "Seefracht / Shipping" → SKU "FREIGHT"
   - **Result**: Pattern matching with 0.85 confidence

### Memory Store Growth

**Before Processing**: 0 memories

**After Processing 12 Invoices**: 10 memories across 3 vendors
- **Supplier GmbH**: 4 memories (Leistungsdatum: 0.95, PO matching: 0.85)
- **Parts AG**: 3 memories (VAT: 0.95, Tax: 0.95, Currency: 0.85)
- **Freight & Co**: 3 memories (Skonto: 0.95, Seefracht→FREIGHT: 0.85, variants)

**Confidence Progression**:
- **First invoice**: Default 0.60-0.70 (no memory)
- **After approval**: 0.80-0.95 (learned pattern)
- **After reinforcement**: 0.95+ (multiple approvals)
- **After rejection**: 0.70-0.80 (penalized confidence)

---

### Confidence Evolution
- **Reinforcement**: Hits++ when human approves (confidence increases)
- **Decay**: Misses++ when human rejects (confidence decreases)
- **Prevention**: Bad patterns penalized to avoid domination
- **Threshold**: Auto-apply at ≥0.75 confidence, suggest at 0.40-0.75, ignore <0.40

---

## Database Schema

### `memories` table
```sql
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    vendor TEXT NOT NULL,
    type TEXT NOT NULL,
    pattern TEXT NOT NULL,
    action TEXT NOT NULL,
    confidence REAL NOT NULL,
    approved INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    lastUpdated INTEGER NOT NULL,
    resolutionType TEXT
);

CREATE INDEX IF NOT EXISTS idx_vendor_type ON memories(vendor, type);
CREATE INDEX IF NOT EXISTS idx_lastUpdated ON memories(lastUpdated);
```

**Memory Record Example**:
```json
{
  "id": "e9cf0c84-d705-4616-98d1-4ca02ea826fe",
  "vendor": "Supplier GmbH",
  "type": "correction",
  "pattern": "Leistungsdatum found in rawText",
  "action": "serviceDate: null -> 2024-01-01",
  "confidence": 0.95,
  "approved": 1,
  "rejected": 0,
  "createdAt": 1735346488848,
  "lastUpdated": 1735346488849,
  "resolutionType": "approved"
}
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

### Prerequisites
- **Node.js**: v24.12.0 or higher
- **npm**: v11.0.0 or higher
- **TypeScript**: Configured in workspace

### Install Dependencies
```bash
cd d:\Projects\Memory_Driven_Agent
npm install
```

### Run Demo (Process All Invoices)
```bash
npm run dev
```

This will:
1. Load 12 sample invoices from `extracted_invoice_data.json`
2. Initialize SQLite database with memory persistence
3. Process each invoice through recall/apply/decide/learn pipeline
4. Generate `processing_report.json` with full audit trails
5. Display console output with learning progression

### Build for Production
```bash
npm run build
```

### Output Files
- `processing_report.json` - Full processing results with:
  - Normalized invoices per vendor
  - Proposed corrections for each
  - Confidence scores
  - Memory updates applied
  - Complete audit trails
  - Final memory store state

---

## Real Example: Leistungsdatum Learning

### Processing INV-A-001 (First Supplier GmbH Invoice)
```json
{
  "invoiceId": "INV-A-001",
  "vendor": "Supplier GmbH",
  "result": {
    "normalizedInvoice": {
      "vendor": "Supplier GmbH",
      "invoiceNumber": "INV-2024-001",
      "serviceDate": "2024-01-01",
      "poNumber": "PO-A-050"
    },
    "proposedCorrections": [
      {
        "field": "serviceDate",
        "from": null,
        "to": "2024-01-01",
        "reason": "Leistungsdatum found in rawText"
      }
    ],
    "confidenceScore": 0.95,
    "requiresHumanReview": false,
    "memoryUpdates": [
      "Learned from approved correction: serviceDate: null -> 2024-01-01"
    ],
    "auditTrail": [
      {
        "step": "recall",
        "timestamp": "2025-12-28T03:41:28.848Z",
        "details": "Looking for memory for vendor Supplier GmbH"
      },
      {
        "step": "apply",
        "timestamp": "2025-12-28T03:41:28.849Z",
        "details": "Found 1 potential corrections to review"
      },
      {
        "step": "decide",
        "timestamp": "2025-12-28T03:41:28.849Z",
        "details": "High confidence (0.95), auto-applying corrections."
      }
    ]
  },
  "action": "auto-applied"
}
```

### Processing INV-A-003 (Later Supplier GmbH Invoice with PO)
```json
{
  "invoiceId": "INV-A-003",
  "vendor": "Supplier GmbH",
  "result": {
    "proposedCorrections": [
      {
        "field": "poNumber",
        "from": null,
        "to": "PO-A-051",
        "reason": "Only matching PO for vendor within 30 days and matching item WIDGET-002"
      },
      {
        "field": "serviceDate",
        "from": null,
        "to": "2024-01-20",
        "reason": "Leistungsdatum found in rawText"
      }
    ],
    "confidenceScore": 0.89,
    "requiresHumanReview": false,
    "memoryUpdates": [
      "Learned from approved correction: poNumber: null -> PO-A-051",
      "Learned from approved correction: serviceDate: null -> 2024-01-20"
    ]
  },
  "action": "auto-applied"
}
```

### Pattern Evolution
- **INV-A-001**: First invoice, learned Leistungsdatum pattern (confidence 0.95)
- **INV-A-003**: Reinforced pattern + added PO matching (confidence 0.90)
- **Result**: Future invoices auto-correct both fields with high confidence

---

## File Structure

```
Memory_Driven_Agent/
├── src/
│   ├── index.ts         # Main processing pipeline with recall/apply/decide/learn
│   ├── db.ts            # SQLite database management (MemoryDB class)
│   ├── utils.ts         # Utility functions for detection & pattern matching
│   │   ├── detectDuplicate()          # Vendor + invoiceNumber + date matching
│   │   ├── recoverCurrencyFromText()  # EUR/USD/GBP/CHF/JPY extraction
│   │   ├── detectSkontoTerms()        # X% within Y days pattern recognition
│   │   ├── mapDescriptionToSKU()      # Seefracht → FREIGHT mapping
│   │   ├── detectVATInfo()            # MwSt. inkl. / VAT detection
│   │   └── scoreFieldConfidence()     # Memory-weighted confidence scoring
│   └── index.js         # Compiled output (if needed)
├── dist/                # Compiled JavaScript (auto-generated)
├── extracted_invoice_data.json  # Sample invoices (12 total from 3 vendors)
├── processing_report.json       # Demo output with all invoices & memories
├── memory.db            # SQLite database (auto-created on first run)
├── package.json         # Dependencies (better-sqlite3, uuid, typescript)
├── tsconfig.json        # TypeScript strict mode configuration
└── README.md            # This file
```

### Generated Files (Automated)
- **memory.db**: SQLite database with memories and audit trails
- **processing_report.json**: Full processing results with memory updates
- **dist/**: Compiled TypeScript (run `npm run build`)

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

MIT