'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { warnings } = require('../src/main/sale-stock');
test('agrupa faltantes históricos y excluye líneas sin control de stock', () => {
  const items=[{product_id:1,product_name:'A',stock_before:1,quantity:1},{product_id:1,product_name:'A',stock_before:0,quantity:2},
    {product_id:2,product_name:'B',stock_before:null,quantity:100},{product_id:3,product_name:'C',stock_before:5,quantity:2}];
  assert.deepEqual(warnings(items),[{productId:1,productName:'A',stockBefore:1,quantitySold:3,stockAfter:-2}]);
});
