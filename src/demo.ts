import * as fs from "fs";
import MemoryDB, { StoredMemory } from "./db";
import {
    detectDuplicate,
    recoverCurrencyFromText,
    detectSkontoTerms,
    mapDescriptionToSKU,
    detectVATInfo,
    scoreFieldConfidence,
    SkontoTerm,
    VATInfo,
} from "./utils";

type Invoice = {
    vendor: string;
    invoiceNumber: string;
    serviceDate?: string | null;
    poNumber?: string | null;
    [key: string]: any;
};

type Correction = {
    field: string;
    from: any;
    to: any;
    reason: string;
};

type MemoryType = "vendor" | "correction" | "resolution" | "pattern";

type Memory = {
    id: string;
    vendor: string;
    type: MemoryType;
    pattern: string;
    action: string;
    confidence: number;
    approved: number;
    rejected: number;
    resolutionType?: "approved" | "rejected"; // For resolution memory
};

type AuditStep = {
    step: "recall" | "apply" | "decide" | "learn" | "fix";
    timestamp: string;
    details: string;
};

type Result = {
  normalizedInvoice: Invoice;
  proposedCorrections: Correction[];
  requiresHumanReview: boolean;
  reasoning: string;
  confidenceScore: number;
  memoryUpdates: string[];
  auditTrail: AuditStep[];
  appliedCorrections: Correction[];
  isDuplicate?: boolean;
  duplicateOf?: string;
  detectedSkontoTerms?: SkontoTerm[];
  detectedVATInfo?: VATInfo;
  recoveredCurrency?: string | null;
};

interface RawInvoice {
    invoiceId: string;
    vendor: string;
    invoiceNumber: string;
    invoiceDate: string;
    serviceDate?: string | null;
    currency?: string;
    poNumber?: string | null;
    netTotal?: number;
    taxRate?: number;
    taxTotal?: number;
    grossTotal?: number;
    lineItems?: any[];
    confidence?: number;
    rawText?: string;
    corrections?: Correction[];
    finalDecision?: string;
    vatIncluded?: boolean;
}

interface ProcessingReport {
    invoiceId: string;
    vendor: string;
    result: Result;
    action: "auto-applied" | "human-approved" | "human-rejected" | "requires-review";
}

// Initialize persistent database
const memoryDB = new MemoryDB("memory.db");

// ===== Module Initialization =====
const processedInvoices: Array<{ invoiceId: string; vendor: string; invoiceNumber: string; invoiceDate: string }> = [];
let memoryStore: Memory[] = [];

// Load memories from persistent storage on startup
function loadMemoriesFromDB(): void {
    const stored = memoryDB.getAllMemories();
    memoryStore = stored.map((m) => ({
        id: m.id,
        vendor: m.vendor,
        type: m.type as MemoryType,
        pattern: m.pattern,
        action: m.action,
        confidence: m.confidence,
        approved: m.approved,
        rejected: m.rejected,
        resolutionType: m.resolutionType as "approved" | "rejected" | undefined,
    }));
}

// Apply confidence decay every startup
function applyConfidenceDecay(): void {
    memoryDB.decayConfidence(30); // Decay memories older than 30 days
    loadMemoriesFromDB();
}

// Initialize memories from database
loadMemoriesFromDB();
applyConfidenceDecay();

function learnFromMemory(
    invoice: Invoice,
    correction: Correction,
    approved: boolean,
    resolutionType?: "approved" | "rejected"
): Memory {
    const stored = memoryDB.addMemory(
        invoice.vendor,
        "correction",
        correction.reason,
        `${correction.field}: ${correction.from} -> ${correction.to}`,
        approved ? 0.85 : 0.5,
        resolutionType
    );

    const memory: Memory = {
        id: stored.id,
        vendor: stored.vendor,
        type: stored.type as MemoryType,
        pattern: stored.pattern,
        action: stored.action,
        confidence: stored.confidence,
        approved: stored.approved,
        rejected: stored.rejected,
        resolutionType: stored.resolutionType as "approved" | "rejected" | undefined,
    };

    memoryStore.push(memory);
    return memory;
}

function applyCorrections(invoice: Invoice, corrections: Correction[], auditTrailLocal: AuditStep[]): void {
    for (const correction of corrections) {
        const oldValue = invoice[correction.field];
        invoice[correction.field] = correction.to;
        auditTrailLocal.push({
            step: "fix",
            timestamp: new Date().toISOString(),
            details: `Fixed ${correction.field}: ${oldValue} -> ${correction.to} (${correction.reason})`,
        });
    }
}

function recallMemory(invoice: Invoice, auditTrailLocal: AuditStep[]): Memory[] {
    auditTrailLocal.push({
        step: "recall",
        timestamp: new Date().toISOString(),
        details: `Looking for memory for vendor ${invoice.vendor}`,
    });
    return memoryStore.filter((m) => m.vendor === invoice.vendor);
}

function findMatchingMemory(invoice: Invoice, pattern: string): Memory | undefined {
    return memoryStore.find((m) => 
        m.vendor === invoice.vendor && 
        m.pattern.toLowerCase().includes(pattern.toLowerCase())
    );
}

function processInvoice(
    invoice: Invoice,
    potentialCorrections: Correction[] = [],
    humanDecision?: "approved" | "rejected",
    rawText?: string,
    invoiceDate?: string,
    invoiceId?: string
): Result {
    const auditTrailLocal: AuditStep[] = [];
    const memoryUpdates: string[] = [];
    const appliedCorrections: Correction[] = [];

    // Step 0: Check for duplicates
    let isDuplicate = false;
    let duplicateOf: string | undefined;
    if (invoiceId && invoiceDate) {
        const duplicate = detectDuplicate(
            { invoiceId, vendor: invoice.vendor, invoiceNumber: invoice.invoiceNumber, invoiceDate },
            processedInvoices
        );

        if (duplicate) {
            isDuplicate = true;
            duplicateOf = duplicate.invoiceId;
            auditTrailLocal.push({
                step: "decide",
                timestamp: new Date().toISOString(),
                details: `Duplicate detected: same invoice number and vendor within 5 days. Original: ${duplicate.invoiceId}`,
            });
        }
    }

    // Step 0.5: Detect special patterns (VAT, Skonto, Currency)
    const detectedVATInfo = detectVATInfo(rawText);
    const detectedSkontoTerms = detectSkontoTerms(rawText);
    let recoveredCurrency = recoverCurrencyFromText(rawText, invoice.poNumber ? "EUR" : undefined);

    if (detectedVATInfo.detected) {
        memoryUpdates.push(`Detected VAT info: ${detectedVATInfo.vatIncluded ? "included" : "excluded"} (${(detectedVATInfo.percentage * 100).toFixed(0)}%)`);
    }

    if (detectedSkontoTerms.length > 0) {
        detectedSkontoTerms.forEach((term) => {
            memoryUpdates.push(`Detected Skonto term: ${term.percentage}% within ${term.daysForDiscount} days`);
            // Store as memory
            memoryDB.addMemory(
                invoice.vendor,
                "pattern",
                `Skonto-${term.percentage}%`,
                `${term.percentage}% discount within ${term.daysForDiscount} days`,
                0.8
            );
        });
    }

    if (recoveredCurrency && !invoice.poNumber) {
        invoice.poNumber = recoveredCurrency;
        memoryUpdates.push(`Recovered currency from text: ${recoveredCurrency}`);
    }

    // Step 1: Recall - look for existing memories
    const memories = recallMemory(invoice, auditTrailLocal);

    let confidenceScore = 0;
    const proposedCorrections: Correction[] = [];

    // Step 2: Apply - use memories to propose corrections
    if (potentialCorrections.length > 0) {
        auditTrailLocal.push({
            step: "apply",
            timestamp: new Date().toISOString(),
            details: `Found ${potentialCorrections.length} potential corrections to review`,
        });

        for (const correction of potentialCorrections) {
            const matchingMemory = findMatchingMemory(invoice, correction.reason);
            if (matchingMemory) {
                confidenceScore += matchingMemory.confidence;
                proposedCorrections.push(correction);
            } else {
                // Default confidence for unknown patterns
                confidenceScore += 0.6;
                proposedCorrections.push(correction);
            }
        }

        confidenceScore =
            proposedCorrections.length > 0 ? confidenceScore / proposedCorrections.length : 0;
    }

    // Step 3: Decide - determine if human review is needed
    const requiresHumanReview = isDuplicate || confidenceScore < 0.8;

    auditTrailLocal.push({
        step: "decide",
        timestamp: new Date().toISOString(),
        details: isDuplicate
            ? `Duplicate detected, requires review.`
            : requiresHumanReview
            ? `Low confidence (${confidenceScore.toFixed(2)}), requesting human intervention.`
            : `High confidence (${confidenceScore.toFixed(2)}), auto-applying corrections.`,
    });

    // Step 4: Auto-apply if confident, or apply based on human decision
    if (!requiresHumanReview || humanDecision === "approved") {
        applyCorrections(invoice, proposedCorrections, auditTrailLocal);
        appliedCorrections.push(...proposedCorrections);

        // Learn from approved corrections
        for (const correction of proposedCorrections) {
            const newMemory = learnFromMemory(invoice, correction, true, "approved");
            memoryUpdates.push(`Learned from approved correction: ${newMemory.action}`);
        }
    } else if (humanDecision === "rejected") {
        // Reduce confidence for rejected corrections
        for (const correction of proposedCorrections) {
            const matchingMemory = findMatchingMemory(invoice, correction.reason);
            if (matchingMemory) {
                matchingMemory.confidence = Math.max(0.1, matchingMemory.confidence * 0.8);
                matchingMemory.rejected++;
                memoryDB.updateMemoryConfidence(matchingMemory.id, matchingMemory.confidence, false);
                memoryUpdates.push(`Reduced confidence of memory for: ${correction.reason}`);
            }
        }

        // Store resolution memory
        for (const correction of proposedCorrections) {
            learnFromMemory(invoice, correction, false, "rejected");
        }
    }

    if (humanDecision && memories.length > 0) {
        for (const mem of memories) {
            if (humanDecision === "approved") {
                mem.confidence = Math.min(1, mem.confidence + 0.1);
                mem.approved++;
                memoryDB.updateMemoryConfidence(mem.id, mem.confidence, true);
                memoryUpdates.push(
                    `Increased confidence of memory ${mem.id} to ${mem.confidence.toFixed(2)}`
                );
            } else {
                mem.confidence = mem.confidence * 0.9;
                mem.rejected++;
                memoryDB.updateMemoryConfidence(mem.id, mem.confidence, false);
                memoryUpdates.push(
                    `Decreased confidence of memory ${mem.id} to ${mem.confidence.toFixed(2)}`
                );
            }
        }

        auditTrailLocal.push({
            step: "learn",
            timestamp: new Date().toISOString(),
            details: `Human ${humanDecision}, Memory updated.`,
        });
    }

    return {
        normalizedInvoice: invoice,
        proposedCorrections,
        requiresHumanReview,
        reasoning: `Used ${memories.length} memories with average confidence ${confidenceScore.toFixed(2)}. Found ${proposedCorrections.length} potential corrections.`,
        confidenceScore,
        memoryUpdates,
        auditTrail: auditTrailLocal,
        appliedCorrections,
        isDuplicate,
        duplicateOf,
        detectedSkontoTerms,
        detectedVATInfo,
        recoveredCurrency,
    };
}

function processAllInvoices(): ProcessingReport[] {
    const data = fs.readFileSync("extracted_invoice_data.json", "utf-8");
    const invoiceData: { invoices: RawInvoice[] } = JSON.parse(data);
    const reports: ProcessingReport[] = [];
    
    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║    AUTOMATED INVOICE PROCESSING WITH LEARNING AGENT      ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");

    for (const rawInv of invoiceData.invoices) {
        console.log(`Processing ${rawInv.invoiceId} from ${rawInv.vendor}...`);
        
        const invoice: Invoice = {
            vendor: rawInv.vendor,
            invoiceNumber: rawInv.invoiceNumber,
            serviceDate: rawInv.serviceDate || null,
            poNumber: rawInv.poNumber || null,
        };

        const corrections = rawInv.corrections || [];
        
        // Process with all available context
        let result: Result = processInvoice(
            invoice,
            corrections as Correction[],
            undefined,
            rawInv.rawText,
            rawInv.invoiceDate,
            rawInv.invoiceId
        );
        
        // Track processed invoice
        processedInvoices.push({
            invoiceId: rawInv.invoiceId,
            vendor: rawInv.vendor,
            invoiceNumber: rawInv.invoiceNumber,
            invoiceDate: rawInv.invoiceDate,
        });
        
        // Determine action based on confidence and finalDecision
        let action: "auto-applied" | "human-approved" | "human-rejected" | "requires-review";
        
        if (result.isDuplicate) {
            action = "requires-review";
            console.log(`  ⚠️  DUPLICATE DETECTED - Original: ${result.duplicateOf}\n`);
        } else if (result.requiresHumanReview) {
            if (rawInv.finalDecision === "approved") {
                result = processInvoice(
                    invoice,
                    corrections as Correction[],
                    "approved",
                    rawInv.rawText,
                    rawInv.invoiceDate,
                    rawInv.invoiceId
                );
                action = "human-approved";
                console.log(`  ✅ APPROVED by human - Learning applied\n`);
            } else if (rawInv.finalDecision === "rejected") {
                result = processInvoice(
                    invoice,
                    corrections as Correction[],
                    "rejected",
                    rawInv.rawText,
                    rawInv.invoiceDate,
                    rawInv.invoiceId
                );
                action = "human-rejected";
                console.log(`  ❌ REJECTED by human - Confidence reduced\n`);
            } else {
                action = "requires-review";
                console.log(`  ⚠️  REQUIRES REVIEW - No human decision recorded\n`);
            }
        } else {
            action = "auto-applied";
            console.log(`  ✅ AUTO-APPLIED - High confidence (${(result.confidenceScore * 100).toFixed(1)}%)\n`);
        }

        reports.push({
            invoiceId: rawInv.invoiceId,
            vendor: rawInv.vendor,
            result,
            action,
        });
    }

    return reports;
}

function generateSummaryReport(reports: ProcessingReport[]): void {
    console.log("\n╔════════════════════════════════════════════════════════════╗");
    console.log("║                 PROCESSING SUMMARY REPORT                 ║");
    console.log("╚════════════════════════════════════════════════════════════╝\n");

    const stats = {
        total: reports.length,
        autoApplied: reports.filter(r => r.action === "auto-applied").length,
        humanApproved: reports.filter(r => r.action === "human-approved").length,
        humanRejected: reports.filter(r => r.action === "human-rejected").length,
        requiresReview: reports.filter(r => r.action === "requires-review").length,
    };

    console.log(`Total Invoices Processed: ${stats.total}`);
    console.log(`├─ Auto-Applied (High Confidence): ${stats.autoApplied} (${((stats.autoApplied/stats.total)*100).toFixed(1)}%)`);
    console.log(`├─ Approved by Human: ${stats.humanApproved} (${((stats.humanApproved/stats.total)*100).toFixed(1)}%)`);
    console.log(`├─ Rejected by Human: ${stats.humanRejected} (${((stats.humanRejected/stats.total)*100).toFixed(1)}%)`);
    console.log(`└─ Requires Review: ${stats.requiresReview} (${((stats.requiresReview/stats.total)*100).toFixed(1)}%)\n`);

    console.log("Invoice Details by Action:\n");

    const byAction = {
        "auto-applied": reports.filter(r => r.action === "auto-applied"),
        "human-approved": reports.filter(r => r.action === "human-approved"),
        "human-rejected": reports.filter(r => r.action === "human-rejected"),
        "requires-review": reports.filter(r => r.action === "requires-review"),
    };

    if (byAction["auto-applied"].length > 0) {
        console.log("✅ AUTO-APPLIED:");
        byAction["auto-applied"].forEach(r => {
            console.log(`   ${r.invoiceId} (${r.vendor}) - Confidence: ${(r.result.confidenceScore*100).toFixed(1)}%`);
        });
        console.log();
    }

    if (byAction["human-approved"].length > 0) {
        console.log("✅ HUMAN-APPROVED:");
        byAction["human-approved"].forEach(r => {
            console.log(`   ${r.invoiceId} (${r.vendor}) - Applied ${r.result.appliedCorrections.length} corrections`);
        });
        console.log();
    }

    if (byAction["human-rejected"].length > 0) {
        console.log("❌ HUMAN-REJECTED:");
        byAction["human-rejected"].forEach(r => {
            console.log(`   ${r.invoiceId} (${r.vendor}) - Memory confidence reduced`);
        });
        console.log();
    }

    if (byAction["requires-review"].length > 0) {
        console.log("⚠️  REQUIRES REVIEW:");
        byAction["requires-review"].forEach(r => {
            console.log(`   ${r.invoiceId} (${r.vendor}) - Confidence: ${(r.result.confidenceScore*100).toFixed(1)}%, Corrections: ${r.result.proposedCorrections.length}`);
        });
        console.log();
    }

    console.log("Memory Store Final State:");
    console.log(`├─ Total Memories: ${memoryStore.length}`);
    memoryStore.forEach(mem => {
        console.log(`├─ ${mem.id}: "${mem.pattern}" (Confidence: ${mem.confidence.toFixed(2)}, Approved: ${mem.approved}, Rejected: ${mem.rejected})`);
    });
}

// Run automated processing
const reports = processAllInvoices();
generateSummaryReport(reports);

// Save detailed report to file
const reportFile = "processing_report.json";
fs.writeFileSync(reportFile, JSON.stringify({ timestamp: new Date().toISOString(), reports, memoryStore }, null, 2));
console.log(`\n📄 Detailed report saved to: ${reportFile}`);
