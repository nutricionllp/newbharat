# Solar Quotation Web App

A simple quotation system for a solar business in Gujarat. It supports preset products with GST, CGST/SGST split, and PDF quotations.

## Features
- Manage preset products with GST rates
- Create quotations with quantities and auto totals
- CGST/SGST split (Gujarat)
- Generate downloadable PDFs
- MySQL storage (MilesWeb)

## Setup
1. Copy `.env.example` to `.env` and fill your MySQL credentials.
2. For cPanel subpath hosting, set `APP_BASE_PATH=/NewQuotation` in `.env`.
3. Create the database and run the schema:

```sql
-- Example (run inside your MySQL client)
CREATE DATABASE solar_quotes;
USE solar_quotes;
SOURCE src/db/schema.sql;
```

4. Replace the logo image at `src/public/logo.png` with your logo.
5. Install dependencies and run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

For cPanel deployment with your current setup:
- Application root: `NewQuatation/NewProject`
- Application URL path: `NewQuotation`
- Startup file: `src/server.js`
- Node.js version: `18.x`
- Application mode: `Production`

## Company Details
Edit `src/config/company.json` to update your company name, address, GSTIN, and terms.
