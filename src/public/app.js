(() => {
  const products = Array.isArray(window.PRESET_PRODUCTS) ? window.PRESET_PRODUCTS : [];
  const initialItems = Array.isArray(window.INITIAL_QUOTE_ITEMS) ? window.INITIAL_QUOTE_ITEMS : [];
  const initialProposalItems = Array.isArray(window.INITIAL_PROPOSAL_ITEMS) ? window.INITIAL_PROPOSAL_ITEMS : [];

  const tableBody = document.querySelector('#items-table tbody');
  const addBtn = document.getElementById('add-item');
  const form = document.getElementById('quote-form');

  if (!tableBody || !addBtn || !form) {
    return;
  }

  const proposalBody = document.querySelector('#proposal-items-table tbody');
  const proposalItemsInput = document.getElementById('proposal-items-json');

  const dateInput = document.querySelector('input[name="quote_date"]');
  if (dateInput && !dateInput.value) {
    const today = new Date().toISOString().slice(0, 10);
    dateInput.value = today;
  }

  function createSelect() {
    const select = document.createElement('select');
    const customOption = document.createElement('option');
    customOption.value = '';
    customOption.textContent = 'Custom';
    select.appendChild(customOption);

    products.forEach((product) => {
      const option = document.createElement('option');
      option.value = String(product.id);
      option.textContent = product.name;
      option.dataset.price = product.price;
      option.dataset.gst = product.gst_rate;
      option.dataset.hsn = product.hsn || '';
      option.dataset.unit = product.unit || '';
      option.dataset.description = product.description || '';
      select.appendChild(option);
    });

    return select;
  }

  function format2(value) {
    return Number(value || 0).toFixed(2);
  }

  function calculateRow(row) {
    const qty = Number(row.querySelector('.qty').value || 0);
    const rate = Number(row.querySelector('.rate').value || 0);
    const gst = Number(row.querySelector('.gst').value || 0);

    const taxable = qty * rate;
    const half = gst / 2;
    const cgst = (taxable * half) / 100;
    const sgst = (taxable * half) / 100;
    const total = taxable + cgst + sgst;

    row.querySelector('.taxable').textContent = format2(taxable);
    row.querySelector('.cgst').textContent = format2(cgst);
    row.querySelector('.sgst').textContent = format2(sgst);
    row.querySelector('.total').textContent = format2(total);
  }

  function updateTotals() {
    let subtotal = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let grand = 0;

    tableBody.querySelectorAll('tr').forEach((row) => {
      subtotal += Number(row.querySelector('.taxable').textContent || 0);
      cgstTotal += Number(row.querySelector('.cgst').textContent || 0);
      sgstTotal += Number(row.querySelector('.sgst').textContent || 0);
      grand += Number(row.querySelector('.total').textContent || 0);
    });

    document.getElementById('subtotal').textContent = format2(subtotal);
    document.getElementById('cgst-total').textContent = format2(cgstTotal);
    document.getElementById('sgst-total').textContent = format2(sgstTotal);
    document.getElementById('grand-total').textContent = format2(grand);
  }

  function addRow(initial = {}) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="cell-select"></td>
      <td><input class="name" type="text" placeholder="Item name" /></td>
      <td><input class="hsn" type="text" placeholder="HSN" /></td>
      <td><input class="unit" type="text" placeholder="Unit" /></td>
      <td><input class="qty" type="number" step="0.01" value="1" /></td>
      <td><input class="rate" type="number" step="0.01" value="0" /></td>
      <td><input class="gst" type="number" step="0.01" value="0" /></td>
      <td class="taxable">0.00</td>
      <td class="cgst">0.00</td>
      <td class="sgst">0.00</td>
      <td class="total">0.00</td>
      <td><button type="button" class="remove btn-danger">Remove</button></td>
    `;

    const select = createSelect();
    row.querySelector('.cell-select').appendChild(select);

    select.addEventListener('change', () => {
      const option = select.selectedOptions[0];
      if (option && option.value) {
        row.querySelector('.name').value = option.textContent;
        row.querySelector('.hsn').value = option.dataset.hsn || '';
        row.querySelector('.unit').value = option.dataset.unit || '';
        row.querySelector('.rate').value = option.dataset.price || 0;
        row.querySelector('.gst').value = option.dataset.gst || 0;
      }
      calculateRow(row);
      updateTotals();
    });

    row.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        calculateRow(row);
        updateTotals();
      });
    });

    row.querySelector('.remove').addEventListener('click', () => {
      row.remove();
      updateTotals();
    });

    if (initial.product_id) {
      select.value = String(initial.product_id);
      const option = select.selectedOptions[0];
      if (option) {
        row.querySelector('.name').value = initial.name || option.textContent;
        row.querySelector('.hsn').value = initial.hsn || option.dataset.hsn || '';
        row.querySelector('.unit').value = initial.unit || option.dataset.unit || '';
        row.querySelector('.rate').value = initial.unit_price || option.dataset.price || 0;
        row.querySelector('.gst').value = initial.gst_rate || option.dataset.gst || 0;
      }
    } else {
      row.querySelector('.name').value = initial.name || '';
      row.querySelector('.hsn').value = initial.hsn || '';
      row.querySelector('.unit').value = initial.unit || '';
      row.querySelector('.rate').value = initial.unit_price || 0;
      row.querySelector('.gst').value = initial.gst_rate || 0;
    }

    row.querySelector('.qty').value = initial.qty || 1;

    calculateRow(row);
    updateTotals();

    tableBody.appendChild(row);
  }

  function renderProposalRows(rows) {
    if (!proposalBody) {
      return;
    }

    proposalBody.innerHTML = '';
    rows.forEach((item) => {
      const tr = document.createElement('tr');
      const srNoTd = document.createElement('td');
      srNoTd.textContent = item.sr_no || '';

      const descriptionTd = document.createElement('td');
      descriptionTd.textContent = item.description || '';

      const unitTd = document.createElement('td');
      unitTd.textContent = item.unit || '';

      const qtyTd = document.createElement('td');
      const qtyInput = document.createElement('input');
      qtyInput.type = 'text';
      qtyInput.className = 'proposal-qty';
      qtyInput.value = item.qty || '';
      qtyTd.appendChild(qtyInput);

      const specificationTd = document.createElement('td');
      specificationTd.textContent = item.specification || '';

      const makeTd = document.createElement('td');
      const makeInput = document.createElement('input');
      makeInput.type = 'text';
      makeInput.className = 'proposal-make';
      makeInput.value = item.make || '';
      makeTd.appendChild(makeInput);

      tr.appendChild(srNoTd);
      tr.appendChild(descriptionTd);
      tr.appendChild(unitTd);
      tr.appendChild(qtyTd);
      tr.appendChild(specificationTd);
      tr.appendChild(makeTd);

      tr.dataset.srNo = item.sr_no || '';
      tr.dataset.description = item.description || '';
      tr.dataset.unit = item.unit || '';
      tr.dataset.specification = item.specification || '';

      proposalBody.appendChild(tr);
    });
  }

  function collectProposalItems() {
    if (!proposalBody) {
      return [];
    }

    const rows = [];
    proposalBody.querySelectorAll('tr').forEach((tr) => {
      rows.push({
        sr_no: tr.dataset.srNo || '',
        description: tr.dataset.description || '',
        unit: tr.dataset.unit || '',
        specification: tr.dataset.specification || '',
        qty: tr.querySelector('.proposal-qty')?.value?.trim() || '',
        make: tr.querySelector('.proposal-make')?.value?.trim() || ''
      });
    });

    return rows;
  }

  addBtn.addEventListener('click', () => addRow());

  form.addEventListener('submit', (event) => {
    const items = [];
    tableBody.querySelectorAll('tr').forEach((row) => {
      const select = row.querySelector('select');
      const productId = select && select.value ? Number(select.value) : null;
      const name = row.querySelector('.name').value.trim();
      if (!name) {
        return;
      }
      items.push({
        product_id: productId,
        name,
        description: null,
        hsn: row.querySelector('.hsn').value.trim() || null,
        unit: row.querySelector('.unit').value.trim() || null,
        qty: Number(row.querySelector('.qty').value || 0),
        unit_price: Number(row.querySelector('.rate').value || 0),
        gst_rate: Number(row.querySelector('.gst').value || 0)
      });
    });

    if (!items.length) {
      event.preventDefault();
      alert('Please add at least one item.');
      return;
    }

    document.getElementById('items-json').value = JSON.stringify(items);

    if (proposalItemsInput) {
      proposalItemsInput.value = JSON.stringify(collectProposalItems());
    }
  });

  if (initialItems.length) {
    initialItems.forEach((item) => addRow(item));
  } else {
    addRow();
  }

  if (initialProposalItems.length) {
    renderProposalRows(initialProposalItems);
  }
})();
