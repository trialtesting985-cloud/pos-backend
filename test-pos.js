let cart = [];

function addToCart(item) {
  console.log("Incoming:", item.barcode); // Debug

  const existing = cart.find(
    i => i.barcode.toLowerCase() === item.barcode.toLowerCase()
  );

  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ ...item, qty: 1 });
  }

  console.log("Cart:", cart);
}

// TEST (same barcode twice)
addToCart({ barcode: "JNS-32-BLU-001", title: "Jeans", mrp: 2000 });
addToCart({ barcode: "JNS-32-BLU-001", title: "Jeans", mrp: 2000 });