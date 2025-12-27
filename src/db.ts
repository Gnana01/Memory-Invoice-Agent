import Database from "better-sqlite3";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";

export interface StoredMemory {
    id: string;
    vendor: string;
    type: "vendor" | "correction" | "resolution" | "pattern";
    pattern: string;
    action: string;
    confidence: number;
    approved: number;
    rejected: number;
    createdAt: number;
    lastUpdated: number;
    resolutionType?: "approved" | "rejected";
}

export class MemoryDB {
    private db: Database.Database;

    constructor(dbPath: string = "memory.db") {
        this.db = new Database(dbPath);
        this.initializeSchema();
    }

    private initializeSchema(): void {
        this.db.exec(`
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
        `);
    }

    addMemory(
        vendor: string,
        type: "vendor" | "correction" | "resolution" | "pattern",
        pattern: string,
        action: string,
        confidence: number = 0.5,
        resolutionType?: "approved" | "rejected"
    ): StoredMemory {
        const id = uuidv4();
        const now = Date.now();

        const stmt = this.db.prepare(`
            INSERT INTO memories (id, vendor, type, pattern, action, confidence, approved, rejected, createdAt, lastUpdated, resolutionType)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            id,
            vendor,
            type,
            pattern,
            action,
            confidence,
            0,
            0,
            now,
            now,
            resolutionType || null
        );

        return this.getMemory(id)!;
    }

    getMemory(id: string): StoredMemory | null {
        const stmt = this.db.prepare("SELECT * FROM memories WHERE id = ?");
        return (stmt.get(id) as StoredMemory) || null;
    }

    getMemoriesByVendor(vendor: string): StoredMemory[] {
        const stmt = this.db.prepare("SELECT * FROM memories WHERE vendor = ? ORDER BY lastUpdated DESC");
        return stmt.all(vendor) as StoredMemory[];
    }

    getMemoriesByVendorAndType(vendor: string, type: string): StoredMemory[] {
        const stmt = this.db.prepare(
            "SELECT * FROM memories WHERE vendor = ? AND type = ? ORDER BY confidence DESC, lastUpdated DESC"
        );
        return stmt.all(vendor, type) as StoredMemory[];
    }

    searchMemories(vendor: string, pattern: string): StoredMemory[] {
        const stmt = this.db.prepare(
            "SELECT * FROM memories WHERE vendor = ? AND pattern LIKE ? ORDER BY confidence DESC"
        );
        return stmt.all(vendor, `%${pattern}%`) as StoredMemory[];
    }

    updateMemoryConfidence(id: string, confidence: number, isApproved: boolean): void {
        const now = Date.now();
        const stmt = this.db.prepare(`
            UPDATE memories
            SET confidence = ?, 
                approved = approved + ?,
                rejected = rejected + ?,
                lastUpdated = ?
            WHERE id = ?
        `);

        const approved = isApproved ? 1 : 0;
        const rejected = isApproved ? 0 : 1;

        stmt.run(confidence, approved, rejected, now, id);
    }

    decayConfidence(daysOld: number = 30): void {
        const now = Date.now();
        const thirtyDaysAgo = now - daysOld * 24 * 60 * 60 * 1000;

        const stmt = this.db.prepare(`
            UPDATE memories
            SET confidence = confidence * 0.9,
                lastUpdated = ?
            WHERE lastUpdated < ? AND confidence > 0.2
        `);

        stmt.run(now, thirtyDaysAgo);
    }

    getAllMemories(): StoredMemory[] {
        const stmt = this.db.prepare("SELECT * FROM memories ORDER BY lastUpdated DESC");
        return stmt.all() as StoredMemory[];
    }

    deleteMemory(id: string): void {
        const stmt = this.db.prepare("DELETE FROM memories WHERE id = ?");
        stmt.run(id);
    }

    clearMemories(): void {
        this.db.exec("DELETE FROM memories");
    }

    getStats(): { total: number; byVendor: Record<string, number>; byType: Record<string, number> } {
        const total = (this.db.prepare("SELECT COUNT(*) as count FROM memories").get() as any).count;
        
        const byVendor = Object.fromEntries(
            (this.db.prepare("SELECT vendor, COUNT(*) as count FROM memories GROUP BY vendor").all() as any[]).map(
                (row) => [row.vendor, row.count]
            )
        );

        const byType = Object.fromEntries(
            (this.db.prepare("SELECT type, COUNT(*) as count FROM memories GROUP BY type").all() as any[]).map(
                (row) => [row.type, row.count]
            )
        );

        return { total, byVendor, byType };
    }

    close(): void {
        this.db.close();
    }
}

export default MemoryDB;
