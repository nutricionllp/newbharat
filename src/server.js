const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const dotenv = require('dotenv');
const PDFDocument = require('pdfkit');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const pool = require('./db');

const app = express();
const configuredBasePath = process.env.APP_BASE_PATH || '/NewQuotation';
const normalizedBasePath = configuredBasePath === '/'
  ? ''
  : `/${configuredBasePath.replace(/^\/+|\/+$/g, '')}`;

function withBase(pathname) {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizedBasePath}${normalizedPath}`;
}

app.use((req, res, next) => {
  res.locals.basePath = normalizedBasePath;
  res.locals.assetVersion = '20260426-1';
  res.locals.authUser = null;
  res.setHeader('X-NewBharat-Build', '20260426-1');

  if (!normalizedBasePath) {
    return next();
  }

  const [pathname, query] = req.url.split('?');
  if (pathname === normalizedBasePath || pathname.startsWith(`${normalizedBasePath}/`)) {
    const strippedPath = pathname.slice(normalizedBasePath.length) || '/';
    req.url = query ? `${strippedPath}?${query}` : strippedPath;
  }
  next();
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const company = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config', 'company.json'), 'utf8')
);

const fallbackProposalTemplate = [
  {
    sr_no: 1,
    description: 'Solar PV Modules - (Module Size having +-05 Wp variation)',
    unit: 'Nos',
    specification: '620',
    qty: '5',
    make: 'ADANI'
  },
  {
    sr_no: 2,
    description: 'Module mounting structure',
    unit: 'Set',
    specification: 'As per design',
    qty: 'As per design',
    make: 'Hot Dip Galv. Iron 60x40 & 40x40'
  },
  {
    sr_no: 3,
    description: 'String type Grid Tied Inverter as per availability',
    unit: 'Nos',
    specification: 'As per design',
    qty: '1',
    make: 'SOLARYAAN / XWATT'
  },
  {
    sr_no: 4,
    description: 'DCDB with accessories',
    unit: 'Nos',
    specification: 'As per design',
    qty: 'As per design',
    make: 'L&T/HAVELLS'
  },
  {
    sr_no: 5,
    description: 'ACDB with accessories',
    unit: 'Nos',
    specification: 'As per design',
    qty: 'At actual',
    make: 'L&T/HAVELLS'
  },
  {
    sr_no: 6,
    description: 'DC Wire with UV protected - TUV Certified',
    unit: 'Mtr.',
    specification: 'As per design',
    qty: 'At actual',
    make: 'POLYCAB'
  },
  {
    sr_no: 7,
    description: 'AC Wire - TUV Certified',
    unit: 'Mtr.',
    specification: 'As per design',
    qty: 'At actual',
    make: 'POLYCAB'
  },
  {
    sr_no: 8,
    description: 'Advanced Chemical Earthing systems',
    unit: 'Nos',
    specification: 'As per design',
    qty: 'As per design',
    make: 'Standard'
  },
  {
    sr_no: 9,
    description: 'Lightening arrester',
    unit: 'Nos',
    specification: 'As per design',
    qty: 'As per design',
    make: 'Standard'
  }
];

const proposalTemplate = Array.isArray(company.proposalTemplate) && company.proposalTemplate.length
  ? company.proposalTemplate
  : fallbackProposalTemplate;
const bankAccounts = Array.isArray(company.bankAccounts) ? company.bankAccounts : [];
const estimatedOtherCharges = Array.isArray(company.estimatedOtherCharges) ? company.estimatedOtherCharges : [];
const customerScopeRows = Array.isArray(company.customerScope) ? company.customerScope : [];
const termsConditions = Array.isArray(company.termsConditions) ? company.termsConditions : [];
const warrantyRows = Array.isArray(company.warranty) ? company.warranty : [];
const authConfig = {
  username: text(process.env.APP_LOGIN_USERNAME).trim(),
  password: text(process.env.APP_LOGIN_PASSWORD),
  secret: text(process.env.AUTH_SECRET),
  cookieName: 'nb_auth',
  cookieMaxAgeSeconds: 60 * 60 * 12
};

if (!authConfig.username || !authConfig.password || !authConfig.secret) {
  throw new Error('Missing required env vars: APP_LOGIN_USERNAME, APP_LOGIN_PASSWORD, AUTH_SECRET');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/public', express.static(path.join(__dirname, 'public')));

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) {
    return out;
  }

  cookieHeader.split(';').forEach((part) => {
    const [rawKey, ...rawValueParts] = part.trim().split('=');
    if (!rawKey) {
      return;
    }

    const rawValue = rawValueParts.join('=');
    out[rawKey] = decodeURIComponent(rawValue || '');
  });

  return out;
}

function signAuthData(data) {
  return crypto
    .createHmac('sha256', authConfig.secret)
    .update(data)
    .digest('hex');
}

function createAuthToken(username) {
  const expiresAt = Date.now() + (authConfig.cookieMaxAgeSeconds * 1000);
  const data = `${username}|${expiresAt}`;
  const encoded = Buffer.from(data, 'utf8').toString('base64url');
  const signature = signAuthData(data);
  return `${encoded}.${signature}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [encoded, signature] = token.split('.', 2);
  if (!encoded || !signature) {
    return null;
  }

  let data = '';
  try {
    data = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch (error) {
    return null;
  }

  const expectedSignature = signAuthData(data);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const [username, expiresAtRaw] = data.split('|');
  const expiresAt = Number(expiresAtRaw);
  if (!username || !Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return null;
  }

  if (username !== authConfig.username) {
    return null;
  }

  return username;
}

function serializeCookie(name, value, { path: cookiePath, maxAgeSeconds, secure = false }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${cookiePath || '/'}`,
    'HttpOnly',
    'SameSite=Lax'
  ];

  if (Number.isFinite(maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function setAuthCookie(res, token) {
  const cookiePath = normalizedBasePath || '/';
  const secureCookie = process.env.AUTH_COOKIE_SECURE === 'true';
  res.setHeader('Set-Cookie', serializeCookie(authConfig.cookieName, token, {
    path: cookiePath,
    maxAgeSeconds: authConfig.cookieMaxAgeSeconds,
    secure: secureCookie
  }));
}

function clearAuthCookie(res) {
  const cookiePath = normalizedBasePath || '/';
  const secureCookie = process.env.AUTH_COOKIE_SECURE === 'true';
  res.setHeader('Set-Cookie', serializeCookie(authConfig.cookieName, '', {
    path: cookiePath,
    maxAgeSeconds: 0,
    secure: secureCookie
  }));
}

function getSafeNextPath(nextValue) {
  const candidate = text(nextValue).trim();
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.startsWith('/login')) {
    return '/';
  }
  return candidate;
}

function normalizeBankAccount(bank, index) {
  return {
    key: text(bank.key || `bank-${index + 1}`).trim(),
    label: text(bank.label || bank.bankName || `Bank ${index + 1}`).trim(),
    holderName: text(bank.holderName || bank.accountName).trim(),
    accountNumber: text(bank.accountNumber || bank.accountNo).trim(),
    bankName: text(bank.bankName || bank.label).trim(),
    ifsc: text(bank.ifsc).trim(),
    branch: text(bank.branch).trim()
  };
}

function getConfiguredBankAccounts() {
  return bankAccounts
    .map((bank, index) => normalizeBankAccount(bank, index))
    .filter((bank) => bank.key);
}

function getSelectedBank(bankKey) {
  const configuredBanks = getConfiguredBankAccounts();
  if (!configuredBanks.length) {
    return null;
  }

  const requestedKey = text(bankKey).trim();
  return configuredBanks.find((bank) => bank.key === requestedKey) || configuredBanks[0];
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatDate(dateValue) {
  if (!dateValue) return '';
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeProposalCellValue(value) {
  const raw = text(value).trim();
  if (!raw.includes(',')) {
    return raw;
  }

  const parts = raw.split(',').map((part) => part.trim()).filter((part) => part.length);
  if (parts.length > 1 && parts.every((part) => part === parts[0])) {
    return parts[0];
  }

  return raw;
}

function normalizeProposalTemplateRow(row, index) {
  return {
    sr_no: normalizeProposalCellValue(row.sr_no || index + 1),
    description: normalizeProposalCellValue(row.description),
    unit: normalizeProposalCellValue(row.unit),
    specification: normalizeProposalCellValue(row.specification),
    qty: normalizeProposalCellValue(row.qty),
    make: normalizeProposalCellValue(row.make)
  };
}

function getDefaultProposalItems() {
  return proposalTemplate.map(normalizeProposalTemplateRow);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function firstValue(value) {
  if (!Array.isArray(value)) {
    return value;
  }

  for (const candidate of value) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim() !== '') {
      return candidate;
    }
  }

  return value.length ? value[0] : '';
}

function readFieldFromObject(obj, keys) {
  if (!isObject(obj)) {
    return { found: false, value: undefined };
  }

  for (const key of keys) {
    if (hasOwn(obj, key)) {
      return { found: true, value: firstValue(obj[key]) };
    }
  }

  return { found: false, value: undefined };
}

function readProposalField({ row, rowKeys, formBody, formKeys, fallback }) {
  if (isObject(formBody)) {
    for (const key of formKeys) {
      if (hasOwn(formBody, key)) {
        return normalizeProposalCellValue(firstValue(formBody[key]));
      }
    }
  }

  const rowResult = readFieldFromObject(row, rowKeys);
  if (rowResult.found) {
    return normalizeProposalCellValue(rowResult.value);
  }

  return normalizeProposalCellValue(fallback);
}

function normalizeProposalRowByIndex({ row, idx, defaults, formBody }) {
  const baseRow = defaults[idx] || {};

  return {
    sr_no: readProposalField({
      row,
      rowKeys: ['sr_no', 'srNo', 'srno', 'sr'],
      formBody,
      formKeys: [`proposal_sr_no_${idx}`, `proposal_srno_${idx}`],
      fallback: baseRow.sr_no || idx + 1
    }),
    description: readProposalField({
      row,
      rowKeys: ['description', 'desc'],
      formBody,
      formKeys: [`proposal_description_${idx}`],
      fallback: baseRow.description || ''
    }),
    unit: readProposalField({
      row,
      rowKeys: ['unit'],
      formBody,
      formKeys: [`proposal_unit_${idx}`],
      fallback: baseRow.unit || ''
    }),
    qty: readProposalField({
      row,
      rowKeys: ['qty', 'quantity'],
      formBody,
      formKeys: [`proposal_qty_${idx}`, `proposal_quantity_${idx}`],
      fallback: baseRow.qty || ''
    }),
    specification: readProposalField({
      row,
      rowKeys: ['specification', 'spec', 'specs'],
      formBody,
      formKeys: [`proposal_specification_${idx}`, `proposal_spec_${idx}`],
      fallback: baseRow.specification || ''
    }),
    make: readProposalField({
      row,
      rowKeys: ['make', 'brand'],
      formBody,
      formKeys: [`proposal_make_${idx}`],
      fallback: baseRow.make || ''
    })
  };
}

function hasProposalContent(row) {
  return Boolean(
    row.sr_no ||
    row.description ||
    row.unit ||
    row.qty ||
    row.specification ||
    row.make
  );
}

function parseProposalItems(proposalItemsJson, formBody = null) {
  const defaults = getDefaultProposalItems();

  let parsed = [];
  try {
    parsed = proposalItemsJson ? JSON.parse(proposalItemsJson) : [];
  } catch (error) {
    parsed = [];
  }

  // Support double-encoded payloads (stringified JSON string).
  if (typeof parsed === 'string') {
    try {
      parsed = parsed ? JSON.parse(parsed) : [];
    } catch (error) {
      parsed = [];
    }
  }

  if (Array.isArray(parsed) && parsed.length) {
    const normalized = parsed
      .map((row, idx) => normalizeProposalRowByIndex({
        row: isObject(row) ? row : {},
        idx,
        defaults,
        formBody
      }))
      .filter(hasProposalContent);

    if (normalized.length) {
      return normalized;
    }
  }

  if (isObject(formBody)) {
    const indexedKeys = Object.keys(formBody)
      .map((key) => {
        const match = key.match(/^proposal_(?:sr_no|srno|description|unit|qty|quantity|specification|spec|make)_(\d+)$/);
        return match ? Number(match[1]) : null;
      })
      .filter((idx) => Number.isInteger(idx));

    if (indexedKeys.length) {
      const uniqueSortedIndexes = [...new Set(indexedKeys)].sort((a, b) => a - b);
      const rowsFromForm = uniqueSortedIndexes
        .map((idx) => normalizeProposalRowByIndex({ row: {}, idx, defaults, formBody }))
        .filter(hasProposalContent);

      if (rowsFromForm.length) {
        return rowsFromForm;
      }
    }
  }

  if (defaults.length) {
    return defaults;
  }

  return [];
}

function calculateItem(item) {
  const qty = Number(item.qty || 0);
  const unitPrice = Number(item.unit_price || 0);
  const gstRate = Number(item.gst_rate || 0);
  const taxable = round2(qty * unitPrice);
  const halfRate = gstRate / 2;
  const cgst = round2((taxable * halfRate) / 100);
  const sgst = round2((taxable * halfRate) / 100);
  const total = round2(taxable + cgst + sgst);

  return {
    ...item,
    qty,
    unit_price: unitPrice,
    gst_rate: gstRate,
    taxable,
    cgst,
    sgst,
    total
  };
}

function parseItems(itemsJson) {
  let parsed = [];
  try {
    parsed = JSON.parse(itemsJson || '[]');
  } catch (error) {
    throw new Error('Invalid item data in request.');
  }

  const items = Array.isArray(parsed) ? parsed.map(calculateItem) : [];
  if (!items.length) {
    throw new Error('Please add at least one item.');
  }

  const hasName = items.some((item) => String(item.name || '').trim());
  if (!hasName) {
    throw new Error('Please provide item name.');
  }

  return items.filter((item) => String(item.name || '').trim());
}

async function generateQuoteNumber(id, quoteDate) {
  const year = new Date(quoteDate).getFullYear();
  return `Q-${year}-${String(id).padStart(4, '0')}`;
}

function buildQuoteSummary(items) {
  const subtotal = round2(items.reduce((sum, item) => sum + item.taxable, 0));
  const cgstTotal = round2(items.reduce((sum, item) => sum + item.cgst, 0));
  const sgstTotal = round2(items.reduce((sum, item) => sum + item.sgst, 0));
  const total = round2(subtotal + cgstTotal + sgstTotal);

  return { subtotal, cgstTotal, sgstTotal, total };
}

async function ensureQuoteEnhancements() {
  const dbName = process.env.DB_NAME;
  if (!dbName) {
    return;
  }

  const [rows] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'quotes'
       AND COLUMN_NAME IN ('proposal_items_json', 'selected_bank_key')`,
    [dbName]
  );

  const columns = new Set(rows.map((row) => row.COLUMN_NAME));

  if (!columns.has('proposal_items_json')) {
    await pool.query('ALTER TABLE quotes ADD COLUMN proposal_items_json LONGTEXT NULL');
  }

  if (!columns.has('selected_bank_key')) {
    await pool.query('ALTER TABLE quotes ADD COLUMN selected_bank_key VARCHAR(100) NULL');
  }
}

async function saveQuote({ body, quoteId }) {
  const items = parseItems(body.items_json || '[]');
  const proposalItems = parseProposalItems(body.proposal_items_json || '[]', body);
  const proposalItemsJson = JSON.stringify(proposalItems);
  const { subtotal, cgstTotal, sgstTotal, total } = buildQuoteSummary(items);
  const selectedBank = getSelectedBank(body.selected_bank_key);
  const selectedBankKey = selectedBank ? selectedBank.key : null;

  const quoteDate = body.quote_date || new Date().toISOString().slice(0, 10);
  const customerName = String(body.customer_name || '').trim();

  if (!customerName) {
    throw new Error('Customer name is required.');
  }
  if (!selectedBankKey) {
    throw new Error('Please select bank account details.');
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    let finalQuoteId = Number(quoteId || 0);

    if (!finalQuoteId) {
      const [insertResult] = await connection.query(
        `INSERT INTO quotes
          (quote_no, quote_date, customer_name, customer_phone, customer_email, customer_address, customer_gstin, selected_bank_key, proposal_items_json, subtotal, cgst_total, sgst_total, total, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          null,
          quoteDate,
          customerName,
          body.customer_phone || null,
          body.customer_email || null,
          body.customer_address || null,
          body.customer_gstin || null,
          selectedBankKey,
          proposalItemsJson,
          subtotal,
          cgstTotal,
          sgstTotal,
          total,
          body.notes || null
        ]
      );

      finalQuoteId = insertResult.insertId;
      const quoteNo = await generateQuoteNumber(finalQuoteId, quoteDate);
      await connection.query('UPDATE quotes SET quote_no = ? WHERE id = ?', [quoteNo, finalQuoteId]);
    } else {
      const [[existingQuote]] = await connection.query('SELECT id, quote_no FROM quotes WHERE id = ?', [finalQuoteId]);
      if (!existingQuote) {
        throw new Error('Quote not found.');
      }

      await connection.query(
        `UPDATE quotes
         SET quote_date = ?, customer_name = ?, customer_phone = ?, customer_email = ?, customer_address = ?, customer_gstin = ?,
             selected_bank_key = ?, proposal_items_json = ?, subtotal = ?, cgst_total = ?, sgst_total = ?, total = ?, notes = ?
         WHERE id = ?`,
        [
          quoteDate,
          customerName,
          body.customer_phone || null,
          body.customer_email || null,
          body.customer_address || null,
          body.customer_gstin || null,
          selectedBankKey,
          proposalItemsJson,
          subtotal,
          cgstTotal,
          sgstTotal,
          total,
          body.notes || null,
          finalQuoteId
        ]
      );

      if (!existingQuote.quote_no) {
        const quoteNo = await generateQuoteNumber(finalQuoteId, quoteDate);
        await connection.query('UPDATE quotes SET quote_no = ? WHERE id = ?', [quoteNo, finalQuoteId]);
      }

      await connection.query('DELETE FROM quote_items WHERE quote_id = ?', [finalQuoteId]);
    }

    for (const item of items) {
      await connection.query(
        `INSERT INTO quote_items
          (quote_id, product_id, name, description, hsn, unit, qty, unit_price, gst_rate, taxable, cgst, sgst, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          finalQuoteId,
          item.product_id || null,
          item.name,
          item.description || null,
          item.hsn || null,
          item.unit || null,
          item.qty,
          item.unit_price,
          item.gst_rate,
          item.taxable,
          item.cgst,
          item.sgst,
          item.total
        ]
      );
    }

    await connection.commit();
    return finalQuoteId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function loadQuote(quoteId) {
  const [[quote]] = await pool.query('SELECT * FROM quotes WHERE id = ?', [quoteId]);
  if (!quote) {
    return null;
  }

  const [itemsRaw] = await pool.query('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id', [quoteId]);
  const items = itemsRaw.map((item) => ({
    product_id: item.product_id,
    name: item.name,
    description: item.description,
    hsn: item.hsn,
    unit: item.unit,
    qty: Number(item.qty || 0),
    unit_price: Number(item.unit_price || 0),
    gst_rate: Number(item.gst_rate || 0)
  }));

  const proposalItems = parseProposalItems(quote.proposal_items_json);

  return {
    quote: {
      ...quote,
      quote_date_display: formatDate(quote.quote_date)
    },
    items,
    proposalItems
  };
}

function drawTable(doc, {
  title,
  columns,
  rows,
  startY,
  x = 40,
  drawTitleOnNewPage = true,
  keepTogether = false
}) {
  const totalWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const titleHeight = title ? 24 : 0;
  const headerHeight = 24;

  let y = startY;

  if (keepTogether) {
    let estimatedHeight = title ? titleHeight : 0;
    estimatedHeight += headerHeight;
    rows.forEach((row) => {
      const rowValues = columns.map((col) => text(row[col.key] || ''));
      const rowHeight = Math.max(
        24,
        ...rowValues.map((value, idx) => {
          const col = columns[idx];
          const cellHeight = doc.heightOfString(value, {
            width: col.width - 8,
            align: col.align || 'left'
          });
          return cellHeight + 8;
        })
      );
      estimatedHeight += rowHeight;
    });

    if (y + estimatedHeight > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  }

  function drawTitleRow(textValue) {
    doc.save();
    doc.rect(x, y, totalWidth, titleHeight).fill('#ececec');
    doc.restore();
    doc.rect(x, y, totalWidth, titleHeight).stroke();
    doc.font('Helvetica-Bold').fontSize(12).text(textValue, x, y + 6, { width: totalWidth, align: 'center' });
    y += titleHeight;
  }

  function drawHeaderRow() {
    doc.save();
    doc.rect(x, y, totalWidth, headerHeight).fill('#f4f4f4');
    doc.restore();
    doc.rect(x, y, totalWidth, headerHeight).stroke();

    let xCursor = x;
    columns.forEach((col) => {
      doc.rect(xCursor, y, col.width, headerHeight).stroke();
      doc.font('Helvetica-Bold').fontSize(10).text(col.label, xCursor + 4, y + 6, {
        width: col.width - 8,
        align: col.align || 'left'
      });
      xCursor += col.width;
    });

    y += headerHeight;
  }

  if (title) {
    if (y + titleHeight + headerHeight > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    drawTitleRow(title);
  }

  if (y + headerHeight > pageBottom) {
    doc.addPage();
    y = doc.page.margins.top;
    if (title && drawTitleOnNewPage) {
      drawTitleRow(title);
    }
  }
  drawHeaderRow();

  rows.forEach((row) => {
    const rowValues = columns.map((col) => text(row[col.key] || ''));
    const rowHeight = Math.max(
      24,
      ...rowValues.map((value, idx) => {
        const col = columns[idx];
        const cellHeight = doc.heightOfString(value, {
          width: col.width - 8,
          align: col.align || 'left'
        });
        return cellHeight + 8;
      })
    );

    if (y + rowHeight > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      if (title && drawTitleOnNewPage) {
        drawTitleRow(title);
      }
      drawHeaderRow();
    }

    let xCursor = x;
    columns.forEach((col, idx) => {
      doc.rect(xCursor, y, col.width, rowHeight).stroke();
      doc.font('Helvetica').fontSize(10).text(rowValues[idx], xCursor + 4, y + 4, {
        width: col.width - 8,
        align: col.align || 'left'
      });
      xCursor += col.width;
    });

    y += rowHeight;
  });

  return y;
}

function formatMoney(value) {
  return Number(value || 0).toFixed(2);
}

function sanitizePdfLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .trim();
}

function escapePdfText(value) {
  return sanitizePdfLine(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapPdfLine(line, maxChars = 110) {
  const clean = sanitizePdfLine(line);
  if (!clean) {
    return [''];
  }

  const words = clean.split(' ');
  const out = [];
  let current = '';

  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }

    const candidate = `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      return;
    }

    out.push(current);
    current = word;
  });

  if (current) {
    out.push(current);
  }

  return out.length ? out : [''];
}

function buildFallbackPdfLines({ quote, items, proposalItems, selectedBank }) {
  const lines = [];

  lines.push(company.name || 'Quotation');
  if (company.tagline) lines.push(company.tagline);
  if (company.address) lines.push(company.address);
  if (company.phone) lines.push(`Phone: ${company.phone}`);
  if (company.email) lines.push(`Email: ${company.email}`);
  if (company.gstin) lines.push(`GSTIN: ${company.gstin}`);

  lines.push('');
  lines.push('QUOTATION');
  lines.push(`Quote No: ${quote.quote_no || '-'}`);
  lines.push(`Date: ${formatDate(quote.quote_date)}`);
  lines.push(`Customer: ${quote.customer_name || '-'}`);
  lines.push(`Phone: ${quote.customer_phone || '-'}`);
  lines.push(`Email: ${quote.customer_email || '-'}`);
  lines.push(`Customer GSTIN: ${quote.customer_gstin || '-'}`);
  lines.push(`Address: ${quote.customer_address || '-'}`);

  lines.push('');
  lines.push('ITEMS');
  items.forEach((item, index) => {
    lines.push(
      `${index + 1}. ${item.name || '-'} | HSN: ${item.hsn || '-'} | Qty: ${item.qty || 0} | ` +
      `Rate: ${formatMoney(item.unit_price)} | GST: ${formatMoney(item.gst_rate)}% | Total: ${formatMoney(item.total)}`
    );
  });
  lines.push(`Subtotal: ${formatMoney(quote.subtotal)}`);
  lines.push(`CGST: ${formatMoney(quote.cgst_total)}`);
  lines.push(`SGST: ${formatMoney(quote.sgst_total)}`);
  lines.push(`Grand Total: ${formatMoney(quote.total)}`);

  lines.push('');
  lines.push('ITEMS CONSIDERED FOR PROPOSAL');
  proposalItems.forEach((row) => {
    lines.push(
      `${row.sr_no || '-'} | ${row.description || '-'} | Unit: ${row.unit || '-'} | ` +
      `Qty: ${row.qty || '-'} | Specification: ${row.specification || '-'} | Make: ${row.make || '-'}`
    );
  });

  if (estimatedOtherCharges.length) {
    lines.push('');
    lines.push('ESTIMATED OTHER CHARGES');
    estimatedOtherCharges.forEach((row) => {
      lines.push(`${row.item || '-'} | ${row.remark || '-'}`);
    });
    if (company.estimatedOtherChargesFooter) {
      lines.push(company.estimatedOtherChargesFooter);
    }
  }

  if (customerScopeRows.length) {
    lines.push('');
    lines.push('SCOPE OF WORK');
    customerScopeRows.forEach((row) => {
      lines.push(`${row.sr_no || '-'} | ${row.description || '-'} | ${row.remark || '-'}`);
    });
  }

  if (termsConditions.length) {
    lines.push('');
    lines.push('TERMS & CONDITIONS');
    termsConditions.forEach((row) => {
      lines.push(`${row.sr_no || '-'} | ${row.parameter || '-'} | ${row.remark || '-'}`);
    });
  }

  if (warrantyRows.length) {
    lines.push('');
    lines.push('WARRANTEE');
    warrantyRows.forEach((row) => {
      lines.push(`${row.sr_no || '-'} | ${row.parameter || '-'} | ${row.remark || '-'}`);
    });
  }

  if (selectedBank) {
    lines.push('');
    lines.push('BANK ACCOUNT DETAILS');
    lines.push(`Account Holder: ${selectedBank.holderName || '-'}`);
    lines.push(`Account Number: ${selectedBank.accountNumber || '-'}`);
    lines.push(`Bank: ${selectedBank.bankName || selectedBank.label || '-'}`);
    lines.push(`IFSC: ${selectedBank.ifsc || '-'}`);
    if (selectedBank.branch) {
      lines.push(`Branch: ${selectedBank.branch}`);
    }
  }

  if (quote.notes) {
    lines.push('');
    lines.push(`Additional Note: ${quote.notes}`);
  }

  lines.push('');
  lines.push(`FOR, ${company.name || 'New Bharat Enterprise'}`);
  lines.push('(Stamp of Company)');
  lines.push('Signatory Authorized');

  return lines.flatMap((line) => wrapPdfLine(line));
}

function createSimplePdfBuffer(lines) {
  const pageWidth = 595;
  const pageHeight = 842;
  const startX = 40;
  const startY = 800;
  const bottomMargin = 40;
  const lineHeight = 13;
  const maxLinesPerPage = Math.max(1, Math.floor((startY - bottomMargin) / lineHeight));

  const normalizedLines = Array.isArray(lines) && lines.length ? lines : ['Quotation'];
  const pages = [];
  for (let i = 0; i < normalizedLines.length; i += maxLinesPerPage) {
    pages.push(normalizedLines.slice(i, i + maxLinesPerPage));
  }

  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  const fontObjectId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageObjectIds = [];

  pages.forEach((pageLines) => {
    const operations = ['BT', '/F1 10 Tf', `1 0 0 1 ${startX} ${startY} Tm`];

    pageLines.forEach((line, idx) => {
      operations.push(`(${escapePdfText(line)}) Tj`);
      if (idx < pageLines.length - 1) {
        operations.push(`0 -${lineHeight} Td`);
      }
    });

    operations.push('ET');
    const stream = operations.join('\n');
    const contentObjectId = addObject(
      `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`
    );

    const pageObjectId = addObject(
      `<< /Type /Page /Parent __PAGES_OBJECT__ 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`
    );
    pageObjectIds.push(pageObjectId);
  });

  const pagesObjectId = addObject(
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`
  );

  pageObjectIds.forEach((id) => {
    objects[id - 1] = objects[id - 1].replace('__PAGES_OBJECT__', String(pagesObjectId));
  });

  const catalogObjectId = addObject(`<< /Type /Catalog /Pages ${pagesObjectId} 0 R >>`);

  let pdf = '%PDF-1.4\n%1234\n';
  const offsets = [0];
  objects.forEach((objectContent, idx) => {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${idx + 1} 0 obj\n${objectContent}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });

  pdf += `${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogObjectId} 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

function isPdfkitFontDataError(error) {
  const message = String(error && error.message ? error.message : error);
  return message.includes('Helvetica.afm') || (message.includes('/pdfkit/') && message.includes('/data/'));
}

function getCompanyStampPath() {
  const candidates = [
    path.join(__dirname, 'public', 'stamp.png'),
    path.join(__dirname, 'public', 'stamp.jpg'),
    path.join(__dirname, 'public', 'stamp.jpeg'),
    path.join(__dirname, 'public', 'company-stamp.png')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function drawSignatorySection(doc, startY) {
  const sectionHeight = 178;
  let y = startY;
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const sectionX = 330;
  const sectionWidth = 220;
  const sectionCenterX = sectionX + (sectionWidth / 2);
  const stampWidth = 130;
  const stampHeight = 96;

  if (y + sectionHeight > pageBottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  doc.font('Helvetica-Bold').fontSize(11).text(`FOR, ${company.name || 'New Bharat Enterprise'}`, sectionX, y, {
    width: sectionWidth,
    align: 'center'
  });

  const stampPath = getCompanyStampPath();
  const stampY = y + 20;
  const stampX = Math.round(sectionCenterX - (stampWidth / 2));
  const stampCaptionY = stampY + stampHeight + 6;
  const signatoryY = stampCaptionY + 24;

  if (stampPath) {
    doc.image(stampPath, stampX, stampY, { fit: [stampWidth, stampHeight], align: 'center', valign: 'center' });
    doc.font('Helvetica').fontSize(10).text('(Stamp of Company)', sectionX, stampCaptionY, {
      width: sectionWidth,
      align: 'center'
    });
  } else {
    doc.font('Helvetica').fontSize(10).text('(Stamp of Company)', sectionX, y + 72, {
      width: sectionWidth,
      align: 'center'
    });
  }

  doc.font('Helvetica').fontSize(11).text('Signatory Authorized', sectionX, signatoryY, {
    width: sectionWidth,
    align: 'center'
  });

  return y + sectionHeight;
}

function drawBankDetailsSection(doc, startY, selectedBank) {
  if (!selectedBank) {
    return startY;
  }

  let y = startY;
  const x = 40;
  const width = 515;
  const titleHeight = 24;
  const rowHeight = 22;
  const rows = [
    ['Account Holder', selectedBank.holderName || '-'],
    ['Account Number', selectedBank.accountNumber || '-'],
    ['Bank', selectedBank.bankName || selectedBank.label || '-'],
    ['IFSC', selectedBank.ifsc || '-']
  ];

  if (selectedBank.branch) {
    rows.push(['Branch', selectedBank.branch]);
  }

  const estimatedHeight = titleHeight + (rows.length * rowHeight);
  if (y + estimatedHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  doc.save();
  doc.rect(x, y, width, titleHeight).fill('#ececec');
  doc.restore();
  doc.rect(x, y, width, titleHeight).stroke();
  doc.font('Helvetica-Bold').fontSize(12).text('Bank Account Details', x, y + 6, {
    width,
    align: 'center'
  });
  y += titleHeight;

  rows.forEach(([label, value]) => {
    doc.rect(x, y, 160, rowHeight).stroke();
    doc.rect(x + 160, y, width - 160, rowHeight).stroke();
    doc.font('Helvetica-Bold').fontSize(10).text(label, x + 6, y + 6, { width: 148 });
    doc.font('Helvetica').fontSize(10).text(value, x + 166, y + 6, { width: width - 172 });
    y += rowHeight;
  });

  return y;
}

function generatePdfKitBuffer({ quote, items, proposalItems, selectedBank, quoteId }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const logoPath = path.join(__dirname, 'public', 'logo.png');
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, 40, 40, { width: 120 });
      }

      doc
        .fontSize(18)
        .text(company.name, 180, 45)
        .fontSize(10)
        .text(company.tagline || '', 180, 65)
        .text(company.address || '', 180, 80)
        .text(`Phone: ${company.phone || ''}`, 180, 95)
        .text(`Email: ${company.email || ''}`, 180, 110)
        .text(`GSTIN: ${company.gstin || ''}`, 180, 125);

      doc.moveDown(2);
      doc
        .fontSize(16)
        .text('Quotation', { align: 'right' })
        .fontSize(10)
        .text(`Quote No: ${quote.quote_no || `quote-${quoteId}`}`, { align: 'right' })
        .text(`Date: ${formatDate(quote.quote_date)}`, { align: 'right' });

      doc.moveDown();
      doc
        .fontSize(11)
        .text(`Customer: ${quote.customer_name}`)
        .text(`Phone: ${quote.customer_phone || '-'}`)
        .text(`Email: ${quote.customer_email || '-'}`)
        .text(`GSTIN: ${quote.customer_gstin || '-'}`)
        .text(`Address: ${quote.customer_address || '-'}`);

      doc.moveDown();

      const tableTop = doc.y + 10;
      const itemStartY = tableTop + 20;

      const col = {
        no: 40,
        name: 70,
        hsn: 240,
        qty: 300,
        rate: 340,
        gst: 400,
        total: 470
      };

      doc
        .fontSize(9)
        .text('No', col.no, tableTop)
        .text('Item', col.name, tableTop)
        .text('HSN', col.hsn, tableTop)
        .text('Qty', col.qty, tableTop)
        .text('Rate', col.rate, tableTop)
        .text('GST%', col.gst, tableTop)
        .text('Total', col.total, tableTop, { align: 'right', width: 80 });

      doc.moveTo(40, tableTop + 12).lineTo(555, tableTop + 12).stroke();

      let y = itemStartY;
      items.forEach((item, index) => {
        if (y > 700) {
          doc.addPage();
          y = 60;
        }

        const qty = Number(item.qty || 0);
        const unitPrice = Number(item.unit_price || 0);
        const gstRate = Number(item.gst_rate || 0);
        const lineTotal = Number(item.total || 0);

        doc
          .fontSize(9)
          .text(String(index + 1), col.no, y)
          .text(item.name, col.name, y, { width: 160 })
          .text(item.hsn || '-', col.hsn, y)
          .text(String(qty), col.qty, y)
          .text(unitPrice.toFixed(2), col.rate, y)
          .text(gstRate.toFixed(2), col.gst, y)
          .text(lineTotal.toFixed(2), col.total, y, { align: 'right', width: 80 });

        y += 20;
      });

      doc
        .fontSize(10)
        .text(`Subtotal: ${Number(quote.subtotal).toFixed(2)}`, 350, y + 10, { align: 'right', width: 200 })
        .text(`CGST: ${Number(quote.cgst_total).toFixed(2)}`, 350, y + 25, { align: 'right', width: 200 })
        .text(`SGST: ${Number(quote.sgst_total).toFixed(2)}`, 350, y + 40, { align: 'right', width: 200 })
        .fontSize(12)
        .text(`Grand Total: ${Number(quote.total).toFixed(2)}`, 350, y + 60, { align: 'right', width: 200 });

      let sectionY = y + 100;

      sectionY = drawTable(doc, {
        title: 'ITEMS CONSIDERED FOR PROPOSAL',
        startY: sectionY,
        columns: [
          { key: 'sr_no', label: 'Sr.no', width: 40, align: 'center' },
          { key: 'description', label: 'Description', width: 170 },
          { key: 'unit', label: 'Unit', width: 60, align: 'center' },
          { key: 'qty', label: 'Qty.', width: 70, align: 'center' },
          { key: 'specification', label: 'Specification', width: 85, align: 'center' },
          { key: 'make', label: 'Make', width: 90, align: 'center' }
        ],
        rows: proposalItems
      }) + 12;

      const estimatedRows = estimatedOtherCharges.map((row) => ({
        item: row.item,
        remark: row.remark
      }));

      if (company.estimatedOtherChargesFooter) {
        estimatedRows.push({
          item: company.estimatedOtherChargesFooter,
          remark: ''
        });
      }

      sectionY = drawTable(doc, {
        title: 'Estimated Other Charges',
        startY: sectionY,
        columns: [
          { key: 'item', label: 'Particulars', width: 375, align: 'center' },
          { key: 'remark', label: 'Status', width: 140, align: 'center' }
        ],
        rows: estimatedRows
      }) + 12;

      if (customerScopeRows.length) {
        sectionY = drawTable(doc, {
          title: 'Scope Of Work',
          startY: sectionY,
          columns: [
            { key: 'sr_no', label: 'Sr.no', width: 45, align: 'center' },
            { key: 'description', label: 'Description', width: 280 },
            { key: 'remark', label: 'Customer Scope', width: 190, align: 'center' }
          ],
          rows: customerScopeRows
        }) + 12;
      }

      sectionY = drawTable(doc, {
        title: 'Terms & Conditions',
        startY: sectionY,
        columns: [
          { key: 'sr_no', label: 'Sr.no', width: 45, align: 'center' },
          { key: 'parameter', label: 'Parameters', width: 240 },
          { key: 'remark', label: 'Remarks', width: 230, align: 'center' }
        ],
        rows: termsConditions
      }) + 12;

      sectionY = drawTable(doc, {
        title: 'Warrantee',
        startY: sectionY,
        columns: [
          { key: 'sr_no', label: 'Sr.no', width: 45, align: 'center' },
          { key: 'parameter', label: 'Parameters', width: 240 },
          { key: 'remark', label: 'Remarks', width: 230, align: 'center' }
        ],
        rows: warrantyRows,
        keepTogether: true
      }) + 10;

      sectionY = drawBankDetailsSection(doc, sectionY, selectedBank) + 12;

      if (quote.notes) {
        if (sectionY > doc.page.height - 100) {
          doc.addPage();
          sectionY = doc.page.margins.top;
        }
        doc.font('Helvetica-Bold').fontSize(10).text('Additional Note:', 40, sectionY);
        doc.font('Helvetica').fontSize(10).text(quote.notes, 40, sectionY + 14, { width: 515 });
        const noteHeight = doc.heightOfString(quote.notes, { width: 515 });
        sectionY += noteHeight + 28;
      }

      drawSignatorySection(doc, sectionY + 12);

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

app.get('/login', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const currentUser = verifyAuthToken(cookies[authConfig.cookieName]);
  const nextPath = getSafeNextPath(req.query.next);

  if (currentUser) {
    return res.redirect(withBase(nextPath));
  }

  return res.render('login', {
    company,
    title: 'Sign In',
    nextPath,
    error: ''
  });
});

app.post('/login', (req, res) => {
  const username = text(req.body.username).trim();
  const password = text(req.body.password);
  const nextPath = getSafeNextPath(req.body.next);

  if (username !== authConfig.username || password !== authConfig.password) {
    return res.status(401).render('login', {
      company,
      title: 'Sign In',
      nextPath,
      error: 'Invalid username or password.'
    });
  }

  const token = createAuthToken(username);
  setAuthCookie(res, token);
  return res.redirect(withBase(nextPath));
});

app.get('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect(withBase('/login'));
});

app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/logout') {
    return next();
  }

  const cookies = parseCookies(req.headers.cookie || '');
  const authUser = verifyAuthToken(cookies[authConfig.cookieName]);
  if (!authUser) {
    const nextPath = getSafeNextPath(req.url || '/');
    return res.redirect(withBase(`/login?next=${encodeURIComponent(nextPath)}`));
  }

  res.locals.authUser = authUser;
  return next();
});

app.get('/', asyncHandler(async (req, res) => {
  const [products] = await pool.query('SELECT * FROM products ORDER BY name');
  res.render('quote_new', {
    products,
    company,
    pageTitle: 'New Quotation',
    formAction: '/quotes',
    submitLabel: 'Save & Download PDF',
    quote: null,
    initialItems: [],
    initialProposalItems: getDefaultProposalItems()
  });
}));

app.get('/products', asyncHandler(async (req, res) => {
  const [products] = await pool.query('SELECT * FROM products ORDER BY name');
  res.render('products', { products, company });
}));

app.post('/products', asyncHandler(async (req, res) => {
  const { name, description, hsn, unit, price, gst_rate } = req.body;
  if (!name) {
    return res.redirect(withBase('/products'));
  }

  await pool.query(
    'INSERT INTO products (name, description, hsn, unit, price, gst_rate) VALUES (?, ?, ?, ?, ?, ?)',
    [name, description || null, hsn || null, unit || null, price || 0, gst_rate || 0]
  );

  res.redirect(withBase('/products'));
}));

app.get('/products/:id/edit', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [[product]] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);

  if (!product) {
    return res.status(404).send('Product not found');
  }

  res.render('product_edit', { company, product });
}));

app.post('/products/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, description, hsn, unit, price, gst_rate } = req.body;

  await pool.query(
    `UPDATE products
     SET name = ?, description = ?, hsn = ?, unit = ?, price = ?, gst_rate = ?
     WHERE id = ?`,
    [name, description || null, hsn || null, unit || null, price || 0, gst_rate || 0, id]
  );

  res.redirect(withBase('/products'));
}));

app.post('/products/:id/delete', asyncHandler(async (req, res) => {
  const { id } = req.params;
  await pool.query('DELETE FROM products WHERE id = ?', [id]);
  res.redirect(withBase('/products'));
}));

app.get('/quotes', asyncHandler(async (req, res) => {
  const search = String(req.query.q || '').trim();

  let sql = 'SELECT id, quote_no, quote_date, customer_name, total FROM quotes';
  const params = [];

  if (search) {
    sql += ' WHERE customer_name LIKE ?';
    params.push(`%${search}%`);
  }

  sql += ' ORDER BY id DESC';

  const [quotesRaw] = await pool.query(sql, params);
  const quotes = quotesRaw.map((quote) => ({
    ...quote,
    quote_date_display: formatDate(quote.quote_date)
  }));

  res.render('quotes', { quotes, company, search });
}));

app.post('/quotes', asyncHandler(async (req, res) => {
  const quoteId = await saveQuote({ body: req.body });
  res.redirect(withBase(`/quotes/${quoteId}/pdf`));
}));

app.get('/quotes/:id/edit', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const loaded = await loadQuote(id);

  if (!loaded) {
    return res.status(404).send('Quote not found');
  }

  const [products] = await pool.query('SELECT * FROM products ORDER BY name');

  res.render('quote_new', {
    products,
    company,
    pageTitle: `Edit Quotation ${loaded.quote.quote_no || ''}`,
    formAction: `/quotes/${id}`,
    submitLabel: 'Update & Download PDF',
    quote: loaded.quote,
    initialItems: loaded.items,
    initialProposalItems: loaded.proposalItems
  });
}));

app.post('/quotes/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const quoteId = await saveQuote({ body: req.body, quoteId: id });
  res.redirect(withBase(`/quotes/${quoteId}/pdf`));
}));

app.get('/quotes/:id/pdf', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [[quote]] = await pool.query('SELECT * FROM quotes WHERE id = ?', [id]);
  const [items] = await pool.query('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id', [id]);

  if (!quote) {
    return res.status(404).send('Quote not found');
  }

  const proposalItems = parseProposalItems(quote.proposal_items_json);
  const selectedBank = getSelectedBank(quote.selected_bank_key);
  const fileName = `${quote.quote_no || `quote-${id}`}.pdf`;
  let pdfBuffer;
  let pdfEngine = 'pdfkit';

  try {
    pdfBuffer = await generatePdfKitBuffer({ quote, items, proposalItems, selectedBank, quoteId: id });
  } catch (error) {
    if (!isPdfkitFontDataError(error)) {
      throw error;
    }

    console.warn('PDFKit font data missing, using basic PDF fallback:', error.message);
    pdfEngine = 'basic-fallback';
    pdfBuffer = createSimplePdfBuffer(
      buildFallbackPdfLines({ quote, items, proposalItems, selectedBank })
    );
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('X-PDF-Engine', pdfEngine);
  res.send(pdfBuffer);
}));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).send(error.message || 'Something went wrong.');
});

async function startServer() {
  try {
    await ensureQuoteEnhancements();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

startServer();
