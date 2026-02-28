const path = require('path');
const fs = require('fs');
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

const proposalTemplate = Array.isArray(company.proposalTemplate) ? company.proposalTemplate : [];
const estimatedOtherCharges = Array.isArray(company.estimatedOtherCharges) ? company.estimatedOtherCharges : [];
const customerScopeRows = Array.isArray(company.customerScope) ? company.customerScope : [];
const termsConditions = Array.isArray(company.termsConditions) ? company.termsConditions : [];
const warrantyRows = Array.isArray(company.warranty) ? company.warranty : [];

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

function normalizeProposalTemplateRow(row, index) {
  return {
    sr_no: text(row.sr_no || index + 1),
    description: text(row.description),
    unit: text(row.unit),
    specification: text(row.specification),
    qty: text(row.qty),
    make: text(row.make)
  };
}

function getDefaultProposalItems() {
  return proposalTemplate.map(normalizeProposalTemplateRow);
}

function parseProposalItems(proposalItemsJson) {
  const defaults = getDefaultProposalItems();
  if (!defaults.length) {
    return [];
  }

  let parsed = [];
  try {
    parsed = proposalItemsJson ? JSON.parse(proposalItemsJson) : [];
  } catch (error) {
    parsed = [];
  }

  if (!Array.isArray(parsed)) {
    parsed = [];
  }

  return defaults.map((baseRow, idx) => {
    const row = parsed[idx] || {};
    const qtyValue = Object.prototype.hasOwnProperty.call(row, 'qty') ? text(row.qty) : baseRow.qty;
    const makeValue = Object.prototype.hasOwnProperty.call(row, 'make') ? text(row.make) : baseRow.make;
    return {
      sr_no: baseRow.sr_no,
      description: baseRow.description,
      unit: baseRow.unit,
      specification: baseRow.specification,
      qty: qtyValue,
      make: makeValue
    };
  });
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
    `SELECT COUNT(*) AS count
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'quotes' AND COLUMN_NAME = 'proposal_items_json'`,
    [dbName]
  );

  if (!rows[0].count) {
    await pool.query('ALTER TABLE quotes ADD COLUMN proposal_items_json LONGTEXT NULL');
  }
}

async function saveQuote({ body, quoteId }) {
  const items = parseItems(body.items_json || '[]');
  const proposalItems = parseProposalItems(body.proposal_items_json || '[]');
  const proposalItemsJson = JSON.stringify(proposalItems);
  const { subtotal, cgstTotal, sgstTotal, total } = buildQuoteSummary(items);

  const quoteDate = body.quote_date || new Date().toISOString().slice(0, 10);
  const customerName = String(body.customer_name || '').trim();

  if (!customerName) {
    throw new Error('Customer name is required.');
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    let finalQuoteId = Number(quoteId || 0);

    if (!finalQuoteId) {
      const [insertResult] = await connection.query(
        `INSERT INTO quotes
          (quote_no, quote_date, customer_name, customer_phone, customer_email, customer_address, customer_gstin, proposal_items_json, subtotal, cgst_total, sgst_total, total, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          null,
          quoteDate,
          customerName,
          body.customer_phone || null,
          body.customer_email || null,
          body.customer_address || null,
          body.customer_gstin || null,
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
             proposal_items_json = ?, subtotal = ?, cgst_total = ?, sgst_total = ?, total = ?, notes = ?
         WHERE id = ?`,
        [
          quoteDate,
          customerName,
          body.customer_phone || null,
          body.customer_email || null,
          body.customer_address || null,
          body.customer_gstin || null,
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
  drawTitleOnNewPage = true
}) {
  const totalWidth = columns.reduce((sum, col) => sum + col.width, 0);
  const pageBottom = doc.page.height - doc.page.margins.bottom;
  const titleHeight = title ? 24 : 0;
  const headerHeight = 24;

  let y = startY;

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

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const fileName = `${quote.quote_no || `quote-${id}`}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  doc.pipe(res);

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
    .text(`Quote No: ${quote.quote_no}`, { align: 'right' })
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
    rows: warrantyRows
  }) + 10;

  if (quote.notes) {
    if (sectionY > doc.page.height - 100) {
      doc.addPage();
      sectionY = doc.page.margins.top;
    }
    doc.font('Helvetica-Bold').fontSize(10).text('Additional Note:', 40, sectionY);
    doc.font('Helvetica').fontSize(10).text(quote.notes, 40, sectionY + 14, { width: 515 });
  }

  doc.end();
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
