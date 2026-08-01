let cart = [];

// 🔥 SCAN BARCODE → FETCH FROM API
async function scanBarcode(barcode) {
  console.log("\n🔍 Scanning:", barcode);

  try {
    const res = await fetch(`http://127.0.0.1:3000/api/barcode/${barcode}`);
    const data = await res.json();

    if (!data.success) {
      console.log("❌ Item not found");
      return;
    }

    addToCart(data.item);

  } catch (err) {
    console.log("🔥 ERROR:", err.message);
  }
}

// 🔥 ADD TO CART
function addToCart(item) {
  const existing = cart.find(
    i => i.barcode.toLowerCase() === item.barcode.toLowerCase()
  );

  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ ...item, qty: 1 });
  }

  console.log("🛒 Cart:", cart);
}

// 🔥 CREATE BILL → FETCH → PRINT → CLEAR CART
async function createBill() {
  if (cart.length === 0) {
    console.log("❌ Cart empty");
    return;
  }

  const payload = {
    customer_name: "Walk-in Customer",
    payment_mode: "cash",
    items: cart.map(i => ({
      barcode: i.barcode,
      qty: i.qty
    }))
  };

  try {
    const res = await fetch("http://127.0.0.1:3000/api/bills/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    console.log("🧾 BILL RESPONSE:", data);

    if (!data.success) {
      console.log("❌ Billing failed");
      return;
    }

    console.log("✅ BILL CREATED");

    // 🔥 FETCH BILL FOR PRINT
    const billRes = await fetch(
      `http://127.0.0.1:3000/api/bills/${data.bill_id}`
    );

    const billData = await billRes.json();

    printBill(billData);

    // 🔥 CLEAR CART
    cart = [];

  } catch (err) {
    console.log("🔥 BILL ERROR:", err.message);
  }
}

// 🔥 PRINT FUNCTION (CONSOLE VERSION)
function printBill(data) {
  console.log("\n======= PRINT BILL =======");
  console.log("Shop: Khurana's Since 1953");
  console.log("Bill No:", data.bill.bill_number);
  console.log("Customer:", data.bill.customer_name);
  console.log("--------------------------");

  data.items.forEach(item => {
    console.log(
      `${item.title} | ${item.size} | ${item.color} x${item.qty} = ₹${item.final_price}`
    );
  });

  console.log("--------------------------");
  console.log("TOTAL: ₹", data.bill.grand_total);
  console.log("======= END =======\n");
}

// 🔥 TEST FLOW
(async () => {
  await scanBarcode("JNS-32-BLU-001");
  await scanBarcode("JNS-32-BLU-001");

  // simulate ENTER
  await createBill();
})();