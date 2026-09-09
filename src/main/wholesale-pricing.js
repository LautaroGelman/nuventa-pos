// Product unit pricing. The retail amount is never overwritten in the catalog.
function wholesalePrice(product, quantity) {
  const retail = Number(product.price || 0);
  const price = Number(product.wholesale_price);
  const minimum = Number(product.wholesale_minimum_quantity);
  return product.wholesale_enabled && !product.weighable && price > 0 && price < retail
    && Number.isInteger(minimum) && minimum >= 2 && quantity >= minimum ? price : retail;
}
// The regular product endpoint has no signatures. Keep an existing proof only when its
// scope, revision and attested amount/threshold still match; otherwise request a v2 snapshot.
function retainCatalogProofs(db, downloaded, clientId, branchId) {
  const old = db.get('SELECT * FROM products WHERE id=? AND client_id=? AND sucursal_id=?', [downloaded.id, clientId, branchId]);
  const product = { ...downloaded, catalogRevision: downloaded.catalogRevision ?? old?.catalog_revision ?? 0 };
  if (old && Number(product.catalogRevision) === Number(old.catalog_revision)) {
    if (Number(product.price) === Number(old.price) && !!product.weighable === !!old.weighable)
      product.priceProof ||= old.price_proof;
    if (product.wholesaleEnabled && !product.weighable && old.wholesale_enabled && !old.weighable
        && Number(product.wholesalePrice) === Number(old.wholesale_price)
        && Number(product.wholesaleMinimumQuantity) === Number(old.wholesale_minimum_quantity))
      product.wholesalePriceProof ||= old.wholesale_price_proof;
  }
  if (product.wholesaleEnabled && !product.weighable && !product.wholesalePriceProof) {
    db.run('UPDATE sync_state SET cursor=NULL,snapshot_in_progress=0 WHERE client_id=? AND sucursal_id=?', [clientId, branchId]);
    db.run('DELETE FROM sync_snapshot_changes WHERE client_id=? AND sucursal_id=?', [clientId, branchId]);
  }
  return product;
}
module.exports = { wholesalePrice, retainCatalogProofs };
