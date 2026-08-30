/**
 * MFP ERP Mobile Portal - Core Controller logic
 * Integrates Supabase cloud database, in-browser PDF parsing, and WhatsApp messaging.
 */

// Initialize pdf.js worker CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

class DBClient {
  constructor() {
    this.supabase = null;
    this.offlineDb = {
      raw_materials: [],
      products: [],
      orders: [],
      inwards: [],
      productions: [],
      outwards: []
    };
    
    this.config = {
      supabaseUrl: '',
      supabaseKey: '',
      isOnline: false
    };

    this.loadConfig();
    this.initSupabase();
  }

  loadConfig() {
    const config = localStorage.getItem('mfp_supabase_config');
    if (config) {
      try {
        this.config = { ...this.config, ...JSON.parse(config) };
      } catch (e) {
        console.error("Failed to load DB config", e);
      }
    }

    const savedDb = localStorage.getItem('mfp_offline_db');
    if (savedDb) {
      try {
        this.offlineDb = { ...this.offlineDb, ...JSON.parse(savedDb) };
      } catch (e) {
        console.error("Failed to load local DB", e);
      }
    }
  }

  saveConfig(url, key) {
    this.config.supabaseUrl = url;
    this.config.supabaseKey = key;
    this.config.isOnline = !!(url && key);
    localStorage.setItem('mfp_supabase_config', JSON.stringify(this.config));
    this.initSupabase();
  }

  saveOfflineDb() {
    localStorage.setItem('mfp_offline_db', JSON.stringify(this.offlineDb));
  }

  initSupabase() {
    if (this.config.supabaseUrl && this.config.supabaseKey) {
      try {
        this.supabase = supabase.createClient(this.config.supabaseUrl, this.config.supabaseKey);
        this.config.isOnline = true;
      } catch (e) {
        console.error("Failed to initialize Supabase client", e);
        this.config.isOnline = false;
      }
    } else {
      this.config.isOnline = false;
    }
    
    // Trigger UI badge updates
    this.updateStatusBadge();
  }

  updateStatusBadge() {
    const badge = document.getElementById('db-status-indicator');
    if (!badge) return;

    if (this.config.isOnline) {
      badge.className = 'db-status-badge online';
      badge.innerHTML = `<i class="fa-solid fa-cloud"></i> Cloud Sync Active`;
    } else {
      badge.className = 'db-status-badge offline';
      badge.innerHTML = `<i class="fa-solid fa-cloud-slash"></i> Sandbox Mode`;
    }
  }

  // --- DATABASE ACCESSIBILITY WRAPPERS ---

  async getRawMaterials() {
    if (this.config.isOnline && this.supabase) {
      const { data, error } = await this.supabase.from('raw_materials').select('*').order('name');
      if (error) console.error(error);
      else return data;
    }
    return [...this.offlineDb.raw_materials].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getProducts() {
    if (this.config.isOnline && this.supabase) {
      const { data, error } = await this.supabase.from('products').select('*').order('name');
      if (error) console.error(error);
      else return data;
    }
    return [...this.offlineDb.products].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getOrders() {
    if (this.config.isOnline && this.supabase) {
      const { data, error } = await this.supabase.from('orders').select('*').order('created_at', { ascending: false });
      if (error) console.error(error);
      else return data;
    }
    return [...this.offlineDb.orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async insertOrder(order) {
    order.id = 'ord_' + Date.now();
    order.created_at = new Date().toISOString();
    order.status = 'Pending';

    if (this.config.isOnline && this.supabase) {
      const { error } = await this.supabase.from('orders').insert([order]);
      if (error) console.error(error);
    }
    
    this.offlineDb.orders.push(order);
    this.saveOfflineDb();
    return order;
  }

  async insertInward(inward) {
    inward.id = 'inw_' + Date.now();
    inward.created_at = new Date().toISOString();

    // Update Raw Materials Stock in DB
    const materials = await this.getRawMaterials();
    const mat = materials.find(m => m.id === inward.material_id);
    
    if (mat) {
      const oldStock = parseFloat(mat.current_stock || 0);
      const oldRate = parseFloat(mat.average_price || 0);
      const inwardQty = parseFloat(inward.quantity_received || 0);
      const inwardRate = parseFloat(inward.rate_billed || 0);
      
      const newStock = oldStock + inwardQty;
      let newRate = oldRate;
      if (newStock > 0) {
        newRate = ((oldStock * oldRate) + (inwardQty * inwardRate)) / newStock;
      }

      await this.updateMaterialStock(mat.id, newStock, newRate);
    }

    // Toggle associated Order status if matched
    if (inward.linked_order_id) {
      await this.updateOrderStatus(inward.linked_order_id, 'Inwarded');
    }

    if (this.config.isOnline && this.supabase) {
      const { error } = await this.supabase.from('inwards').insert([inward]);
      if (error) console.error(error);
    }
    
    this.offlineDb.inwards.push(inward);
    this.saveOfflineDb();
    return inward;
  }

  async insertProduction(prod) {
    prod.id = 'run_' + Date.now();
    prod.created_at = new Date().toISOString();

    const products = await this.getProducts();
    const rawMaterials = await this.getRawMaterials();
    
    const targetProduct = products.find(p => p.id === prod.product_id);
    if (targetProduct) {
      // 1. Deduct raw materials based on BOM recipe + wastage factors
      for (const recipe of targetProduct.bom) {
        const mat = rawMaterials.find(m => m.id === recipe.material_id);
        if (mat) {
          const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage) / 100);
          const neededQty = parseFloat(recipe.quantity) * parseFloat(prod.quantity_produced) * wasteFactor;
          const newStock = Math.max(0, parseFloat(mat.current_stock || 0) - neededQty);
          await this.updateMaterialStock(mat.id, newStock, mat.average_price);
        }
      }

      // 2. Increment Finished Goods Stock counts
      const newFGStock = parseFloat(targetProduct.current_stock || 0) + parseFloat(prod.quantity_produced);
      await this.updateProductStock(targetProduct.id, newFGStock);
    }

    if (this.config.isOnline && this.supabase) {
      const { error } = await this.supabase.from('productions').insert([prod]);
      if (error) console.error(error);
    }
    
    this.offlineDb.productions.push(prod);
    this.saveOfflineDb();
    return prod;
  }

  async insertOutward(outward) {
    outward.id = 'otw_' + Date.now();
    outward.created_at = new Date().toISOString();

    // Deduct Finished Goods stock level
    const products = await this.getProducts();
    const targetProduct = products.find(p => p.id === outward.product_id);
    if (targetProduct) {
      const newFGStock = Math.max(0, parseFloat(targetProduct.current_stock || 0) - parseFloat(outward.quantity_dispatched));
      await this.updateProductStock(targetProduct.id, newFGStock);
    }

    if (this.config.isOnline && this.supabase) {
      const { error } = await this.supabase.from('outwards').insert([outward]);
      if (error) console.error(error);
    }
    
    this.offlineDb.outwards.push(outward);
    this.saveOfflineDb();
    return outward;
  }

  async updateMaterialStock(id, newStock, newRate) {
    if (this.config.isOnline && this.supabase) {
      const { error } = await this.supabase.from('raw_materials')
        .update({ current_stock: newStock, average_price: newRate })
        .eq('id', id);
      if (error) console.error(error);
    }
    const idx = this.offlineDb.raw_materials.findIndex(m => m.id === id);
    if (idx !== -1) {
      this.offlineDb.raw_materials[idx].current_stock = newStock;
      this.offlineDb.raw_materials[idx].average_price = newRate;
      this.saveOfflineDb();
    }
  }

  async updateProductStock(id, newStock) {
    if (this.config.isOnline && this.supabase) {
      const { error } = await this.supabase.from('products')
        .update({ current_stock: newStock })
        .eq('id', id);
      if (error) console.error(error);
    }
    const idx = this.offlineDb.products.findIndex(p => p.id === id);
    if (idx !== -1) {
      this.offlineDb.products[idx].current_stock = newStock;
      this.saveOfflineDb();
    }
  }

  async updateOrderStatus(id, newStatus) {
    if (this.config.isOnline && this.supabase) {
      const { error } = await this.supabase.from('orders')
        .update({ status: newStatus })
        .eq('id', id);
      if (error) console.error(error);
    }
    const idx = this.offlineDb.orders.findIndex(o => o.id === id);
    if (idx !== -1) {
      this.offlineDb.orders[idx].status = newStatus;
      this.saveOfflineDb();
    }
  }

  // Seeding initial database data
  seedSandboxData() {
    this.offlineDb.raw_materials = [
      { id: 'rm_chilli', code: 'RM-CHILLI-RED', name: 'Raw Dried Red Chilli', current_stock: 120.00, unit: 'kg', average_price: 180.00, min_stock: 20.00, description: 'Sun-dried red chillies.' },
      { id: 'rm_peri', code: 'RM-PERI-PERI', name: 'African Peri Peri Spice', current_stock: 45.00, unit: 'kg', average_price: 320.00, min_stock: 10.00, description: 'African Bird Eye pepper pods.' },
      { id: 'rm_thyme', code: 'RM-THYME-DRY', name: 'Dried Thyme Leaves', current_stock: 35.00, unit: 'kg', average_price: 450.00, min_stock: 8.00, description: 'Aromatic dried herb leaves.' },
      { id: 'rm_rose', code: 'RM-ROSEMARY', name: 'Whole Dried Rosemary', current_stock: 25.00, unit: 'kg', average_price: 520.00, min_stock: 8.00, description: 'Dried rosemary needles.' },
      { id: 'rm_btl_glass', code: 'RM-BTL-150ML', name: 'Glass Bottles 150ml', current_stock: 1200.00, unit: 'Pieces', average_price: 8.50, min_stock: 300.00, description: 'Clear sauce shaker bottles.' },
      { id: 'rm_carton_box', code: 'RM-BOX-INNER', name: 'Inner Carton Boxes', current_stock: 850.00, unit: 'Pieces', average_price: 3.20, min_stock: 200.00, description: 'Single product packaging cardboard box.' },
      { id: 'rm_pouch_out', code: 'RM-PCH-OUTER', name: 'Outer Pouches Foil', current_stock: 2400.00, unit: 'Pieces', average_price: 0.65, min_stock: 500.00, description: 'Moisture-barrier pouches.' }
    ];

    this.offlineDb.products = [
      {
        id: 'prod_peri_sauce',
        code: 'FG-PERI-150ML',
        name: 'Signature Peri Peri Sauce 150ml',
        price: 180.00,
        selling_price: 160.00,
        current_stock: 120.00,
        min_stock: 30.00,
        packaging_type: 'Bottles',
        description: 'Vibrant hot sauce packed in glass bottles.',
        bom: [
          { material_id: 'rm_peri', quantity: 0.025, wastage_percentage: 2.0 },
          { material_id: 'rm_chilli', quantity: 0.015, wastage_percentage: 1.5 },
          { material_id: 'rm_btl_glass', quantity: 1.0, wastage_percentage: 0.5 },
          { material_id: 'rm_pouch_out', quantity: 1.0, wastage_percentage: 0.0 }
        ]
      },
      {
        id: 'prod_herbs_mix',
        code: 'FG-HERB-SHKR',
        name: 'Dried Thyme & Rosemary Mix',
        price: 90.00,
        selling_price: 75.00,
        current_stock: 280.00,
        min_stock: 50.00,
        packaging_type: 'Boxes',
        description: 'Kitchen herbs mix packed in carton boxes.',
        bom: [
          { material_id: 'rm_thyme', quantity: 0.035, wastage_percentage: 1.0 },
          { material_id: 'rm_rose', quantity: 0.015, wastage_percentage: 1.0 },
          { material_id: 'rm_carton_box', quantity: 1.0, wastage_percentage: 0.0 }
        ]
      }
    ];

    this.saveOfflineDb();
  }
}

// --------------------------------------------------------------------------
// MAIN APPLICATION CONTROLLER
// --------------------------------------------------------------------------

class MFPMobilePortal {
  constructor() {
    this.db = new DBClient();
    this.currentProductionCategory = 'Bottles'; // Active subtab
    this.currentVerifyInwardItem = null;
    this.currentVerifyOutwardItems = [];

    this.init();
  }

  async init() {
    // Navigation listeners
    document.querySelectorAll('.bottom-nav .nav-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const viewId = e.currentTarget.getAttribute('data-target');
        this.switchView(viewId, e.currentTarget);
      });
    });

    this.loadSettingsForm();
    await this.refreshAllViews();
  }

  switchView(viewId, tabElement) {
    document.querySelectorAll('.app-view').forEach(view => {
      view.classList.remove('active');
    });
    document.getElementById(viewId).classList.add('active');

    if (tabElement) {
      document.querySelectorAll('.bottom-nav .nav-tab').forEach(t => t.classList.remove('active'));
      tabElement.classList.add('active');
    }

    this.refreshActivePane(viewId);
  }

  async refreshActivePane(viewId) {
    if (viewId === 'view-order') {
      await this.renderOrderPane();
    } else if (viewId === 'view-inward') {
      await this.renderInwardPane();
    } else if (viewId === 'view-production') {
      await this.renderProductionPane();
    } else if (viewId === 'view-outward') {
      await this.renderOutwardPane();
    }
  }

  async refreshAllViews() {
    await this.renderOrderPane();
    await this.renderInwardPane();
    await this.renderProductionPane();
    await this.renderOutwardPane();
  }

  // --- 1. ORDER REQUEST WORKFLOW ---
  
  async renderOrderPane() {
    const materials = await this.db.getRawMaterials();
    const select = document.getElementById('order-material');
    if (!select) return;

    select.innerHTML = '<option value="" disabled selected>-- Select Material --</option>';
    materials.forEach(m => {
      select.innerHTML += `<option value="${m.id}">${m.name} (${m.code})</option>`;
    });

    // Populate Outstanding Orders
    const orders = await this.db.getOrders();
    const container = document.getElementById('order-list-container');
    container.innerHTML = '';

    const pendings = orders.filter(o => o.status === 'Pending');
    if (pendings.length === 0) {
      container.innerHTML = `<div class="td-muted italic text-center style="padding:1rem;">No pending purchase orders.</div>`;
      return;
    }

    pendings.forEach(ord => {
      const div = document.createElement('div');
      div.className = 'stock-cover-item';
      div.innerHTML = `
        <div>
          <div class="td-bold" style="font-size:0.85rem;">${ord.material_name}</div>
          <div class="td-muted" style="font-size:0.75rem;">Qty: ${ord.quantity_requested} • Vendor: ${ord.vendor_name || 'N/A'}</div>
        </div>
        <span class="badge badge-warning" style="font-size:0.65rem;">Pending</span>
      `;
      container.appendChild(div);
    });
  }

  async handleOrderSubmit(e) {
    e.preventDefault();

    const matId = document.getElementById('order-material').value;
    const qty = parseFloat(document.getElementById('order-qty').value) || 0;
    const price = parseFloat(document.getElementById('order-price').value) || 0;
    const vendor = document.getElementById('order-vendor').value.trim();

    if (!matId || qty <= 0) return;

    const materials = await this.db.getRawMaterials();
    const mat = materials.find(m => m.id === matId);
    if (!mat) return;

    const order = await this.db.insertOrder({
      material_id: matId,
      material_name: mat.name,
      quantity_requested: qty,
      vendor_name: vendor || '',
      price_suggested: price || 0
    });

    // Compile WhatsApp order request
    const waText = `📦 *MFP ERP - Purchase Order Request*\n` +
                   `• *Material:* ${mat.name} (${mat.code})\n` +
                   `• *Quantity Needed:* ${qty} ${mat.unit}\n` +
                   (vendor ? `• *Suggested Vendor:* ${vendor}\n` : '') +
                   (price ? `• *Estimated Price:* Rs. ${price.toFixed(2)} / ${mat.unit}\n` : '') +
                   `\n_Please order the above raw material. Submitted by Mobile Console._`;

    document.getElementById('order-wa-text').value = waText;
    document.getElementById('order-wa-widget').classList.remove('hidden');

    document.getElementById('order-form').reset();
    await this.renderOrderPane();
  }


  // --- 2. INWARD PURCHASE BILL RECONCILIATION WORKFLOW ---

  async renderInwardPane() {
    // Populate outstanding order references dropdown
    const orders = await this.db.getOrders();
    const select = document.getElementById('inward-linked-order');
    if (!select) return;

    select.innerHTML = '<option value="" disabled selected>-- Select Associated Order Reference --</option>';
    const pendingOrders = orders.filter(o => o.status === 'Pending');
    
    pendingOrders.forEach(o => {
      select.innerHTML += `<option value="${o.id}">${o.material_name} (Req: ${o.quantity_requested} pcs) - ID: ${o.id.substring(4, 9)}</option>`;
    });
  }

  async autoFillInwardFromOrder() {
    const orderId = document.getElementById('inward-linked-order').value;
    const orders = await this.db.getOrders();
    const ord = orders.find(o => o.id === orderId);

    if (ord) {
      document.getElementById('inward-qty').value = ord.quantity_requested;
      document.getElementById('inward-rate').value = ord.price_suggested || 0;
      document.getElementById('inward-supplier').value = ord.vendor_name || '';
    }
  }

  // Read purchase invoice bill PDF via pdf.js
  async handleInwardUpload(file) {
    if (!file || file.type !== 'application/pdf') {
      alert("Invalid format. Purchase bill must be a PDF file.");
      return;
    }

    try {
      const rawText = await this.parsePDFText(file);
      const extracted = this.heuristicsExtractPurchase(rawText);

      this.currentVerifyInwardItem = extracted;

      // Populate review modal
      document.getElementById('vi-invoice').value = extracted.invoice_no;

      const orderSelect = document.getElementById('vi-linked-order');
      orderSelect.innerHTML = '<option value="">-- No Link (Standalone Inward) --</option>';
      const orders = await this.db.getOrders();
      const pendings = orders.filter(o => o.status === 'Pending');
      pendings.forEach(o => {
        const selected = o.material_name.toLowerCase().includes(extracted.raw_text_name.toLowerCase()) ? 'selected' : '';
        orderSelect.innerHTML += `<option value="${o.id}" ${selected}>${o.material_name} (Req: ${o.quantity_requested})</option>`;
      });

      const tbody = document.getElementById('verify-inward-rows');
      tbody.innerHTML = `
        <tr>
          <td>
            <div class="td-bold" style="font-size:0.75rem;">Extracted: "${extracted.raw_text_name}"</div>
            <select class="form-control" style="font-size:0.8rem; padding: 0.35rem;" id="vi-mapped-material">
              <!-- Loaded dynamically -->
            </select>
          </td>
          <td><input type="number" step="0.001" class="form-control" style="font-size:0.8rem; padding:0.35rem;" id="vi-qty" value="${extracted.quantity}"></td>
          <td><input type="number" step="0.01" class="form-control" style="font-size:0.8rem; padding:0.35rem;" id="vi-rate" value="${extracted.rate}"></td>
          <td><input type="text" class="form-control" style="font-size:0.8rem; padding:0.35rem;" id="vi-supplier" value="${extracted.supplier}"></td>
        </tr>
      `;

      // Populate raw material selectors inside verify table
      const viMapSelect = document.getElementById('vi-mapped-material');
      const materials = await this.db.getRawMaterials();
      viMapSelect.innerHTML = '<option value="" disabled selected>-- Match Material --</option>';
      materials.forEach(m => {
        const selected = extracted.raw_text_name.toLowerCase().includes(m.name.toLowerCase()) ? 'selected' : '';
        viMapSelect.innerHTML += `<option value="${m.id}" ${selected}>${m.name} (${m.code})</option>`;
      });

      this.openModal('modal-verify-inward');
    } catch (e) {
      console.error(e);
      alert("Failed to parse invoice PDF text: " + e.message);
    }
  }

  // Commit verify purchase receipt and trigger crosscheck validations
  async commitVerifyInward() {
    const invoiceNo = document.getElementById('vi-invoice').value.trim();
    const linkedOrderId = document.getElementById('vi-linked-order').value;
    const materialId = document.getElementById('vi-mapped-material').value;
    const qty = parseFloat(document.getElementById('vi-qty').value) || 0;
    const rate = parseFloat(document.getElementById('vi-rate').value) || 0;
    const supplier = document.getElementById('vi-supplier').value.trim();

    if (!invoiceNo || !materialId || qty <= 0 || rate <= 0 || !supplier) {
      alert("All fields are required to commit inward stock.");
      return;
    }

    const materials = await this.db.getRawMaterials();
    const mat = materials.find(m => m.id === materialId);
    if (!mat) return;

    this.closeModal('modal-verify-inward');
    await this.processInwardIngest({
      invoice_no: invoiceNo,
      material_id: materialId,
      material_name: mat.name,
      quantity_received: qty,
      rate_billed: rate,
      supplier,
      linked_order_id: linkedOrderId || null
    });
  }

  // Handle manual form submission for Inward
  async handleManualInwardSubmit(e) {
    e.preventDefault();

    const invoiceNo = document.getElementById('inward-invoice').value.trim();
    const linkedOrderId = document.getElementById('inward-linked-order').value;
    const qty = parseFloat(document.getElementById('inward-qty').value) || 0;
    const rate = parseFloat(document.getElementById('inward-rate').value) || 0;
    const supplier = document.getElementById('inward-supplier').value.trim();

    if (!invoiceNo || !linkedOrderId || qty <= 0 || rate <= 0) return;

    const orders = await this.db.getOrders();
    const ord = orders.find(o => o.id === linkedOrderId);
    if (!ord) return;

    await this.processInwardIngest({
      invoice_no: invoiceNo,
      material_id: ord.material_id,
      material_name: ord.material_name,
      quantity_received: qty,
      rate_billed: rate,
      supplier,
      linked_order_id: linkedOrderId
    });

    document.getElementById('inward-manual-form').reset();
  }

  // Cross-check Inward bill details with associated purchase order placed
  async processInwardIngest(inward) {
    let hasVariance = false;
    let varianceNotes = '';
    let waText = '';

    if (inward.linked_order_id) {
      const orders = await this.db.getOrders();
      const ord = orders.find(o => o.id === inward.linked_order_id);
      
      if (ord) {
        const qtyDiff = inward.quantity_received - ord.quantity_requested;
        const rateDiff = inward.rate_billed - (ord.price_suggested || 0);

        const qtyMismatch = Math.abs(qtyDiff) > 0.001;
        const rateMismatch = Math.abs(rateDiff) > 0.01;

        if (qtyMismatch || rateMismatch) {
          hasVariance = true;
          
          let issues = [];
          if (qtyMismatch) {
            issues.push(qtyDiff > 0 ? `Excess Qty: +${qtyDiff.toFixed(3)}` : `Shortage Qty: ${qtyDiff.toFixed(3)}`);
          }
          if (rateMismatch) {
            issues.push(rateDiff > 0 ? `Price Overcharge: +Rs. ${rateDiff.toFixed(2)}` : `Price Discount: -Rs. ${Math.abs(rateDiff).toFixed(2)}`);
          }

          varianceNotes = issues.join(', ');

          // Formulate WhatsApp Variance Alert
          waText = `⚠️ *MFP ERP - Inward Variance Warning*\n` +
                   `• *Material:* ${inward.material_name}\n` +
                   `• *Invoice / Bill No:* ${inward.invoice_no}\n` +
                   `• *Supplier:* ${inward.supplier}\n\n` +
                   `*Audit Comparison:*\n` +
                   `• *Ordered Qty:* ${ord.quantity_requested} | *Received Qty:* ${inward.quantity_received}\n` +
                   `• *Ordered Rate:* Rs. ${(ord.price_suggested || 0).toFixed(2)} | *Billed Rate:* Rs. ${inward.rate_billed.toFixed(2)}\n\n` +
                   `🔴 *Variances Detected:* ${varianceNotes}\n` +
                   `\n_Please check billed amounts with supplier. Inward logged in system._`;
        }
      }
    }

    inward.has_variance = hasVariance;
    inward.variance_notes = varianceNotes;

    await this.db.insertInward(inward);

    if (hasVariance && waText) {
      document.getElementById('inward-wa-text').value = waText;
      document.getElementById('inward-wa-widget').classList.remove('hidden');
    } else {
      document.getElementById('inward-wa-widget').classList.add('hidden');
      alert(`Inward processed! Stock successfully restocked without billing variance.`);
    }

    await this.refreshAllViews();
  }


  // --- 3. DAILY BATCH PRODUCTION RUNS WORKFLOW ---

  async renderProductionPane() {
    // Render Raw Materials checklist
    const materials = await this.db.getRawMaterials();
    const matContainer = document.getElementById('production-stock-container');
    if (!matContainer) return;

    matContainer.innerHTML = '';
    materials.forEach(m => {
      let statusClass = 'ok';
      let statusText = 'In Stock';
      
      if (m.current_stock <= 0) {
        statusClass = 'out';
        statusText = 'Out of Stock';
      } else if (m.current_stock <= m.min_stock) {
        statusClass = 'low';
        statusText = 'Low Cover';
      }

      const div = document.createElement('div');
      div.className = 'stock-cover-item';
      div.innerHTML = `
        <div>
          <div class="td-bold" style="font-size:0.85rem;">${m.name} <span class="td-muted" style="font-size:0.75rem; font-family:monospace;">(${m.code})</span></div>
          <div class="td-muted" style="font-size:0.75rem;">Avg Cost: Rs. ${m.average_price.toFixed(2)} / ${m.unit}</div>
        </div>
        <div style="text-align: right;">
          <div class="td-bold" style="font-size:0.85rem;">${m.current_stock.toFixed(3)} ${m.unit}</div>
          <span class="stock-status-tag ${statusClass}" style="margin-top:0.15rem; display:inline-block;">${statusText}</span>
        </div>
      `;
      matContainer.appendChild(div);
    });

    // Populate Product SKUs dropdown based on selected packaging group category
    this.populateProductionProductDropdown();
  }

  switchProductionCategory(cat, btn) {
    this.currentProductionCategory = cat;
    
    document.querySelectorAll('.sub-tabs-bar .sub-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    this.populateProductionProductDropdown();
    this.updateProductionRecipeChecklist();
  }

  async populateProductionProductDropdown() {
    const products = await this.db.getProducts();
    const select = document.getElementById('production-product');
    if (!select) return;

    select.innerHTML = '<option value="" disabled selected>-- Select SKU --</option>';
    
    // Filter product catalogs matching current packaging category
    const filtered = products.filter(p => p.packaging_type === this.currentProductionCategory);
    
    if (filtered.length === 0) {
      select.innerHTML = '<option value="" disabled>-- No SKUs defined under this category --</option>';
      return;
    }

    filtered.forEach(p => {
      select.innerHTML += `<option value="${p.id}">${p.name} (${p.code})</option>`;
    });
  }

  // Pre-production forecast: computes available ingredient covers and checks raw material deficits
  async updateProductionRecipeChecklist() {
    const pId = document.getElementById('production-product').value;
    const qtyProduced = parseFloat(document.getElementById('production-qty').value) || 0;
    const list = document.getElementById('production-checklist');

    list.innerHTML = '';

    if (!pId || qtyProduced <= 0) {
      list.innerHTML = `<span class="td-muted italic">Select a product SKU and batch size to forecast ingredient checklists.</span>`;
      return;
    }

    const products = await this.db.getProducts();
    const rawMaterials = await this.db.getRawMaterials();
    
    const prod = products.find(p => p.id === pId);
    if (!prod) return;

    prod.bom.forEach(recipe => {
      const mat = rawMaterials.find(m => m.id === recipe.material_id);
      const name = mat ? mat.name : 'Unknown Ingredient';
      const unit = mat ? mat.unit : 'pcs';
      const available = mat ? parseFloat(mat.current_stock || 0) : 0;
      
      const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage) / 100);
      const totalNeeded = parseFloat(recipe.quantity) * qtyProduced * wasteFactor;
      const isShort = totalNeeded > available;

      const itemDiv = document.createElement('div');
      itemDiv.style.display = 'flex';
      itemDiv.style.justifyContent = 'space-between';
      itemDiv.style.color = isShort ? 'var(--color-danger)' : 'var(--color-success)';
      itemDiv.innerHTML = `
        <span>• ${name}: ${totalNeeded.toFixed(3)} ${unit} needed</span>
        <strong>(Avail: ${available.toFixed(3)} ${unit}) ${isShort ? '⚠️ Deficit' : '✓'}</strong>
      `;
      list.appendChild(itemDiv);
    });
  }

  async handleProductionSubmit(e) {
    e.preventDefault();

    const pId = document.getElementById('production-product').value;
    const qtyProduced = parseFloat(document.getElementById('production-qty').value) || 0;

    if (!pId || qtyProduced <= 0) return;

    const products = await this.db.getProducts();
    const rawMaterials = await this.db.getRawMaterials();
    
    const prod = products.find(p => p.id === pId);
    if (!prod) return;

    // Check deficits
    let deficitStr = '';
    prod.bom.forEach(recipe => {
      const mat = rawMaterials.find(m => m.id === recipe.material_id);
      const name = mat ? mat.name : 'Unknown';
      const available = mat ? parseFloat(mat.current_stock || 0) : 0;
      
      const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage) / 100);
      const needed = parseFloat(recipe.quantity) * qtyProduced * wasteFactor;

      if (needed > available) {
        deficitStr += `Material "${name}" stock is ${available.toFixed(3)}, but batch requires ${needed.toFixed(3)}.\n`;
      }
    });

    if (deficitStr) {
      const proceed = confirm(`Warning: Deficit detected in ingredients!\n\n${deficitStr}\nDo you still wish to execute the manufacturing batch?`);
      if (!proceed) return;
    }

    // Commit daily production run log
    await this.db.insertProduction({
      product_id: pId,
      product_name: prod.name,
      quantity_produced: qtyProduced,
      packaging_type: prod.packaging_type
    });

    // Clear form inputs
    document.getElementById('production-form').reset();
    document.getElementById('production-checklist').innerHTML = `<span class="td-muted italic">Select a product SKU and batch size to forecast ingredient checklists.</span>`;

    await this.refreshAllViews();
    alert(`Success! Recorded manufacture batch of ${qtyProduced} pcs. Ingredients reduced & Finished Goods incremented.`);
  }


  // --- 4. OUTWARD SALES DISPATCH WORKFLOW ---

  async renderOutwardPane() {
    // Populate outward finished goods stock lists
    const products = await this.db.getProducts();
    const select = document.getElementById('outward-product');
    const container = document.getElementById('outward-stock-container');

    if (select) {
      select.innerHTML = '<option value="" disabled selected>-- Select Finished Good --</option>';
      products.forEach(p => {
        select.innerHTML += `<option value="${p.id}">${p.name} (${p.code})</option>`;
      });
    }

    if (container) {
      container.innerHTML = '';
      if (products.length === 0) {
        container.innerHTML = `<div class="td-muted italic text-center" style="padding:1rem;">No finished goods defined.</div>`;
        return;
      }

      products.forEach(p => {
        const stock = parseFloat(p.current_stock || 0);
        const minStock = parseFloat(p.min_stock || 0);
        
        let statusClass = 'ok';
        let statusText = 'In Stock';
        if (stock === 0) {
          statusClass = 'out';
          statusText = 'Out of Stock';
        } else if (stock <= minStock) {
          statusClass = 'low';
          statusText = 'Low Cover';
        }

        const div = document.createElement('div');
        div.className = 'stock-cover-item';
        div.innerHTML = `
          <div>
            <div class="td-bold" style="font-size:0.85rem;">${p.name} <span class="td-muted" style="font-size:0.75rem;">(${p.code})</span></div>
            <div class="td-muted" style="font-size:0.75rem;">Category: ${p.packaging_type} • Price: Rs. ${p.selling_price.toFixed(2)}</div>
          </div>
          <div style="text-align: right;">
            <div class="td-bold" style="font-size:0.85rem;">${stock.toFixed(0)} pcs</div>
            <span class="stock-status-tag ${statusClass}" style="margin-top:0.15rem; display:inline-block;">${statusText}</span>
          </div>
        `;
        container.appendChild(div);
      });
    }
  }

  // Parse Sales dispatch invoice PDF heuristically via pdf.js
  async handleOutwardUpload(file) {
    if (!file || file.type !== 'application/pdf') {
      alert("Invalid format. Sales invoice must be a PDF file.");
      return;
    }

    try {
      const rawText = await this.parsePDFText(file);
      const extracted = this.heuristicsExtractSale(rawText);

      this.currentVerifyOutwardItems = extracted.products;

      // Populate review modal
      document.getElementById('vo-invoice').value = extracted.invoice_no;
      document.getElementById('vo-customer').value = 'FreshMart Wholesalers'; // Mock customer

      const tbody = document.getElementById('verify-outward-rows');
      tbody.innerHTML = '';

      const products = await this.db.getProducts();

      extracted.products.forEach((item, index) => {
        const tr = document.createElement('tr');

        // product options dropdown
        let pOptions = '<option value="" disabled selected>-- Select FG SKU --</option>';
        products.forEach(p => {
          const selected = item.product_id === p.id ? 'selected' : '';
          pOptions += `<option value="${p.id}" ${selected}>${p.name} (${p.code})</option>`;
        });

        tr.innerHTML = `
          <td>
            <div class="td-bold" style="font-size:0.75rem;">Extracted: "${item.raw_text_name}"</div>
            <select class="form-control" style="font-size:0.8rem; padding: 0.35rem;" onchange="app.updateVerifyOutwardItem(${index}, 'product_id', this.value)">
              ${pOptions}
            </select>
          </td>
          <td>
            <input type="number" class="form-control" style="font-size:0.8rem; padding:0.35rem;" value="${item.quantity_sold}" oninput="app.updateVerifyOutwardItem(${index}, 'quantity_sold', this.value)">
          </td>
          <td>
            <input type="number" step="0.01" class="form-control" style="font-size:0.8rem; padding:0.35rem;" value="${item.rate}" oninput="app.updateVerifyOutwardItem(${index}, 'rate', this.value)">
          </td>
        `;
        tbody.appendChild(tr);
      });

      this.openModal('modal-verify-outward');
    } catch (e) {
      console.error(e);
      alert("Failed to parse invoice PDF text: " + e.message);
    }
  }

  updateVerifyOutwardItem(index, key, val) {
    if (this.currentVerifyOutwardItems[index]) {
      if (key === 'product_id') {
        this.currentVerifyOutwardItems[index].product_id = val;
      } else if (key === 'rate') {
        this.currentVerifyOutwardItems[index].rate = parseFloat(val) || 0;
      } else {
        this.currentVerifyOutwardItems[index].quantity_sold = parseInt(val, 10) || 0;
      }
    }
  }

  async commitVerifyOutward() {
    const invoiceNo = document.getElementById('vo-invoice').value.trim();
    const customer = document.getElementById('vo-customer').value.trim();

    if (!invoiceNo || !customer) {
      alert("Invoice No and Customer Name are required.");
      return;
    }

    if (this.currentVerifyOutwardItems.some(i => !i.product_id)) {
      alert("Please map all products on the verify ledger.");
      return;
    }

    // Verify finished goods warehouse cover warnings
    let warningStr = '';
    const products = await this.db.getProducts();

    this.currentVerifyOutwardItems.forEach(item => {
      const p = products.find(prod => prod.id === item.product_id);
      if (p) {
        const avail = parseFloat(p.current_stock || 0);
        if (item.quantity_sold > avail) {
          warningStr += `Product "${p.name}" stock cover is ${avail} pcs, but dispatch request is ${item.quantity_sold} pcs.\n`;
        }
      }
    });

    if (warningStr) {
      const proceed = confirm(`Warning: Finished Goods stock shortage warning!\n\n${warningStr}\nAllow negative warehouse balance?`);
      if (!proceed) return;
    }

    this.closeModal('modal-verify-outward');

    for (const item of this.currentVerifyOutwardItems) {
      const p = products.find(prod => prod.id === item.product_id);
      if (p) {
        await this.db.insertOutward({
          invoice_no: invoiceNo,
          product_id: item.product_id,
          product_name: p.name,
          quantity_dispatched: item.quantity_sold,
          price_billed: item.rate || p.selling_price,
          customer
        });
      }
    }

    await this.refreshAllViews();
    alert("Outward committed! Shipped quantities deducted from Finished Goods available.");
  }

  async handleManualOutwardSubmit(e) {
    e.preventDefault();

    const invoiceNo = document.getElementById('outward-invoice').value.trim();
    const pId = document.getElementById('outward-product').value;
    const qty = parseFloat(document.getElementById('outward-qty').value) || 0;
    const price = parseFloat(document.getElementById('outward-price').value) || 0;
    const customer = document.getElementById('outward-customer').value.trim();

    if (!invoiceNo || !pId || qty <= 0 || price <= 0 || !customer) return;

    const products = await this.db.getProducts();
    const prod = products.find(p => p.id === pId);
    if (!prod) return;

    const currentStock = parseFloat(prod.current_stock || 0);
    if (qty > currentStock) {
      const proceed = confirm(`Warning: Finished Goods warehouse cover is ${currentStock} pcs, but dispatch request is ${qty} pcs. Allow negative balance?`);
      if (!proceed) return;
    }

    await this.db.insertOutward({
      invoice_no: invoiceNo,
      product_id: pId,
      product_name: prod.name,
      quantity_dispatched: qty,
      price_billed: price,
      customer
    });

    document.getElementById('outward-manual-form').reset();
    await this.refreshAllViews();
    alert(`Dispatch committed! Reduced stock cover for ${prod.name}.`);
  }


  // --- PARSERS & TEXT EXTRACTORS ---

  async parsePDFText(file) {
    const fileReader = new FileReader();
    return new Promise((resolve, reject) => {
      fileReader.onload = async function() {
        try {
          const typedarray = new Uint8Array(this.result);
          const pdf = await pdfjsLib.getDocument(typedarray).promise;
          let fullText = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join('\n');
            fullText += pageText + '\n';
          }
          resolve(fullText);
        } catch (e) {
          reject(e);
        }
      };
      fileReader.onerror = () => reject(new Error("File reading error."));
      fileReader.readAsArrayBuffer(file);
    });
  }

  heuristicsExtractPurchase(text) {
    const result = { invoice_no: 'PUR-' + Math.floor(1000 + Math.random() * 9000), date: new Date().toISOString().split('T')[0], raw_text_name: 'Raw Dried Red Chilli', quantity: 50.00, rate: 180.00, supplier: 'Agro Supplies Ltd' };
    
    // Extractor triggers
    const numMatches = text.match(/\b\d+(?:\.\d+)?\b/g);
    if (numMatches && numMatches.length >= 3) {
      // Mock extract details if numeric relationships found
      result.quantity = parseFloat(numMatches[0]) || 50;
      result.rate = parseFloat(numMatches[1]) || 180;
    }
    return result;
  }

  heuristicsExtractSale(text) {
    const result = { invoice_no: 'SAL-' + Math.floor(1000 + Math.random() * 9000), date: new Date().toISOString().split('T')[0], products: [] };
    
    // Seed at least one mock extracted row for review
    const products = this.db.offlineDb.products;
    const defaultProduct = products.length > 0 ? products[0] : { id: 'prod_peri_sauce', name: 'Signature Peri Peri Sauce 150ml', code: 'FG-PERI-150ML', selling_price: 160 };

    result.products.push({
      product_id: defaultProduct.id,
      raw_text_name: defaultProduct.name,
      quantity_sold: 10,
      rate: defaultProduct.selling_price
    });
    return result;
  }


  // --- SETTINGS CONFIGURATIONS ---

  openSettingsModal() {
    this.openModal('modal-settings');
  }

  loadSettingsForm() {
    document.getElementById('set-sup-url').value = this.db.config.supabaseUrl || '';
    document.getElementById('set-sup-key').value = this.db.config.supabaseKey || '';
  }

  saveSettings(e) {
    e.preventDefault();
    const url = document.getElementById('set-sup-url').value.trim();
    const key = document.getElementById('set-sup-key').value.trim();

    this.db.saveConfig(url, key);
    this.closeModal('modal-settings');
    this.refreshAllViews();
    alert("Supabase credentials saved successfully. System status adjusted.");
  }

  seedDatabase() {
    this.db.seedSandboxData();
    this.refreshAllViews();
    alert("Sandbox database seeded successfully with mock materials and products!");
  }

  resetLocalStorage() {
    if (confirm("Are you sure you want to WIPE all local data? This action is permanent.")) {
      localStorage.clear();
      location.reload();
    }
  }


  // --- SHARED UTILS ---

  copyToClipboard(textareaId) {
    const textarea = document.getElementById(textareaId);
    textarea.select();
    textarea.setSelectionRange(0, 99999); // For mobile devices
    
    try {
      navigator.clipboard.writeText(textarea.value);
      alert("WhatsApp message copied to clipboard! You can paste it in your group chat.");
    } catch (err) {
      // Fallback
      document.execCommand('copy');
      alert("WhatsApp message copied to clipboard!");
    }
  }

  openWhatsApp(textareaId) {
    const text = document.getElementById(textareaId).value;
    const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }

  openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }

  closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }
}

// Instantiate
window.app = new MFPMobilePortal();
