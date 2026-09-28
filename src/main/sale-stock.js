// Historical inventory warnings, shared by initial and idempotent sale responses.
'use strict';
function warnings(items) {
  const grouped = new Map();
  for (const item of items) {
    if (item.stock_before == null || item.product_id == null) continue;
    const previous = grouped.get(item.product_id), before = previous ? Math.max(previous.stockBefore,item.stock_before) : item.stock_before;
    const sold = (previous?.quantitySold || 0) + item.quantity;
    grouped.set(item.product_id, { productId:item.product_id,productName:item.product_name,stockBefore:before,quantitySold:sold,stockAfter:before-sold });
  }
  return [...grouped.values()].filter(p => p.stockAfter < 0);
}
module.exports = { warnings };
