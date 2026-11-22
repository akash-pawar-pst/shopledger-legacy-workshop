const assert = require('node:assert/strict');
const { test } = require('node:test');

const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function orderFromCheckout(items, coupon = '') {
  const { subtotal, discount, tax, total } = pricing.computeTotals(items, coupon);
  return orders.add({ orders: [], nextOrderId: 1 }, {
    date: '22/11/2026',
    items,
    coupon,
    subtotal,
    discount,
    tax,
    total,
  });
}

test('printed invoice matches the amount billed and the discounted GST by HSN', () => {
  const order = orderFromCheckout([
    { id: 1, name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 1000, qty: 1 },
  ], 'SAVE10');

  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹2007\.25<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹157\.25<\/td>/);
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹46\.25<\/td>/);
  assert.match(html, /<td class="r">12%<\/td><td class="r">₹111\.00<\/td>/);
  assert.match(html, /<th class="r">Taxable Value<\/th>/);
  assert.equal([...html.matchAll(/<td class="r">₹925\.00<\/td>/g)].length, 2);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('checkout caps SAVE10 and applies each HSN slab after apportioning the discount', () => {
  const totals = pricing.computeTotals([
    { id: 1, name: 'Rice', hsn: '1006', price: 500, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 1000, qty: 1 },
  ], 'SAVE10');

  const { lines, ...summary } = totals;
  assert.deepEqual(summary, {
    subtotal: 2000, discount: 150, taxable: 1850, tax: 157.25,
    cgst: 78.63, sgst: 78.62, total: 2007.25,
  });
  assert.deepEqual(lines.map(({ gstPercent, gross, discount, taxable, tax }) => (
    { gstPercent, gross, discount, taxable, tax }
  )), [
    { gstPercent: 5, gross: 1000, discount: 75, taxable: 925, tax: 46.25 },
    { gstPercent: 12, gross: 1000, discount: 75, taxable: 925, tax: 111 },
  ]);
});

test('invoice resolves GST from HSN-only order lines', () => {
  const order = orderFromCheckout([
    { id: 1, name: 'Rice', hsn: '1006', price: 100, qty: 1 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 100, qty: 1 },
  ]);
  assert.equal(order.tax, 17);
  assert.equal(order.total, 217);

  const { rows, ...summary } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(summary, {
    subtotal: 200, discount: 0, tax: 17, cgst: 8.5, sgst: 8.5, total: 217,
  });
  assert.deepEqual(rows.map(({ hsn, gstPercent, lineTax }) => ({ hsn, gstPercent, lineTax })), [
    { hsn: '1006', gstPercent: 5, lineTax: 5 },
    { hsn: '0405', gstPercent: 12, lineTax: 12 },
  ]);
});

test('invoice applies the SAVE10 cap before GST with an explicit rate', () => {
  const order = orderFromCheckout([
    { id: 1, name: 'Rice', hsn: '1006', gstRate: 5, price: 2000, qty: 1 },
  ], 'SAVE10');
  assert.equal(order.discount, 150);
  assert.equal(order.tax, 92.5);
  assert.equal(order.total, 1942.5);

  const { rows, ...summary } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(summary, {
    subtotal: 2000, discount: 150, tax: 92.5, cgst: 46.25, sgst: 46.25, total: 1942.5,
  });
  assert.equal(rows[0].gstPercent, 5);
  assert.equal(rows[0].lineTax, 92.5);
});

test('invoice applies the checkout minimum when an older order lacks a saved discount', () => {
  const checkoutOrder = orderFromCheckout([
    { id: 1, name: 'Rice', gstRate: 5, price: 100, qty: 1 },
  ]);
  assert.equal(pricing.discount(checkoutOrder.subtotal, 'FLAT50'), 0);

  const figures = invoice.computeInvoiceFigures({ ...checkoutOrder, coupon: 'FLAT50', discount: undefined });
  assert.equal(figures.discount, 0);
  assert.equal(figures.total, 105);
});

test('invoice preserves the saved discount and GST when a coupon has expired', () => {
  const order = {
    id: 1,
    items: [{ id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 1 }],
    coupon: 'DIWALI20',
    subtotal: 1000,
    discount: 200,
    tax: 40,
    total: 840,
  };

  const figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.discount, 200);
  assert.equal(figures.rows[0].taxable, 800);
  assert.equal(figures.rows[0].lineTax, 40);
  assert.equal(figures.total, 840);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).mismatchCount, 0);
});

test('invoice interprets decimal and zero GST overrides like checkout', () => {
  const items = [
    { id: 1, name: 'Rice', gstRate: 0.05, price: 100, qty: 1 },
    { id: 2, name: 'Sample', gstRate: 0, price: 100, qty: 1 },
  ];
  const checkout = pricing.computeTotals(items);
  const printed = invoice.computeInvoiceFigures({ items });

  assert.deepEqual(checkout.lines.map(line => line.tax), [5, 0]);
  assert.deepEqual(printed.rows.map(row => row.lineTax), [5, 0]);
  assert.deepEqual(printed.rows.map(row => row.gstPercent), [5, 0]);
});

test('invoice GST total sums the rounded line taxes like checkout', () => {
  const order = orderFromCheckout([
    { id: 1, name: 'Rice A', gstRate: 5, price: 0.1, qty: 1 },
    { id: 2, name: 'Rice B', gstRate: 5, price: 0.1, qty: 1 },
  ]);
  assert.equal(order.tax, 0.02);
  assert.equal(order.total, 0.22);

  const figures = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures.rows.map(row => row.lineTax), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.equal(figures.cgst, 0.01);
  assert.equal(figures.sgst, 0.01);
  assert.equal(figures.total, 0.22);
});

test('CURRENT BEHAVIOUR: a tax-only difference flags reconciliation but adds no total delta or invoice notice', () => {
  const matching = orderFromCheckout([
    { id: 1, name: 'Rice', gstRate: 5, price: 100, qty: 1 },
  ]);
  const taxMismatch = { ...matching, id: 2, tax: 4.99 };
  const lowerLedgerTotal = { ...matching, id: 3, total: 104 };
  const higherLedgerTotal = { ...matching, id: 4, total: 107 };
  const cancelled = { ...matching, id: 5, total: 1, status: 'cancelled' };
  const { rows, ...summary } = reports.getGstReconciliation({
    orders: [matching, taxMismatch, lowerLedgerTotal, higherLedgerTotal, cancelled],
  });

  assert.deepEqual(summary, { totalChecked: 4, mismatchCount: 3, totalDelta: 3 });
  assert.deepEqual(rows.map(({ orderId, ledgerTax, invoiceTax, delta, matched }) => (
    { orderId, ledgerTax, invoiceTax, delta, matched }
  )), [
    { orderId: 1, ledgerTax: 5, invoiceTax: 5, delta: 0, matched: true },
    { orderId: 2, ledgerTax: 4.99, invoiceTax: 5, delta: 0, matched: false },
    { orderId: 3, ledgerTax: 5, invoiceTax: 5, delta: 1, matched: false },
    { orderId: 4, ledgerTax: 5, invoiceTax: 5, delta: -2, matched: false },
  ]);
  assert.doesNotMatch(invoice.render(taxMismatch), /Accountant Reconciliation Notice/);
  assert.match(invoice.render(higherLedgerTotal), /differs from Order Ledger recorded total \(₹107\.00\) by -₹2\.00/);
});
