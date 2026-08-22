def available_stock(stock: dict[str, int], reserved: dict[str, int]) -> dict[str, int]:
    """Return available quantities for every SKU in stock."""
    return {sku: count - reserved.get(sku, 0) for sku, count in stock.items()}
