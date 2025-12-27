# Setup Instructions

## Quick Start (One-time setup)

```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript
npm run build

# 3. Run the application
npm start
```

## What this does:

- `npm install` downloads all dependencies (better-sqlite3, uuid, typescript, etc.)
- `npm run build` compiles TypeScript files to JavaScript in `dist/` folder
- `npm start` runs the compiled application and generates `processing_report.json`

## Output

After running, you'll see:
- Console output with processing summary
- `processing_report.json` with detailed results
- `memory.db` with persisted learning data

## Requirements

- Node.js v16+ 
- npm (comes with Node.js)

---

**Note**: The `node_modules/` and `dist/` folders are excluded from git (see `.gitignore`). They are regenerated locally on first `npm install` and `npm run build`.
