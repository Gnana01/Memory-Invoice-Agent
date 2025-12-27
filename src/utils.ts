import { StoredMemory } from "./db";

interface InvoiceMetadata {
    invoiceId: string;
    vendor: string;
    invoiceNumber: string;
    invoiceDate?: string;
    rawText?: string;
}

// Duplicate Detection
export function detectDuplicate(
    current: InvoiceMetadata,
    previousInvoices: InvoiceMetadata[],
    dateThresholdDays: number = 5
): InvoiceMetadata | null {
    const currentDate = current.invoiceDate ? new Date(current.invoiceDate).getTime() : 0;

    for (const prev of previousInvoices) {
        if (prev.vendor === current.vendor && prev.invoiceNumber === current.invoiceNumber) {
            const prevDate = prev.invoiceDate ? new Date(prev.invoiceDate).getTime() : 0;
            const daysDiff = Math.abs((currentDate - prevDate) / (1000 * 60 * 60 * 24));

            if (daysDiff <= dateThresholdDays) {
                return prev;
            }
        }
    }

    return null;
}

// Currency Recovery
export function recoverCurrencyFromText(rawText?: string, defaultCurrency?: string): string | null {
    if (!rawText) return defaultCurrency || null;

    const currencyPatterns: Record<string, string[]> = {
        EUR: ["EUR", "€", "EURO"],
        USD: ["USD", "$", "DOLLAR"],
        GBP: ["GBP", "£", "POUNDS"],
        CHF: ["CHF", "CHF"],
        JPY: ["JPY", "¥"],
    };

    for (const [currency, patterns] of Object.entries(currencyPatterns)) {
        for (const pattern of patterns) {
            if (rawText.includes(pattern)) {
                return currency;
            }
        }
    }

    return defaultCurrency || null;
}

// Skonto Term Detection
export interface SkontoTerm {
    percentage: number;
    daysForDiscount: number;
    rawText: string;
}

export function detectSkontoTerms(rawText?: string): SkontoTerm[] {
    if (!rawText) return [];

    const skontos: SkontoTerm[] = [];
    
    // Pattern: "X% bei/within/innerhalb Y days/Tagen"
    const patterns = [
        /(\d+(?:[.,]\d+)?)\s*%\s*(?:bei|within|innerhalb|for)\s*(?:payment\s*(?:within|in)|Zahlung\s*(?:innerhalb|in)|Zahlung\s*(?:innerhalb|in)|Lieferung\s*(?:within|in)?)?\s*(\d+)\s*(?:days?|Tagen|tagen)/gi,
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(rawText)) !== null) {
            const percentage = parseFloat(match[1].replace(",", "."));
            const days = parseInt(match[2]);

            skontos.push({
                percentage,
                daysForDiscount: days,
                rawText: match[0],
            });
        }
    }

    return skontos;
}

// Description to SKU Mapping
export interface DescriptionMapping {
    description: string;
    skuPattern: string;
    confidence: number;
}

const descriptionMappings: DescriptionMapping[] = [
    {
        description: "Seefracht",
        skuPattern: "FREIGHT",
        confidence: 0.95,
    },
    {
        description: "Shipping",
        skuPattern: "FREIGHT",
        confidence: 0.9,
    },
    {
        description: "Luftfracht",
        skuPattern: "FREIGHT",
        confidence: 0.95,
    },
    {
        description: "Software License",
        skuPattern: "SWL",
        confidence: 0.9,
    },
    {
        description: "Support",
        skuPattern: "SUPP",
        confidence: 0.85,
    },
];

export function mapDescriptionToSKU(description?: string): DescriptionMapping | null {
    if (!description) return null;

    const lower = description.toLowerCase();

    for (const mapping of descriptionMappings) {
        if (lower.includes(mapping.description.toLowerCase())) {
            return mapping;
        }
    }

    return null;
}

// VAT Detection
export interface VATInfo {
    vatIncluded: boolean;
    percentage: number;
    detected: boolean;
}

export function detectVATInfo(rawText?: string): VATInfo {
    if (!rawText) {
        return { vatIncluded: false, percentage: 0.19, detected: false };
    }

    const lower = rawText.toLowerCase();

    // Check for VAT included indicators
    if (
        lower.includes("incl") ||
        lower.includes("inkl") ||
        lower.includes("inklusive") ||
        lower.includes("including")
    ) {
        // Extract VAT percentage
        const percentMatch = rawText.match(/(\d+(?:[.,]\d+)?)\s*%/);
        const percentage = percentMatch ? parseFloat(percentMatch[1].replace(",", ".")) / 100 : 0.19;

        return { vatIncluded: true, percentage, detected: true };
    }

    // Check for VAT percentage alone
    const percentMatch = rawText.match(/(?:MwSt|VAT|Steuer)\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i);
    if (percentMatch) {
        const percentage = parseFloat(percentMatch[1].replace(",", ".")) / 100;
        return { vatIncluded: false, percentage, detected: true };
    }

    return { vatIncluded: false, percentage: 0.19, detected: false };
}

// Text Pattern Extraction
export function extractPatternFromText(text: string, pattern: RegExp): string[] {
    const matches: string[] = [];
    let match;

    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");

    while ((match = globalPattern.exec(text)) !== null) {
        matches.push(match[1] || match[0]);
    }

    return matches;
}

// Field Confidence Scorer
export function scoreFieldConfidence(
    field: string,
    value: any,
    vendor: string,
    memories: StoredMemory[]
): number {
    if (value === null || value === undefined) {
        return 0;
    }

    // Check if we have memories for this vendor + field combination
    const relevantMemories = memories.filter((m) => m.vendor === vendor && m.pattern.includes(field));

    if (relevantMemories.length === 0) {
        return 0.6; // Default confidence for unknown patterns
    }

    // Average the confidence of relevant memories
    const avgConfidence = relevantMemories.reduce((sum, m) => sum + m.confidence, 0) / relevantMemories.length;

    // Weight by approval ratio
    const totalDecisions = relevantMemories.reduce((sum, m) => sum + m.approved + m.rejected, 0);
    if (totalDecisions === 0) {
        return avgConfidence;
    }

    const approvalRatio = relevantMemories.reduce((sum, m) => sum + m.approved, 0) / totalDecisions;

    return avgConfidence * approvalRatio;
}
