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
      outwards: [],
      returns: []
    };
    
    this.seedingInProgress = false;

    this.config = {
      supabaseUrl: '',
      supabaseKey: '',
      isOnline: false
    };

    this.loadConfig();
    this.initSupabase();
  }

  loadConfig() {
    // Check URL query parameters first for automatic provisioning
    const urlParams = new URLSearchParams(window.location.search);
    const queryUrl = urlParams.get('url');
    const queryKey = urlParams.get('key');

    if (queryUrl && queryKey) {
      this.config = {
        supabaseUrl: decodeURIComponent(queryUrl),
        supabaseKey: decodeURIComponent(queryKey),
        isOnline: true
      };
      localStorage.setItem('mfp_supabase_config', JSON.stringify(this.config));
      // Clean URL bar to hide credentials from plain sight
      window.history.replaceState({}, document.title, window.location.pathname);
    } else {
      const config = localStorage.getItem('mfp_supabase_config');
      if (config) {
        try {
          this.config = { ...this.config, ...JSON.parse(config) };
        } catch (e) {
          console.error("Failed to load DB config", e);
        }
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
    if (!this.offlineDb.returns) {
      this.offlineDb.returns = [];
    }

    // Auto-seed sandbox items if database is empty on first boot
    if (this.offlineDb.raw_materials.length === 0 && this.offlineDb.products.length === 0) {
      this.seedSandboxData();
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
        let cleanUrl = this.config.supabaseUrl.trim();
        // Remove trailing slashes and rest/v1 paths automatically
        cleanUrl = cleanUrl.replace(/\/rest\/v1\/?$/, '');
        cleanUrl = cleanUrl.replace(/\/$/, '');

        this.supabase = supabase.createClient(cleanUrl, this.config.supabaseKey);
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
      try {
        const { data, error } = await this.supabase.from('raw_materials').select('*').order('name');
        if (error) {
          console.error("Supabase error fetching raw materials:", error);
        } else if (data) {
          if (data.length === 0 && !this.seedingInProgress) {
            this.seedingInProgress = true;
            console.log("Cloud raw_materials is empty. Auto-seeding cloud...");
            await this.seedSandboxData();
            this.seedingInProgress = false;
            return [...this.offlineDb.raw_materials].sort((a, b) => a.name.localeCompare(b.name));
          }
          // Cache latest cloud raw materials into offline database
          this.offlineDb.raw_materials = data;
          this.saveOfflineDb();
          return data;
        }
      } catch (e) {
        console.error("Exception fetching raw materials:", e);
      }
    }
    return [...this.offlineDb.raw_materials].sort((a, b) => a.name.localeCompare(b.name));
  }

  async insertRawMaterial(material) {
    if (!material.id) {
      material.id = 'rm_' + Date.now();
    }
    if (!material.code) {
      const cleanName = (material.name || 'RM').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
      material.code = 'RM-' + cleanName;
    }
    material.current_stock = parseFloat(material.current_stock) || 0;
    material.unit = material.unit || 'Pieces';
    material.average_price = parseFloat(material.average_price) || 0;
    material.min_stock = parseFloat(material.min_stock) || 10.0;
    material.description = material.description || '';

    if (this.config.isOnline && this.supabase) {
      try {
        const payload = {
          id: material.id,
          code: material.code,
          name: material.name,
          current_stock: material.current_stock,
          unit: material.unit,
          average_price: material.average_price,
          min_stock: material.min_stock,
          description: material.description
        };
        const { data, error } = await this.supabase.from('raw_materials').upsert([payload]).select();
        if (error) {
          console.error("Error upserting raw material to Supabase:", error);
        } else if (data && data[0]) {
          material = data[0];
        }
      } catch (e) {
        console.error("Exception upserting raw material:", e);
      }
    }

    // Always update offline cache
    const existingIdx = this.offlineDb.raw_materials.findIndex(m => m.id === material.id || m.code === material.code);
    if (existingIdx !== -1) {
      this.offlineDb.raw_materials[existingIdx] = material;
    } else {
      this.offlineDb.raw_materials.push(material);
    }
    this.saveOfflineDb();
    return material;
  }

  async getProducts() {
    if (this.config.isOnline && this.supabase) {
      try {
        const { data, error } = await this.supabase.from('products').select('*').order('name');
        if (error) {
          console.error("Supabase error fetching products:", error);
        } else if (data) {
          if (data.length === 0 && !this.seedingInProgress) {
            this.seedingInProgress = true;
            console.log("Cloud products is empty. Auto-seeding cloud...");
            await this.seedSandboxData();
            this.seedingInProgress = false;
            return [...this.offlineDb.products].sort((a, b) => a.name.localeCompare(b.name));
          }
          // Cache latest cloud products into offline database
          this.offlineDb.products = data;
          this.saveOfflineDb();
          return data;
        }
      } catch (e) {
        console.error("Exception fetching products:", e);
      }
    }
    return [...this.offlineDb.products].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getOrders() {
    if (this.config.isOnline && this.supabase) {
      try {
        const { data, error } = await this.supabase.from('orders').select('*').order('created_at', { ascending: false });
        if (error) {
          console.error("Supabase error fetching orders:", error);
        } else if (data) {
          return data;
        }
      } catch (e) {
        console.error("Exception fetching orders:", e);
      }
    }
    return [...this.offlineDb.orders].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  async insertOrder(order) {
    order.id = 'ord_' + Date.now();
    const dateStr = order.date || new Date().toISOString().split('T')[0];
    order.date = dateStr;
    order.created_at = new Date(dateStr + 'T12:00:00Z').toISOString();
    order.status = 'Pending';

    if (this.config.isOnline && this.supabase) {
      const payload = {
        id: order.id,
        created_at: order.created_at,
        material_id: order.material_id,
        material_name: order.material_name,
        quantity_requested: order.quantity_requested,
        vendor_name: order.vendor_name,
        price_suggested: order.price_suggested,
        status: order.status
      };
      const { error } = await this.supabase.from('orders').insert([payload]);
      if (error) console.error("Error inserting order to Supabase:", error);
    }
    
    this.offlineDb.orders.push(order);
    this.saveOfflineDb();
    return order;
  }

  async insertInward(inward) {
    inward.id = 'inw_' + Date.now();
    const dateStr = inward.date || new Date().toISOString().split('T')[0];
    inward.date = dateStr;
    inward.created_at = new Date(dateStr + 'T12:00:00Z').toISOString();

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
      const payload = {
        id: inward.id,
        created_at: inward.created_at,
        invoice_no: inward.invoice_no,
        material_id: inward.material_id,
        material_name: inward.material_name,
        quantity_received: inward.quantity_received,
        rate_billed: inward.rate_billed,
        supplier: inward.supplier,
        linked_order_id: inward.linked_order_id,
        has_variance: inward.has_variance,
        variance_notes: inward.variance_notes
      };
      const { error } = await this.supabase.from('inwards').insert([payload]);
      if (error) console.error("Error inserting inward to Supabase:", error);
    }
    
    this.offlineDb.inwards.push(inward);
    this.saveOfflineDb();
    return inward;
  }

  async insertProduction(prod) {
    prod.id = 'run_' + Date.now();
    const dateStr = prod.date || new Date().toISOString().split('T')[0];
    prod.date = dateStr;
    prod.created_at = new Date(dateStr + 'T12:00:00Z').toISOString();

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
      const payload = {
        id: prod.id,
        created_at: prod.created_at,
        product_id: prod.product_id,
        product_name: prod.product_name,
        quantity_produced: prod.quantity_produced,
        packaging_type: prod.packaging_type
      };
      const { error } = await this.supabase.from('productions').insert([payload]);
      if (error) console.error("Error inserting production to Supabase:", error);
    }
    
    this.offlineDb.productions.push(prod);
    this.saveOfflineDb();
    return prod;
  }

  async insertOutward(outward) {
    outward.id = 'otw_' + Date.now();
    const dateStr = outward.date || new Date().toISOString().split('T')[0];
    outward.date = dateStr;
    outward.created_at = new Date(dateStr + 'T12:00:00Z').toISOString();

    // Deduct Finished Goods stock level
    const products = await this.getProducts();
    const targetProduct = products.find(p => p.id === outward.product_id);
    if (targetProduct) {
      const newFGStock = Math.max(0, parseFloat(targetProduct.current_stock || 0) - parseFloat(outward.quantity_dispatched));
      await this.updateProductStock(targetProduct.id, newFGStock);
    }

    if (this.config.isOnline && this.supabase) {
      const payload = {
        id: outward.id,
        created_at: outward.created_at,
        invoice_no: outward.invoice_no,
        product_id: outward.product_id,
        product_name: outward.product_name,
        quantity_dispatched: outward.quantity_dispatched,
        price_billed: outward.price_billed,
        customer: outward.customer
      };
      const { error } = await this.supabase.from('outwards').insert([payload]);
      if (error) console.error("Error inserting outward to Supabase:", error);
    }
    
    this.offlineDb.outwards.push(outward);
    this.saveOfflineDb();
    return outward;
  }

  async getReturns() {
    if (!this.offlineDb.returns) this.offlineDb.returns = [];
    return [...this.offlineDb.returns].sort((a, b) => new Date(b.created_at || b.date) - new Date(a.created_at || a.date));
  }

  async insertMaterialReturn(returnData) {
    returnData.id = 'ret_' + Date.now();
    const dateStr = returnData.date || new Date().toISOString().split('T')[0];
    returnData.date = dateStr;
    returnData.created_at = new Date(dateStr + 'T12:00:00Z').toISOString();

    const products = await this.getProducts();
    if (!this.offlineDb.returns) this.offlineDb.returns = [];

    // 1. Add returned quantities back to Finished Goods inventory
    for (const item of returnData.items) {
      const prod = products.find(p => p.id === item.product_id);
      if (prod) {
        const currentStock = parseFloat(prod.current_stock || 0);
        const returnQty = parseFloat(item.quantity || 0);
        const newStock = currentStock + returnQty;
        await this.updateProductStock(prod.id, newStock);

        // Also record line into Supabase 'inwards' table if online
        if (this.config.isOnline && this.supabase) {
          try {
            const payload = {
              id: 'ret_inw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
              created_at: returnData.created_at,
              invoice_no: returnData.credit_note_no,
              material_id: prod.id,
              material_name: `[Return FG] ${prod.name}`,
              quantity_received: returnQty,
              rate_billed: parseFloat(item.rate || prod.selling_price || 0),
              supplier: returnData.customer,
              linked_order_id: null,
              has_variance: false,
              variance_notes: `Mfd Date: ${item.mfg_date || 'N/A'}${item.batch_no ? ', Batch: ' + item.batch_no : ''}${returnData.reason ? ', Reason: ' + returnData.reason : ''}`
            };
            await this.supabase.from('inwards').insert([payload]);
          } catch (err) {
            console.error("Error logging return line to Supabase inwards table:", err);
          }
        }
      }
    }

    this.offlineDb.returns.push(returnData);
    this.saveOfflineDb();
    return returnData;
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
      },
      { id: 'fg_or_pz_10g', code: 'FG-OR-PZ-10G', name: 'truFLAVR Oregano Pizza Seasoning 10 gms Pouch', price: 5.79, selling_price: 5.79, current_stock: 5000, min_stock: 500, packaging_type: 'Pouches', bom: [] },
      { id: 'fg_cf_10g', code: 'FG-CF-10G', name: 'truFLAVR Chilli Flakes 10 gms Pouch', price: 5.79, selling_price: 5.79, current_stock: 5000, min_stock: 500, packaging_type: 'Pouches', bom: [] },
      { id: 'fg_cf_45g', code: 'FG-CF-45G', name: 'truFLAVR Chilli Flakes 45 gms Bottle', price: 63.64, selling_price: 63.64, current_stock: 500, min_stock: 50, packaging_type: 'Bottles', bom: [] },
      { id: 'fg_or_25g', code: 'FG-OR-25G', name: 'truFLAVR Oregano 25 gms Bottle', price: 57.28, selling_price: 57.28, current_stock: 500, min_stock: 50, packaging_type: 'Bottles', bom: [] },
      { id: 'fg_is_40g', code: 'FG-IS-40G', name: 'truFLAVR Italian Seasoning 40 gms Bottle', price: 63.64, selling_price: 63.64, current_stock: 500, min_stock: 50, packaging_type: 'Bottles', bom: [] },
      { id: 'fg_pp_50g', code: 'FG-PP-50G', name: 'truFLAVR Peri Peri 50 gms Bottle', price: 57.28, selling_price: 57.28, current_stock: 500, min_stock: 50, packaging_type: 'Bottles', bom: [] },
      { id: 'fg_cpp_50g', code: 'FG-CPP-50G', name: 'truFLAVR Cheese Peri Peri 50 gms Bottle', price: 57.28, selling_price: 57.28, current_stock: 500, min_stock: 50, packaging_type: 'Bottles', bom: [] },
      { id: 'fg_bs_10g', code: 'FG-BS-10G', name: 'truFLAVR Bombay Sandwich 10 gms Pouch', price: 5.79, selling_price: 5.79, current_stock: 2000, min_stock: 200, packaging_type: 'Pouches', bom: [] },
      { id: 'fg_im_10g', code: 'FG-IM-10G', name: 'truFLAVR Italian Mix 10 gms Pouch', price: 5.79, selling_price: 5.79, current_stock: 2000, min_stock: 200, packaging_type: 'Pouches', bom: [] },
      { id: 'fg_pp_10g', code: 'FG-PP-10G', name: 'truFLAVR Peri Peri 10 gms Pouch', price: 5.79, selling_price: 5.79, current_stock: 2000, min_stock: 200, packaging_type: 'Pouches', bom: [] }
    ];

    this.saveOfflineDb();

    // Push sandbox items to Supabase cloud if connected
    if (this.config.isOnline && this.supabase) {
      try {
        this.supabase.from('raw_materials').upsert(this.offlineDb.raw_materials).then(({ error }) => {
          if (error) console.error("Cloud seed error (raw materials):", error);
        });
        this.supabase.from('products').upsert(this.offlineDb.products).then(({ error }) => {
          if (error) console.error("Cloud seed error (products):", error);
        });
      } catch (e) {
        console.error("Cloud seed exception:", e);
      }
    }
  }
}

// --------------------------------------------------------------------------
// MAIN APPLICATION CONTROLLER
// --------------------------------------------------------------------------

class MFPMobilePortal {
  constructor() {
    this.db = new DBClient();
    this.currentProductionCategory = 'All'; // Active subtab
    this.currentVerifyInwardItems = [];
    this.currentVerifyOutwardItems = [];
    this.batchOutwardInvoices = [];
    this.activeBatchOutwardIdx = 0;

    // Multi-item dynamic states
    this.orderItems = [];
    this.inwardItems = [];
    this.productionItems = [];
    this.returnItems = [];
    this.inwardActiveSubTab = 'raw';

    this.init();
  }

  getTodayDate() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  formatDateToISO(dStr) {
    if (!dStr) return this.getTodayDate();
    const cleaned = dStr.trim().replace(/[/.]/g, '-');
    const parts = cleaned.split('-');
    if (parts.length === 3) {
      // If DD-MM-YYYY (e.g. 07-09-2026)
      if (parts[0].length <= 2 && parts[2].length === 4) {
        return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }
      // If YYYY-MM-DD
      if (parts[0].length === 4 && parts[1].length <= 2 && parts[2].length <= 2) {
        return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      }
    }
    const parsed = Date.parse(dStr);
    if (!isNaN(parsed)) {
      return new Date(parsed).toISOString().split('T')[0];
    }
    return this.getTodayDate();
  }

  initDateInputs() {
    const today = this.getTodayDate();
    const dateInputIds = ['order-date', 'inward-date', 'return-date', 'production-date', 'outward-date', 'vi-date', 'vo-date'];
    dateInputIds.forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.value) {
        el.value = today;
      }
    });
  }

  setupDropzones() {
    const setup = (dropId, inputId, callback) => {
      const dropzone = document.getElementById(dropId);
      if (!dropzone) return;

      ['dragenter', 'dragover'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('dragover');
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        dropzone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('dragover');
        });
      });

      dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (dt && dt.files && dt.files.length > 0) {
          callback(dt.files);
        }
      });
    };

    setup('inward-dropzone', 'inward-file-input', (files) => this.handleInwardUpload(files[0]));
    setup('return-dropzone', 'return-file-input', (files) => this.handleCreditNoteUpload(files[0]));
    setup('outward-dropzone', 'outward-file-input', (files) => this.handleOutwardUploadMultiple(files));
  }

  async init() {
    // Navigation listeners
    document.querySelectorAll('.bottom-nav .nav-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const viewId = e.currentTarget.getAttribute('data-target');
        this.switchView(viewId, e.currentTarget);
      });
    });

    this.initDateInputs();
    this.setupDropzones();
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

    this.initDateInputs();
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

  // --- 1. ORDER REQUEST WORKFLOW (MULTI-ITEM) ---
  
  async renderOrderPane() {
    // Populate Outstanding Orders
    const orders = await this.db.getOrders();
    const container = document.getElementById('order-list-container');
    if (container) {
      container.innerHTML = '';
      const pendings = orders.filter(o => o.status === 'Pending');
      if (pendings.length === 0) {
        container.innerHTML = `<div class="td-muted italic text-center" style="padding:1rem;">No pending purchase orders.</div>`;
      } else {
        pendings.forEach(ord => {
          const div = document.createElement('div');
          div.className = 'stock-cover-item';
          const dateDisplay = ord.date || (ord.created_at ? ord.created_at.split('T')[0] : 'N/A');
          div.innerHTML = `
            <div>
              <div class="td-bold" style="font-size:0.85rem;">${ord.material_name}</div>
              <div class="td-muted" style="font-size:0.75rem;">Date: ${dateDisplay} • Qty: ${ord.quantity_requested} • Vendor: ${ord.vendor_name || 'N/A'}</div>
            </div>
            <span class="badge badge-warning" style="font-size:0.65rem;">Pending</span>
          `;
          container.appendChild(div);
        });
      }
    }

    if (!this.orderItems || this.orderItems.length === 0) {
      this.orderItems = [{ material_id: '', quantity: 50, target_price: 0 }];
    }
    await this.renderOrderItems();
  }

  addOrderItemRow() {
    this.orderItems.push({ material_id: '', quantity: 10, target_price: 0 });
    this.renderOrderItems();
  }

  removeOrderItemRow(index) {
    if (this.orderItems.length > 1) {
      this.orderItems.splice(index, 1);
      this.renderOrderItems();
    }
  }

  async updateOrderItem(index, field, val) {
    if (!this.orderItems[index]) return;

    if (field === 'material_id') {
      if (val === '__NEW__') {
        this.openAddMaterialModal('order', index);
        return;
      }
      this.orderItems[index].material_id = val;
      const materials = await this.db.getRawMaterials();
      const mat = materials.find(m => m.id === val);
      if (mat && (!this.orderItems[index].target_price || this.orderItems[index].target_price === 0)) {
        this.orderItems[index].target_price = mat.average_price || 0;
        const priceInput = document.getElementById(`order-item-price-${index}`);
        if (priceInput) priceInput.value = this.orderItems[index].target_price;
      }
      const unitEl = document.getElementById(`order-item-unit-${index}`);
      if (unitEl && mat) unitEl.textContent = mat.unit;
    } else if (field === 'quantity') {
      this.orderItems[index].quantity = parseFloat(val) || 0;
    } else if (field === 'target_price') {
      this.orderItems[index].target_price = parseFloat(val) || 0;
    }

    // Update row total
    const qty = this.orderItems[index].quantity || 0;
    const price = this.orderItems[index].target_price || 0;
    const subtotalEl = document.getElementById(`order-item-subtotal-${index}`);
    if (subtotalEl) {
      subtotalEl.textContent = `Rs. ${(qty * price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    }

    this.calculateOrderEstimatedTotal();
  }

  calculateOrderEstimatedTotal() {
    let total = 0;
    this.orderItems.forEach(item => {
      total += (item.quantity || 0) * (item.target_price || 0);
    });
    const badge = document.getElementById('order-estimated-total');
    if (badge) {
      badge.textContent = `Est. Total: Rs. ${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    }
  }

  async renderOrderItems() {
    const container = document.getElementById('order-items-container');
    if (!container) return;
    container.innerHTML = '';

    const materials = await this.db.getRawMaterials();

    this.orderItems.forEach((item, index) => {
      const box = document.createElement('div');
      box.className = 'multi-item-box';

      const selectedMat = materials.find(m => m.id === item.material_id);
      const unit = selectedMat ? selectedMat.unit : 'unit';
      const subtotal = (item.quantity || 0) * (item.target_price || 0);

      let matOptions = '<option value="" disabled selected>-- Select Material / Ingredient --</option>';
      materials.forEach(m => {
        const isSel = m.id === item.material_id ? 'selected' : '';
        matOptions += `<option value="${m.id}" ${isSel}>${m.name} (${m.code}) - ${m.unit}</option>`;
      });
      matOptions += `<option value="__NEW__" style="color:var(--color-primary); font-weight:bold;">➕ + Add New Raw Material...</option>`;

      const removeBtnHtml = this.orderItems.length > 1
        ? `<button type="button" class="multi-item-remove-btn" onclick="app.removeOrderItemRow(${index})"><i class="fa-solid fa-trash-can"></i> Remove</button>`
        : '';

      box.innerHTML = `
        <div class="multi-item-header">
          <span><i class="fa-solid fa-hashtag"></i> Item #${index + 1}</span>
          ${removeBtnHtml}
        </div>
        <div class="form-group" style="margin-bottom:0.45rem;">
          <select class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" onchange="app.updateOrderItem(${index}, 'material_id', this.value)" required>
            ${matOptions}
          </select>
        </div>
        <div class="form-row" style="margin-bottom:0.25rem;">
          <div class="form-group" style="margin-bottom:0;">
            <label style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.2rem;">Qty (<span id="order-item-unit-${index}">${unit}</span>) *</label>
            <input type="number" step="0.001" min="0.001" class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" value="${item.quantity || ''}" placeholder="e.g. 50" oninput="app.updateOrderItem(${index}, 'quantity', this.value)" required>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.2rem;">Target Rate (Rs.)</label>
            <input type="number" step="0.01" min="0" id="order-item-price-${index}" class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" value="${item.target_price || ''}" placeholder="Rs./unit" oninput="app.updateOrderItem(${index}, 'target_price', this.value)">
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; font-size:0.7rem; color:var(--text-muted); margin-top:0.25rem;">
          Subtotal: <strong id="order-item-subtotal-${index}" style="margin-left:0.35rem; color:var(--text-color);">Rs. ${subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
        </div>
      `;
      container.appendChild(box);
    });

    this.calculateOrderEstimatedTotal();

    const submitBtn = document.getElementById('order-submit-btn');
    if (submitBtn) {
      submitBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Submit Order Request (${this.orderItems.length} Item${this.orderItems.length > 1 ? 's' : ''})`;
    }
  }

  async handleOrderSubmit(e) {
    e.preventDefault();

    const orderDate = (document.getElementById('order-date') && document.getElementById('order-date').value) || this.getTodayDate();
    const vendor = (document.getElementById('order-vendor') ? document.getElementById('order-vendor').value.trim() : '');

    if (!vendor) {
      alert("Vendor / Supplier Name is required.");
      return;
    }

    if (!this.orderItems || this.orderItems.length === 0) {
      alert("Please add at least one item to the order.");
      return;
    }

    // Validate all items
    for (let i = 0; i < this.orderItems.length; i++) {
      const it = this.orderItems[i];
      if (!it.material_id) {
        alert(`Please select a raw material for Item #${i + 1}.`);
        return;
      }
      if (!it.quantity || it.quantity <= 0) {
        alert(`Please specify a valid quantity for Item #${i + 1}.`);
        return;
      }
    }

    const materials = await this.db.getRawMaterials();
    const orderGroupId = 'PO-' + Date.now().toString().slice(-6);

    let totalEst = 0;
    let itemsTextList = '';

    for (let i = 0; i < this.orderItems.length; i++) {
      const it = this.orderItems[i];
      const mat = materials.find(m => m.id === it.material_id);
      const matName = mat ? mat.name : 'Raw Material';
      const matCode = mat ? mat.code : '';
      const unit = mat ? mat.unit : 'units';
      const price = it.target_price || 0;
      const subtotal = (it.quantity || 0) * price;
      totalEst += subtotal;

      await this.db.insertOrder({
        date: orderDate,
        order_group_id: orderGroupId,
        material_id: it.material_id,
        material_name: matName,
        quantity_requested: it.quantity,
        vendor_name: vendor,
        price_suggested: price
      });

      itemsTextList += `${i + 1}. *${matName}* (${matCode})\n` +
                       `   • *Qty:* ${it.quantity} ${unit}` +
                       (price > 0 ? ` • *Target Rate:* Rs. ${price.toFixed(2)} / ${unit} (Rs. ${subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })})` : '') +
                       `\n`;
    }

    // Compile Multi-Item WhatsApp order request
    const waText = `📦 *MFP ERP - Purchase Order Request*\n` +
                   `• *Date:* ${orderDate}\n` +
                   `• *Supplier / Vendor:* ${vendor}\n` +
                   `• *Order Reference:* ${orderGroupId}\n\n` +
                   `*Materials Ordered (${this.orderItems.length} Items):*\n` +
                   itemsTextList +
                   `\n*Total Estimated Value:* Rs. ${totalEst.toLocaleString('en-IN', { minimumFractionDigits: 2 })}\n` +
                   `\n_Please confirm order acceptance and expected delivery schedule. Submitted via MFP Mobile Console._`;

    document.getElementById('order-wa-text').value = waText;
    document.getElementById('order-wa-widget').classList.remove('hidden');

    const prevCount = this.orderItems.length;
    document.getElementById('order-form').reset();
    this.orderItems = [{ material_id: '', quantity: 50, target_price: 0 }];
    this.initDateInputs();
    await this.renderOrderPane();
    alert(`Purchase Order Request ${orderGroupId} submitted for ${prevCount} item(s)! WhatsApp message compiled.`);
  }


  // --- 2. INWARD PURCHASE BILL RECONCILIATION WORKFLOW (MULTI-ITEM) ---

  async renderInwardPane() {
    if (this.inwardActiveSubTab === 'return') {
      await this.renderReturnPane();
    } else {
      if (!this.inwardItems || this.inwardItems.length === 0) {
        this.inwardItems = [{ linked_order_id: '', material_id: '', quantity: 50, rate: 0 }];
      }
      await this.renderInwardItems();
    }
  }

  addInwardItemRow() {
    this.inwardItems.push({ linked_order_id: '', material_id: '', quantity: 10, rate: 0 });
    this.renderInwardItems();
  }

  removeInwardItemRow(index) {
    if (this.inwardItems.length > 1) {
      this.inwardItems.splice(index, 1);
      this.renderInwardItems();
    }
  }

  async updateInwardItem(index, field, val) {
    if (!this.inwardItems[index]) return;

    if (field === 'select_source') {
      if (val === '__NEW__') {
        this.openAddMaterialModal('inward', index);
        return;
      }
      const orders = await this.db.getOrders();
      const materials = await this.db.getRawMaterials();

      if (val.startsWith('ord_')) {
        const ord = orders.find(o => o.id === val);
        if (ord) {
          this.inwardItems[index].linked_order_id = ord.id;
          this.inwardItems[index].material_id = ord.material_id;
          this.inwardItems[index].quantity = parseFloat(ord.quantity_requested) || 1;
          this.inwardItems[index].rate = parseFloat(ord.price_suggested) || 0;

          // Auto-fill supplier if currently empty
          const suppInput = document.getElementById('inward-supplier');
          if (suppInput && !suppInput.value && ord.vendor_name) {
            suppInput.value = ord.vendor_name;
          }

          const qtyInput = document.getElementById(`inward-item-qty-${index}`);
          if (qtyInput) qtyInput.value = this.inwardItems[index].quantity;
          const rateInput = document.getElementById(`inward-item-rate-${index}`);
          if (rateInput) rateInput.value = this.inwardItems[index].rate;
        }
      } else if (val.startsWith('mat_')) {
        const matId = val.replace('mat_', '');
        const mat = materials.find(m => m.id === matId);
        if (mat) {
          this.inwardItems[index].linked_order_id = '';
          this.inwardItems[index].material_id = mat.id;
          if (!this.inwardItems[index].rate || this.inwardItems[index].rate === 0) {
            this.inwardItems[index].rate = mat.average_price || 0;
            const rateInput = document.getElementById(`inward-item-rate-${index}`);
            if (rateInput) rateInput.value = this.inwardItems[index].rate;
          }
        }
      }
    } else if (field === 'quantity') {
      this.inwardItems[index].quantity = parseFloat(val) || 0;
    } else if (field === 'rate') {
      this.inwardItems[index].rate = parseFloat(val) || 0;
    }

    const qty = this.inwardItems[index].quantity || 0;
    const rate = this.inwardItems[index].rate || 0;
    const subtotalEl = document.getElementById(`inward-item-subtotal-${index}`);
    if (subtotalEl) {
      subtotalEl.textContent = `Rs. ${(qty * rate).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    }

    this.calculateInwardTotal();
  }

  calculateInwardTotal() {
    let total = 0;
    this.inwardItems.forEach(item => {
      total += (item.quantity || 0) * (item.rate || 0);
    });
    const badge = document.getElementById('inward-total-amount');
    if (badge) {
      badge.textContent = `Total: Rs. ${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    }
  }

  async renderInwardItems() {
    const container = document.getElementById('inward-items-container');
    if (!container) return;
    container.innerHTML = '';

    const orders = await this.db.getOrders();
    const pendingOrders = orders.filter(o => o.status === 'Pending');
    const materials = await this.db.getRawMaterials();

    this.inwardItems.forEach((item, index) => {
      const box = document.createElement('div');
      box.className = 'multi-item-box';

      const selectedMat = materials.find(m => m.id === item.material_id);
      const unit = selectedMat ? selectedMat.unit : 'unit';
      const subtotal = (item.quantity || 0) * (item.rate || 0);

      // Construct dropdown with optgroups grouped by PO / Vendor
      let optionsHtml = '<option value="" disabled selected>-- Link Order or Select Material --</option>';

      if (pendingOrders.length > 0) {
        const grouped = {};
        pendingOrders.forEach(o => {
          const key = o.order_group_id ? `PO: ${o.order_group_id} • ${o.vendor_name || 'Vendor'}` : (o.vendor_name ? `Vendor: ${o.vendor_name}` : 'Pending Orders');
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(o);
        });

        Object.keys(grouped).forEach(grpKey => {
          optionsHtml += `<optgroup label="📋 ${grpKey}">`;
          grouped[grpKey].forEach(o => {
            const isSel = item.linked_order_id === o.id ? 'selected' : '';
            optionsHtml += `<option value="${o.id}" ${isSel}>${o.material_name} (Req: ${o.quantity_requested} pcs @ Rs.${o.price_suggested || 0})</option>`;
          });
          optionsHtml += `</optgroup>`;
        });
      }

      optionsHtml += '<optgroup label="📦 Direct Material Inward (No PO)">';
      materials.forEach(m => {
        const isSel = (!item.linked_order_id && item.material_id === m.id) ? 'selected' : '';
        optionsHtml += `<option value="mat_${m.id}" ${isSel}>${m.name} (${m.code}) - ${m.unit}</option>`;
      });
      optionsHtml += '</optgroup>';

      optionsHtml += '<optgroup label="✨ Create New">';
      optionsHtml += '<option value="__NEW__" style="color:var(--color-primary); font-weight:bold;">➕ + Add New Raw Material...</option>';
      optionsHtml += '</optgroup>';

      const removeBtnHtml = this.inwardItems.length > 1
        ? `<button type="button" class="multi-item-remove-btn" onclick="app.removeInwardItemRow(${index})"><i class="fa-solid fa-trash-can"></i> Remove</button>`
        : '';

      const linkedOrd = item.linked_order_id ? orders.find(o => o.id === item.linked_order_id) : null;
      const linkedBadgeHtml = linkedOrd
        ? `<div style="display:inline-flex; align-items:center; gap:0.25rem; font-size:0.68rem; color:var(--color-primary); background:rgba(16, 185, 129, 0.1); border:1px solid rgba(16, 185, 129, 0.25); padding:0.15rem 0.4rem; border-radius:4px; margin-bottom:0.35rem;">
             <i class="fa-solid fa-link"></i> Linked: <strong>${linkedOrd.order_group_id ? '[' + linkedOrd.order_group_id + '] ' : ''}${linkedOrd.material_name}</strong> (${linkedOrd.quantity_requested} pcs @ Rs.${linkedOrd.price_suggested || 0})
           </div>`
        : '';

      box.innerHTML = `
        <div class="multi-item-header">
          <span><i class="fa-solid fa-circle-down"></i> Inward Item #${index + 1}</span>
          ${removeBtnHtml}
        </div>
        ${linkedBadgeHtml}
        <div class="form-group" style="margin-bottom:0.45rem;">
          <select class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" onchange="app.updateInwardItem(${index}, 'select_source', this.value)" required>
            ${optionsHtml}
          </select>
        </div>
        <div class="form-row" style="margin-bottom:0.25rem;">
          <div class="form-group" style="margin-bottom:0;">
            <label style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.2rem;">Received Qty (${unit}) *</label>
            <input type="number" step="0.001" min="0.001" id="inward-item-qty-${index}" class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" value="${item.quantity || ''}" placeholder="Actual received" oninput="app.updateInwardItem(${index}, 'quantity', this.value)" required>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.2rem;">Billed Rate (Rs.) *</label>
            <input type="number" step="0.01" min="0.01" id="inward-item-rate-${index}" class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" value="${item.rate || ''}" placeholder="Unit price" oninput="app.updateInwardItem(${index}, 'rate', this.value)" required>
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; font-size:0.7rem; color:var(--text-muted); margin-top:0.25rem;">
          Line Total: <strong id="inward-item-subtotal-${index}" style="margin-left:0.35rem; color:var(--text-color);">Rs. ${subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
        </div>
      `;
      container.appendChild(box);
    });

    this.calculateInwardTotal();

    const submitBtn = document.getElementById('inward-submit-btn');
    if (submitBtn) {
      submitBtn.innerHTML = `<i class="fa-solid fa-check-double"></i> Commit Inward & Verify (${this.inwardItems.length} Item${this.inwardItems.length > 1 ? 's' : ''})`;
    }
  }

  // --- MULTI-ORDER SELECTION MODAL CONTROLLER ---

  async openSelectOrdersModal() {
    const orders = await this.db.getOrders();
    const pendings = orders.filter(o => o.status === 'Pending');

    if (pendings.length === 0) {
      alert("No pending purchase orders available to inward.");
      return;
    }

    const container = document.getElementById('pending-orders-select-container');
    if (!container) return;
    container.innerHTML = '';

    // Group pending orders by PO group or Vendor
    const grouped = {};
    pendings.forEach(ord => {
      const grpKey = ord.order_group_id ? ord.order_group_id : (ord.vendor_name ? `Vendor: ${ord.vendor_name}` : 'Individual Orders');
      if (!grouped[grpKey]) grouped[grpKey] = [];
      grouped[grpKey].push(ord);
    });

    Object.keys(grouped).forEach(grpKey => {
      const grpOrders = grouped[grpKey];
      const vendorName = grpOrders[0] ? (grpOrders[0].vendor_name || 'Vendor') : 'Vendor';
      const grpIdSanitized = grpKey.replace(/[^a-zA-Z0-9_-]/g, '_');

      const grpCard = document.createElement('div');
      grpCard.style.cssText = 'background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.6rem;';

      let itemsHtml = '';
      grpOrders.forEach(ord => {
        const priceStr = ord.price_suggested ? ` @ Rs. ${parseFloat(ord.price_suggested).toFixed(2)}` : '';
        itemsHtml += `
          <label style="display:flex; align-items:center; gap:0.55rem; padding:0.4rem 0.2rem; font-size:0.8rem; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.04);">
            <input type="checkbox" class="pending-order-checkbox grp-order-${grpIdSanitized}" value="${ord.id}" data-vendor="${ord.vendor_name || ''}" onchange="app.updateSelectedOrdersCount()" style="width:16px; height:16px; accent-color:var(--color-primary); cursor:pointer;">
            <div style="flex:1;">
              <div style="font-weight:600; color:var(--text-color);">${ord.material_name}</div>
              <div style="font-size:0.7rem; color:var(--text-muted);">Req: <strong>${ord.quantity_requested} pcs</strong>${priceStr} • ${ord.date || ''}</div>
            </div>
          </label>
        `;
      });

      grpCard.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem; padding-bottom:0.35rem; border-bottom:1px solid var(--border-color);">
          <div>
            <span style="font-weight:700; font-size:0.82rem; color:var(--color-primary);"><i class="fa-solid fa-boxes-stacked"></i> ${grpKey}</span>
            <div style="font-size:0.7rem; color:var(--text-muted);">${vendorName} (${grpOrders.length} item${grpOrders.length > 1 ? 's' : ''})</div>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="app.toggleSelectAllOrdersInGroup('${grpIdSanitized}')" style="font-size:0.7rem; padding:0.2rem 0.5rem;">
            Select All
          </button>
        </div>
        <div>
          ${itemsHtml}
        </div>
      `;
      container.appendChild(grpCard);
    });

    this.updateSelectedOrdersCount();
    this.openModal('modal-select-pending-orders');
  }

  toggleSelectAllOrdersInGroup(grpIdSanitized) {
    const cbs = document.querySelectorAll(`.pending-order-checkbox.grp-order-${grpIdSanitized}`);
    if (cbs.length === 0) return;
    const anyUnchecked = Array.from(cbs).some(cb => !cb.checked);
    cbs.forEach(cb => { cb.checked = anyUnchecked; });
    this.updateSelectedOrdersCount();
  }

  updateSelectedOrdersCount() {
    const checked = document.querySelectorAll('.pending-order-checkbox:checked');
    const btn = document.getElementById('btn-commit-selected-orders');
    if (btn) {
      btn.innerHTML = `<i class="fa-solid fa-arrow-down"></i> Load Selected into Inward (${checked.length})`;
      btn.disabled = (checked.length === 0);
    }
  }

  async commitSelectedOrdersToInward() {
    const checked = Array.from(document.querySelectorAll('.pending-order-checkbox:checked'));
    if (checked.length === 0) {
      alert("Please select at least one pending order to inward.");
      return;
    }

    const orders = await this.db.getOrders();
    const selectedIds = checked.map(cb => cb.value);
    const selectedOrders = orders.filter(o => selectedIds.includes(o.id));

    if (selectedOrders.length === 0) return;

    this.inwardItems = selectedOrders.map(ord => ({
      linked_order_id: ord.id,
      material_id: ord.material_id,
      quantity: parseFloat(ord.quantity_requested) || 1,
      rate: parseFloat(ord.price_suggested) || 0
    }));

    // Auto-fill supplier in form
    const firstVendor = selectedOrders[0].vendor_name;
    const suppInput = document.getElementById('inward-supplier');
    if (suppInput && firstVendor) {
      suppInput.value = firstVendor;
    }

    this.closeModal('modal-select-pending-orders');
    await this.renderInwardItems();

    alert(`Success! Loaded ${selectedOrders.length} pending order items for "${firstVendor || 'Vendor'}" into the inward form. Enter your Bill / Invoice Reference to proceed.`);
  }

  // Handle manual form submission for Inward
  async handleManualInwardSubmit(e) {
    e.preventDefault();

    const invoiceNo = (document.getElementById('inward-invoice') ? document.getElementById('inward-invoice').value.trim() : '');
    const inwardDate = (document.getElementById('inward-date') && document.getElementById('inward-date').value) || this.getTodayDate();
    const supplier = (document.getElementById('inward-supplier') ? document.getElementById('inward-supplier').value.trim() : '');

    if (!invoiceNo || !supplier) {
      alert("Bill / Invoice Reference and Supplier Name are required.");
      return;
    }

    if (!this.inwardItems || this.inwardItems.length === 0) {
      alert("Please add at least one material to inward.");
      return;
    }

    for (let i = 0; i < this.inwardItems.length; i++) {
      const it = this.inwardItems[i];
      if (!it.material_id) {
        alert(`Please select an order or material for Inward Item #${i + 1}.`);
        return;
      }
      if (!it.quantity || it.quantity <= 0) {
        alert(`Please enter a valid received quantity for Inward Item #${i + 1}.`);
        return;
      }
      if (!it.rate || it.rate <= 0) {
        alert(`Please enter a valid billed rate for Inward Item #${i + 1}.`);
        return;
      }
    }

    await this.processMultiInwardIngest(this.inwardItems, invoiceNo, inwardDate, supplier);

    document.getElementById('inward-manual-form').reset();
    this.inwardItems = [{ linked_order_id: '', material_id: '', quantity: 50, rate: 0 }];
    this.initDateInputs();
    await this.renderInwardPane();
  }

  // Read purchase invoice bill PDF or Image/Photo via pdf.js & Tesseract OCR
  async handleInwardUpload(file) {
    if (!file) return;

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|gif|bmp|webp)$/i.test(file.name);

    if (!isPdf && !isImage) {
      alert("Unsupported format. Please upload a PDF or an image (JPEG, PNG, GIF, BMP) or snap a photo with your camera.");
      return;
    }

    // Show loading indicator
    let loadingDiv = document.getElementById('inward-loading-spinner');
    if (!loadingDiv) {
      loadingDiv = document.createElement('div');
      loadingDiv.id = 'inward-loading-spinner';
      loadingDiv.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(2,6,23,0.88); z-index:9999; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#fff; backdrop-filter:blur(4px);';
      loadingDiv.innerHTML = `
        <div style="font-size:2.5rem; margin-bottom:1rem; color:var(--color-primary);"><i class="fa-solid fa-spinner fa-spin"></i></div>
        <div style="font-size:1.1rem; font-weight:600;" id="inward-spinner-text">Analyzing Bill...</div>
        <div style="font-size:0.8rem; color:#94a3b8; margin-top:0.35rem;">Extracting invoice details</div>
      `;
      document.body.appendChild(loadingDiv);
    } else {
      loadingDiv.style.display = 'flex';
      document.getElementById('inward-spinner-text').textContent = 'Analyzing Bill...';
    }

    try {
      let rawText = '';
      let imagePreviewUrl = null;

      if (isPdf) {
        document.getElementById('inward-spinner-text').textContent = 'Extracting PDF Text...';
        rawText = await this.parsePDFText(file);
      } else if (isImage) {
        document.getElementById('inward-spinner-text').textContent = 'Scanning Photo / Image (OCR)...';
        imagePreviewUrl = URL.createObjectURL(file);
        rawText = await this.parseImageText(file);
      }

      const extracted = this.heuristicsExtractPurchase(rawText);

      this.currentVerifyInwardItems = [{
        raw_text_name: extracted.raw_text_name,
        material_id: '',
        quantity: extracted.quantity,
        rate: extracted.rate,
        supplier: extracted.supplier
      }];

      // Populate review modal header
      document.getElementById('vi-invoice').value = extracted.invoice_no;
      const viDateEl = document.getElementById('vi-date');
      if (viDateEl) viDateEl.value = extracted.date || this.getTodayDate();

      // Show/Hide photo preview in review modal
      const imgPreviewContainer = document.getElementById('vi-image-preview-container');
      const imgPreview = document.getElementById('vi-image-preview');
      if (imgPreviewContainer && imgPreview) {
        if (imagePreviewUrl) {
          imgPreview.src = imagePreviewUrl;
          imgPreviewContainer.style.display = 'block';
        } else {
          imgPreviewContainer.style.display = 'none';
          imgPreview.src = '';
        }
      }

      // Populate associated PO groups dropdown in header
      const orderSelect = document.getElementById('vi-linked-order');
      if (orderSelect) {
        orderSelect.innerHTML = '<option value="">-- Auto-Match Orders by Item Name --</option>';
        const orders = await this.db.getOrders();
        const pendings = orders.filter(o => o.status === 'Pending');

        const grouped = {};
        pendings.forEach(o => {
          const k = o.order_group_id ? o.order_group_id : (o.vendor_name ? `Vendor: ${o.vendor_name}` : 'Pending');
          if (!grouped[k]) grouped[k] = [];
          grouped[k].push(o);
        });

        Object.keys(grouped).forEach(k => {
          const grp = grouped[k];
          const v = grp[0] ? (grp[0].vendor_name || 'Vendor') : 'Vendor';
          orderSelect.innerHTML += `<option value="${k}">PO: ${k} • ${v} (${grp.length} items)</option>`;
        });
      }

      await this.renderVerifyInwardTable();
      this.openModal('modal-verify-inward');
    } catch (e) {
      console.error(e);
      alert("Failed to analyze bill: " + e.message);
    } finally {
      if (loadingDiv) loadingDiv.style.display = 'none';
      const fileInput = document.getElementById('inward-file-input');
      if (fileInput) fileInput.value = '';
      const camInput = document.getElementById('inward-camera-input');
      if (camInput) camInput.value = '';
    }
  }

  toggleInvoicePhotoPreview() {
    const wrapper = document.getElementById('vi-image-wrapper');
    const btn = document.getElementById('vi-photo-toggle-btn');
    if (!wrapper) return;
    if (wrapper.style.display === 'none') {
      wrapper.style.display = 'block';
      if (btn) btn.textContent = 'Collapse';
    } else {
      wrapper.style.display = 'none';
      if (btn) btn.textContent = 'Show Photo';
    }
  }

  async applyOrderGroupToVerifyModal(groupId) {
    if (!groupId) return;
    const orders = await this.db.getOrders();
    const grpOrders = orders.filter(o => o.status === 'Pending' && (o.order_group_id === groupId || o.vendor_name === groupId));
    if (grpOrders.length === 0) return;

    this.currentVerifyInwardItems.forEach((item, idx) => {
      const match = grpOrders.find(o => o.material_id === item.material_id) || grpOrders[idx];
      if (match) {
        item.linked_order_id = match.id;
        if (!item.material_id && match.material_id) item.material_id = match.material_id;
        if (match.vendor_name) item.supplier = match.vendor_name;
      }
    });

    await this.renderVerifyInwardTable();
  }

  async renderVerifyInwardTable() {
    const tbody = document.getElementById('verify-inward-rows');
    if (!tbody) return;
    tbody.innerHTML = '';

    const materials = await this.db.getRawMaterials();
    const orders = await this.db.getOrders();
    const pendingOrders = orders.filter(o => o.status === 'Pending');

    this.currentVerifyInwardItems.forEach((item, index) => {
      const tr = document.createElement('tr');

      let matOptions = '<option value="" disabled selected>-- Match Material --</option>';
      materials.forEach(m => {
        const isMatched = item.material_id === m.id || (!item.material_id && item.raw_text_name && item.raw_text_name.toLowerCase().includes(m.name.toLowerCase()));
        if (isMatched && !item.material_id) item.material_id = m.id;
        const selected = isMatched ? 'selected' : '';
        matOptions += `<option value="${m.id}" ${selected}>${m.name} (${m.code})</option>`;
      });
      matOptions += `<option value="__NEW__" style="color:var(--color-primary); font-weight:bold;">➕ + Add New Raw Material...</option>`;

      // Construct individual order options for this specific line item
      let orderOptions = '<option value="">-- No Link (Direct Inward) --</option>';
      if (pendingOrders.length > 0) {
        // Auto-match order by material or text if not already linked
        if (!item.linked_order_id) {
          const autoMatched = pendingOrders.find(o => 
            (item.material_id && o.material_id === item.material_id) ||
            (item.raw_text_name && o.material_name && item.raw_text_name.toLowerCase().includes(o.material_name.toLowerCase()))
          );
          if (autoMatched) {
            item.linked_order_id = autoMatched.id;
          }
        }

        const grouped = {};
        pendingOrders.forEach(o => {
          const k = o.order_group_id ? `PO: ${o.order_group_id} • ${o.vendor_name || 'Vendor'}` : (o.vendor_name ? `Vendor: ${o.vendor_name}` : 'Pending Orders');
          if (!grouped[k]) grouped[k] = [];
          grouped[k].push(o);
        });

        Object.keys(grouped).forEach(k => {
          orderOptions += `<optgroup label="📋 ${k}">`;
          grouped[k].forEach(o => {
            const isSel = item.linked_order_id === o.id ? 'selected' : '';
            orderOptions += `<option value="${o.id}" ${isSel}>${o.material_name} (Req: ${o.quantity_requested})</option>`;
          });
          orderOptions += `</optgroup>`;
        });
      }

      const removeBtn = this.currentVerifyInwardItems.length > 1
        ? `<button type="button" class="multi-item-remove-btn" onclick="app.removeVerifyInwardRow(${index})"><i class="fa-solid fa-trash-can"></i></button>`
        : '';

      tr.innerHTML = `
        <td>
          <div class="td-bold" style="font-size:0.75rem; margin-bottom:0.2rem;">Extracted: "${item.raw_text_name || 'Line Item'}"</div>
          <select class="form-control" style="font-size:0.75rem; padding:0.25rem 0.4rem;" onchange="if(this.value==='__NEW__'){app.openAddMaterialModal('verify', ${index});}else{app.updateVerifyInwardItem(${index}, 'material_id', this.value);}">
            ${matOptions}
          </select>
        </td>
        <td>
          <select class="form-control" style="font-size:0.75rem; padding:0.25rem 0.35rem;" onchange="app.updateVerifyInwardItem(${index}, 'linked_order_id', this.value)">
            ${orderOptions}
          </select>
        </td>
        <td><input type="number" step="0.001" class="form-control" style="font-size:0.8rem; padding:0.25rem 0.35rem;" value="${item.quantity}" oninput="app.updateVerifyInwardItem(${index}, 'quantity', this.value)"></td>
        <td><input type="number" step="0.01" class="form-control" style="font-size:0.8rem; padding:0.25rem 0.35rem;" value="${item.rate}" oninput="app.updateVerifyInwardItem(${index}, 'rate', this.value)"></td>
        <td><input type="text" class="form-control" style="font-size:0.75rem; padding:0.25rem 0.35rem;" value="${item.supplier || ''}" oninput="app.updateVerifyInwardItem(${index}, 'supplier', this.value)"></td>
        <td style="text-align:center;">${removeBtn}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  addVerifyInwardRow() {
    this.currentVerifyInwardItems.push({
      raw_text_name: 'Manual Material Line',
      material_id: '',
      linked_order_id: '',
      quantity: 10,
      rate: 100,
      supplier: (this.currentVerifyInwardItems[0] ? this.currentVerifyInwardItems[0].supplier : '')
    });
    this.renderVerifyInwardTable();
  }

  removeVerifyInwardRow(idx) {
    if (this.currentVerifyInwardItems.length > 1) {
      this.currentVerifyInwardItems.splice(idx, 1);
      this.renderVerifyInwardTable();
    }
  }

  async updateVerifyInwardItem(index, key, val) {
    if (this.currentVerifyInwardItems[index]) {
      if (key === 'quantity' || key === 'rate') {
        this.currentVerifyInwardItems[index][key] = parseFloat(val) || 0;
      } else if (key === 'linked_order_id') {
        this.currentVerifyInwardItems[index].linked_order_id = val;
        if (val) {
          const orders = await this.db.getOrders();
          const ord = orders.find(o => o.id === val);
          if (ord) {
            if (ord.material_id && !this.currentVerifyInwardItems[index].material_id) {
              this.currentVerifyInwardItems[index].material_id = ord.material_id;
            }
            if (ord.vendor_name) {
              this.currentVerifyInwardItems[index].supplier = ord.vendor_name;
            }
          }
        }
      } else {
        this.currentVerifyInwardItems[index][key] = val;
      }
    }
  }

  // Commit verify purchase receipt and trigger crosscheck validations
  async commitVerifyInward() {
    const invoiceNo = document.getElementById('vi-invoice').value.trim();
    const inwardDate = (document.getElementById('vi-date') && document.getElementById('vi-date').value) || this.getTodayDate();

    if (!invoiceNo) {
      alert("Invoice Number is required.");
      return;
    }

    if (!this.currentVerifyInwardItems || this.currentVerifyInwardItems.length === 0) {
      alert("No line items to inward.");
      return;
    }

    const unmapped = this.currentVerifyInwardItems.find(i => !i.material_id || i.quantity <= 0 || i.rate <= 0);
    if (unmapped) {
      alert("Please map all raw materials and enter valid quantities and rates.");
      return;
    }

    const supplier = (this.currentVerifyInwardItems[0] && this.currentVerifyInwardItems[0].supplier) ? this.currentVerifyInwardItems[0].supplier : 'Supplier Dispatch';

    this.closeModal('modal-verify-inward');

    const formattedItems = this.currentVerifyInwardItems.map((item) => ({
      linked_order_id: item.linked_order_id || '',
      material_id: item.material_id,
      quantity: item.quantity,
      rate: item.rate,
      supplier: item.supplier || supplier
    }));

    await this.processMultiInwardIngest(formattedItems, invoiceNo, inwardDate, supplier);
  }

  // Multi-item Inward ingestion engine with cross-check variances
  async processMultiInwardIngest(items, invoiceNo, inwardDate, supplier) {
    const materials = await this.db.getRawMaterials();
    const orders = await this.db.getOrders();

    let totalBilled = 0;
    let varianceReportLines = '';
    let hasAnyVariance = false;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const mat = materials.find(m => m.id === it.material_id);
      const matName = mat ? mat.name : 'Raw Material';
      const unit = mat ? mat.unit : 'units';
      const itemSubtotal = (it.quantity || 0) * (it.rate || 0);
      totalBilled += itemSubtotal;

      let itemHasVariance = false;
      let itemVarianceNote = '';

      if (it.linked_order_id) {
        const ord = orders.find(o => o.id === it.linked_order_id);
        if (ord) {
          const qtyDiff = it.quantity - ord.quantity_requested;
          const rateDiff = it.rate - (ord.price_suggested || 0);

          const qtyMismatch = Math.abs(qtyDiff) > 0.001;
          const rateMismatch = Math.abs(rateDiff) > 0.01;

          if (qtyMismatch || rateMismatch) {
            itemHasVariance = true;
            hasAnyVariance = true;

            let issues = [];
            if (qtyMismatch) {
              issues.push(qtyDiff > 0 ? `Excess Qty: +${qtyDiff.toFixed(3)} ${unit}` : `Shortage Qty: ${qtyDiff.toFixed(3)} ${unit}`);
            }
            if (rateMismatch) {
              issues.push(rateDiff > 0 ? `Price Overcharge: +Rs. ${rateDiff.toFixed(2)}` : `Price Discount: -Rs. ${Math.abs(rateDiff).toFixed(2)}`);
            }
            itemVarianceNote = issues.join(', ');

            varianceReportLines += `${i + 1}. *${matName}*\n` +
                                   `   • Ordered: ${ord.quantity_requested} ${unit} @ Rs. ${(ord.price_suggested || 0).toFixed(2)}\n` +
                                   `   • Received: ${it.quantity} ${unit} @ Rs. ${it.rate.toFixed(2)}\n` +
                                   `   🔴 *Variance:* ${itemVarianceNote}\n\n`;
          } else {
            varianceReportLines += `${i + 1}. *${matName}*: ${it.quantity} ${unit} @ Rs. ${it.rate.toFixed(2)} (🟢 Matched Order)\n\n`;
          }
        }
      } else {
        varianceReportLines += `${i + 1}. *${matName}*: ${it.quantity} ${unit} @ Rs. ${it.rate.toFixed(2)} (Direct Inward)\n\n`;
      }

      await this.db.insertInward({
        date: inwardDate,
        invoice_no: invoiceNo,
        material_id: it.material_id,
        material_name: matName,
        quantity_received: it.quantity,
        rate_billed: it.rate,
        supplier: it.supplier || supplier,
        linked_order_id: it.linked_order_id || null,
        has_variance: itemHasVariance,
        variance_notes: itemVarianceNote
      });
    }

    // Formulate consolidated WhatsApp message
    const waHeader = hasAnyVariance
      ? `⚠️ *MFP ERP - Material Inward Variance Warning*\n`
      : `📋 *MFP ERP - Material Inward Confirmation*\n`;

    const waText = waHeader +
                   `• *Date:* ${inwardDate}\n` +
                   `• *Invoice / Bill No:* ${invoiceNo}\n` +
                   `• *Supplier / Vendor:* ${supplier}\n\n` +
                   `*Received Items (${items.length}):*\n` +
                   varianceReportLines +
                   `*Total Bill Value:* Rs. ${totalBilled.toLocaleString('en-IN', { minimumFractionDigits: 2 })}\n` +
                   `\n_Warehouse stocks updated & weighted average costs recalculated via Mobile Console._`;

    document.getElementById('inward-wa-text').value = waText;
    document.getElementById('inward-wa-widget').classList.remove('hidden');

    await this.refreshAllViews();
    alert(`Inward completed for ${items.length} material(s) on Bill ${invoiceNo}! Stock updated & WhatsApp alert ready.`);
  }


  // --- 2B. MATERIAL RETURNED (CREDIT NOTE / SALES RETURN) WORKFLOW ---

  switchInwardSubSection(tab) {
    this.inwardActiveSubTab = tab;
    const btnRaw = document.getElementById('btn-inward-raw');
    const btnReturn = document.getElementById('btn-inward-return');
    const secRaw = document.getElementById('inward-raw-section');
    const secReturn = document.getElementById('inward-return-section');

    if (tab === 'return') {
      if (btnRaw) btnRaw.classList.remove('active');
      if (btnReturn) btnReturn.classList.add('active');
      if (secRaw) secRaw.classList.add('hidden');
      if (secReturn) secReturn.classList.remove('hidden');
      this.renderReturnPane();
    } else {
      if (btnRaw) btnRaw.classList.add('active');
      if (btnReturn) btnReturn.classList.remove('active');
      if (secRaw) secRaw.classList.remove('hidden');
      if (secReturn) secReturn.classList.add('hidden');
      this.renderInwardItems();
    }
  }

  async renderReturnPane() {
    const products = await this.db.getProducts();
    if (!this.returnItems || this.returnItems.length === 0) {
      this.returnItems = [{
        product_id: (products[0] ? products[0].id : ''),
        quantity: 10,
        mfg_date: this.getTodayDate(),
        rate: (products[0] ? parseFloat(products[0].selling_price || 0) : 0),
        batch_no: ''
      }];
    }
    await this.renderReturnItems();
    await this.renderRecentReturnsList();
  }

  async addReturnItemRow() {
    const products = await this.db.getProducts();
    const defaultProd = products[0];
    this.returnItems.push({
      product_id: defaultProd ? defaultProd.id : '',
      quantity: 10,
      mfg_date: this.getTodayDate(),
      rate: defaultProd ? parseFloat(defaultProd.selling_price || 0) : 0,
      batch_no: ''
    });
    await this.renderReturnItems();
  }

  removeReturnItemRow(index) {
    if (this.returnItems.length > 1) {
      this.returnItems.splice(index, 1);
      this.renderReturnItems();
    }
  }

  async updateReturnItem(index, field, val) {
    if (!this.returnItems[index]) return;

    if (field === 'product_id') {
      this.returnItems[index].product_id = val;
      const products = await this.db.getProducts();
      const p = products.find(x => x.id === val);
      if (p && (!this.returnItems[index].rate || this.returnItems[index].rate === 0)) {
        this.returnItems[index].rate = parseFloat(p.selling_price || 0);
        const rateInput = document.getElementById(`return-item-rate-${index}`);
        if (rateInput) rateInput.value = this.returnItems[index].rate;
      }
    } else if (field === 'quantity') {
      this.returnItems[index].quantity = parseInt(val, 10) || 0;
    } else if (field === 'mfg_date') {
      this.returnItems[index].mfg_date = val;
    } else if (field === 'rate') {
      this.returnItems[index].rate = parseFloat(val) || 0;
    } else if (field === 'batch_no') {
      this.returnItems[index].batch_no = val.trim();
    }

    const totalPcs = this.returnItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
    const badge = document.getElementById('return-total-qty');
    if (badge) badge.textContent = `${totalPcs} pcs total`;

    const submitBtn = document.getElementById('return-submit-btn');
    if (submitBtn) {
      submitBtn.innerHTML = `<i class="fa-solid fa-rotate-left"></i> Restock Finished Goods from Credit Note (${totalPcs} pcs)`;
    }
  }

  async renderReturnItems() {
    const container = document.getElementById('return-items-container');
    if (!container) return;
    container.innerHTML = '';

    const products = await this.db.getProducts();
    const categories = ['Bottles', 'Pouches', 'Sachets', 'Horeca'];

    this.returnItems.forEach((item, index) => {
      const box = document.createElement('div');
      box.className = 'multi-item-box';
      box.style.borderLeft = '3px solid var(--color-warning)';

      let optionsHtml = '<option value="" disabled selected>-- Select Returned FG SKU --</option>';

      categories.forEach(cat => {
        const catProds = products.filter(p => p.packaging_type === cat);
        if (catProds.length > 0) {
          optionsHtml += `<optgroup label="📦 ${cat}">`;
          catProds.forEach(p => {
            const isSel = item.product_id === p.id ? 'selected' : '';
            optionsHtml += `<option value="${p.id}" ${isSel}>${p.name} (${p.code}) - Stock: ${parseFloat(p.current_stock || 0).toFixed(0)} pcs</option>`;
          });
          optionsHtml += `</optgroup>`;
        }
      });

      const otherProds = products.filter(p => !categories.includes(p.packaging_type));
      if (otherProds.length > 0) {
        optionsHtml += `<optgroup label="Other Finished Goods">`;
        otherProds.forEach(p => {
          const isSel = item.product_id === p.id ? 'selected' : '';
          optionsHtml += `<option value="${p.id}" ${isSel}>${p.name} (${p.code})</option>`;
        });
        optionsHtml += `</optgroup>`;
      }

      const removeBtnHtml = this.returnItems.length > 1
        ? `<button type="button" class="multi-item-remove-btn" onclick="app.removeReturnItemRow(${index})"><i class="fa-solid fa-trash-can"></i> Remove</button>`
        : '';

      box.innerHTML = `
        <div class="multi-item-header">
          <span style="color:var(--color-warning); font-weight:600;"><i class="fa-solid fa-bottle-water"></i> Returned SKU #${index + 1}</span>
          ${removeBtnHtml}
        </div>
        <div class="form-group" style="margin-bottom:0.45rem;">
          <label style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.2rem;">Finished Good Product (FG) *</label>
          <select class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" onchange="app.updateReturnItem(${index}, 'product_id', this.value)" required>
            ${optionsHtml}
          </select>
        </div>
        <div class="form-row" style="margin-bottom:0.35rem;">
          <div class="form-group" style="margin-bottom:0; flex:1;">
            <label style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.2rem;">Returned Qty (pcs) *</label>
            <input type="number" step="1" min="1" class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" value="${item.quantity || ''}" placeholder="Pieces" oninput="app.updateReturnItem(${index}, 'quantity', this.value)" required>
          </div>
          <div class="form-group" style="margin-bottom:0; flex:1.2;">
            <label style="font-size:0.7rem; color:#f59e0b; font-weight:600; margin-bottom:0.2rem;"><i class="fa-regular fa-calendar-check"></i> Mfd Date (Mfg Date) *</label>
            <input type="date" class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem; border-color: rgba(245, 158, 11, 0.4);" value="${item.mfg_date || this.getTodayDate()}" onchange="app.updateReturnItem(${index}, 'mfg_date', this.value)" required>
          </div>
        </div>
        <div class="form-row" style="margin-bottom:0.2rem;">
          <div class="form-group" style="margin-bottom:0; flex:1;">
            <label style="font-size:0.68rem; color:var(--text-muted); margin-bottom:0.15rem;">Batch / Lot No (Optional)</label>
            <input type="text" class="form-control" style="font-size:0.75rem; padding:0.3rem 0.45rem;" value="${item.batch_no || ''}" placeholder="e.g. B-2408" oninput="app.updateReturnItem(${index}, 'batch_no', this.value)">
          </div>
          <div class="form-group" style="margin-bottom:0; flex:1;">
            <label style="font-size:0.68rem; color:var(--text-muted); margin-bottom:0.15rem;">Credit Rate (Rs./pc)</label>
            <input type="number" step="0.01" min="0" id="return-item-rate-${index}" class="form-control" style="font-size:0.75rem; padding:0.3rem 0.45rem;" value="${item.rate || ''}" placeholder="Rs./unit" oninput="app.updateReturnItem(${index}, 'rate', this.value)">
          </div>
        </div>
      `;
      container.appendChild(box);
    });

    const totalPcs = this.returnItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
    const badge = document.getElementById('return-total-qty');
    if (badge) badge.textContent = `${totalPcs} pcs total`;

    const submitBtn = document.getElementById('return-submit-btn');
    if (submitBtn) {
      submitBtn.innerHTML = `<i class="fa-solid fa-rotate-left"></i> Restock Finished Goods from Credit Note (${totalPcs} pcs)`;
    }
  }

  async handleCreditNoteUpload(file) {
    if (!file) return;

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|gif|bmp|webp)$/i.test(file.name);

    if (!isPdf && !isImage) {
      alert("Unsupported format. Please upload a Credit Note PDF or photo/image.");
      return;
    }

    let loadingDiv = document.getElementById('inward-loading-spinner');
    if (loadingDiv) {
      loadingDiv.style.display = 'flex';
      document.getElementById('inward-spinner-text').textContent = 'Scanning Credit Note...';
    }

    try {
      let rawText = '';
      if (isPdf) {
        if (loadingDiv) document.getElementById('inward-spinner-text').textContent = 'Extracting Credit Note PDF...';
        rawText = await this.parsePDFText(file);
      } else {
        if (loadingDiv) document.getElementById('inward-spinner-text').textContent = 'Scanning Photo (OCR)...';
        rawText = await this.parseImageText(file);
      }

      // Regex heuristics for Credit Note
      const cnMatch = rawText.match(/(?:credit\s*note(?:\s*no\.?|\s*#)?|cr(?:\s*note)?|c\.?n\.?)\s*[:\s-]*([a-zA-Z0-9\/-]+)/i) ||
                      rawText.match(/(?:inv(?:oice)?|ref)\s*[:\s-]*([a-zA-Z0-9\/-]+)/i) ||
                      rawText.match(/(?:CN|CR)-[0-9-]+/i);
      if (cnMatch && document.getElementById('return-credit-note-no')) {
        document.getElementById('return-credit-note-no').value = cnMatch[1] ? cnMatch[1].trim() : cnMatch[0].trim();
      }

      const dateMatch = rawText.match(/(?:date|dt\.?)\s*[:\s-]*([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{2,4})/i) ||
                        rawText.match(/([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{4})/);
      if (dateMatch && document.getElementById('return-date')) {
        document.getElementById('return-date').value = this.formatDateToISO(dateMatch[1]);
      }

      const custMatch = rawText.match(/(?:customer|client|buyer|party|m\/s\.?|to)\s*[:\s-]*([a-zA-Z0-9\s.,&'-]{3,40})/i);
      if (custMatch && document.getElementById('return-customer')) {
        let name = custMatch[1].split('\n')[0].replace(/GSTIN.*$/i, '').trim();
        if (name) document.getElementById('return-customer').value = name;
      }

      // Match products in text
      const products = await this.db.getProducts();
      let matchedProds = [];
      products.forEach(p => {
        const pName = p.name.toLowerCase();
        const pCode = p.code.toLowerCase();
        if (rawText.toLowerCase().includes(pName) || rawText.toLowerCase().includes(pCode)) {
          matchedProds.push(p);
        }
      });

      if (matchedProds.length > 0) {
        this.returnItems = matchedProds.map(p => ({
          product_id: p.id,
          quantity: 10,
          mfg_date: this.getTodayDate(),
          rate: parseFloat(p.selling_price || 0),
          batch_no: ''
        }));
        await this.renderReturnItems();
      }

      alert("Credit Note scanned successfully! Please verify the details, adjust quantities, and confirm the Manufactured Dates.");
    } catch (e) {
      console.error(e);
      alert("Error parsing Credit Note: " + e.message);
    } finally {
      if (loadingDiv) loadingDiv.style.display = 'none';
      const fIn = document.getElementById('return-file-input');
      if (fIn) fIn.value = '';
      const cIn = document.getElementById('return-camera-input');
      if (cIn) cIn.value = '';
    }
  }

  async handleReturnSubmit(e) {
    e.preventDefault();

    const creditNoteNo = (document.getElementById('return-credit-note-no') ? document.getElementById('return-credit-note-no').value.trim() : '');
    const returnDate = (document.getElementById('return-date') && document.getElementById('return-date').value) || this.getTodayDate();
    const customer = (document.getElementById('return-customer') ? document.getElementById('return-customer').value.trim() : '');
    const reason = (document.getElementById('return-reason') ? document.getElementById('return-reason').value.trim() : '');

    if (!creditNoteNo || !customer) {
      alert("Please enter Credit Note Number and Customer / Client Name.");
      return;
    }

    if (!this.returnItems || this.returnItems.length === 0) {
      alert("Please add at least one Finished Good SKU to restock.");
      return;
    }

    for (let i = 0; i < this.returnItems.length; i++) {
      const it = this.returnItems[i];
      if (!it.product_id) {
        alert(`Please select a Finished Good product for Item #${i + 1}.`);
        return;
      }
      if (!it.quantity || it.quantity <= 0) {
        alert(`Please enter a valid returned quantity for Item #${i + 1}.`);
        return;
      }
      if (!it.mfg_date) {
        alert(`Please specify the Manufactured Date (Mfd Date) for Item #${i + 1}.`);
        return;
      }
    }

    const products = await this.db.getProducts();
    let totalPcs = 0;
    let itemsLogText = '';

    const returnPayload = {
      credit_note_no: creditNoteNo,
      date: returnDate,
      customer: customer,
      reason: reason,
      items: this.returnItems.map((it, idx) => {
        const prod = products.find(p => p.id === it.product_id);
        const prodName = prod ? prod.name : 'Finished Good';
        const prodCode = prod ? prod.code : '';
        totalPcs += it.quantity;

        itemsLogText += `${idx + 1}. *${prodName}* (${prodCode})\n` +
                        `   • Returned: *${it.quantity} pcs* (Restocked to FG)\n` +
                        `   • *Mfd Date:* ${it.mfg_date}${it.batch_no ? ' | Batch: ' + it.batch_no : ''}\n`;

        return {
          product_id: it.product_id,
          product_name: prodName,
          product_code: prodCode,
          quantity: it.quantity,
          mfg_date: it.mfg_date,
          batch_no: it.batch_no,
          rate: it.rate
        };
      })
    };

    // Commit to database & restock Finished Goods
    await this.db.insertMaterialReturn(returnPayload);

    // Compile WhatsApp Return Log
    const waText = `🔄 *MFP ERP - Material Returned (Credit Note Log)*\n` +
                   `• *Credit Note No:* ${creditNoteNo}\n` +
                   `• *Date:* ${returnDate}\n` +
                   `• *Customer:* ${customer}\n` +
                   (reason ? `• *Reason:* ${reason}\n` : '') +
                   `• *Total Finished Goods Restocked:* ${totalPcs} pcs across ${this.returnItems.length} SKU(s)\n\n` +
                   `*Restocked SKUs:*\n` +
                   itemsLogText +
                   `\n_Finished Goods warehouse inventory updated automatically. Logged via MFP Mobile Console._`;

    const waTextEl = document.getElementById('return-wa-text');
    const waWidget = document.getElementById('return-wa-widget');
    if (waTextEl && waWidget) {
      waTextEl.value = waText;
      waWidget.classList.remove('hidden');
    }

    const prevCount = this.returnItems.length;
    document.getElementById('return-manual-form').reset();
    this.returnItems = [{
      product_id: (products[0] ? products[0].id : ''),
      quantity: 10,
      mfg_date: this.getTodayDate(),
      rate: (products[0] ? parseFloat(products[0].selling_price || 0) : 0),
      batch_no: ''
    }];
    this.initDateInputs();

    await this.renderRecentReturnsList();
    await this.refreshAllViews();

    alert(`Success! Restocked ${totalPcs} pcs across ${prevCount} Finished Good SKU(s) into inventory under Credit Note ${creditNoteNo}!`);
  }

  async renderRecentReturnsList() {
    const list = document.getElementById('return-history-list');
    if (!list) return;

    const returns = await this.db.getReturns();
    if (returns.length === 0) {
      list.innerHTML = `<div class="td-muted italic text-center" style="padding:0.75rem;">No material returns logged yet.</div>`;
      return;
    }

    list.innerHTML = '';
    returns.slice(0, 10).forEach(ret => {
      const card = document.createElement('div');
      card.className = 'stock-cover-item';
      card.style.flexDirection = 'column';
      card.style.alignItems = 'stretch';
      card.style.gap = '0.3rem';

      let itemsSummary = '';
      if (ret.items && ret.items.length > 0) {
        ret.items.forEach(it => {
          itemsSummary += `<div style="font-size:0.75rem; color:var(--text-dim);">• <strong>${it.product_name || 'Product'}</strong>: ${it.quantity} pcs (Mfd: ${it.mfg_date || 'N/A'}${it.batch_no ? ' / ' + it.batch_no : ''})</div>`;
        });
      }

      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-weight:700; font-size:0.85rem; color:var(--color-warning);"><i class="fa-solid fa-file-invoice-dollar"></i> ${ret.credit_note_no}</span>
          <span class="badge" style="background:rgba(245, 158, 11, 0.15); color:#f59e0b; font-size:0.7rem;">${ret.date}</span>
        </div>
        <div style="font-size:0.78rem; font-weight:600;">Customer: ${ret.customer}</div>
        ${ret.reason ? `<div style="font-size:0.72rem; color:var(--text-muted); font-style:italic;">Reason: ${ret.reason}</div>` : ''}
        <div style="border-top:1px dashed var(--border-color); padding-top:0.3rem; margin-top:0.15rem;">
          ${itemsSummary}
        </div>
      `;
      list.appendChild(card);
    });
  }


  // --- 3. DAILY BATCH PRODUCTION RUNS WORKFLOW (MULTI-SKU) ---

  async renderProductionPane() {
    // Render Raw Materials checklist
    const materials = await this.db.getRawMaterials();
    const matContainer = document.getElementById('production-stock-container');
    if (matContainer) {
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
    }

    if (!this.productionItems || this.productionItems.length === 0) {
      const products = await this.db.getProducts();
      this.productionItems = [{ product_id: (products[0] ? products[0].id : ''), quantity: 50 }];
    }

    await this.renderProductionItems();
    await this.updateAggregatedRecipeChecklist();
  }

  switchProductionCategory(cat, btn) {
    this.currentProductionCategory = cat;
    
    document.querySelectorAll('.sub-tabs-bar .sub-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    this.renderProductionItems();
    this.updateAggregatedRecipeChecklist();
  }

  async addProductionSKURow() {
    const products = await this.db.getProducts();
    const filtered = this.currentProductionCategory === 'All' 
      ? products 
      : products.filter(p => p.packaging_type === this.currentProductionCategory);
    const defaultProd = filtered[0] || products[0];

    this.productionItems.push({
      product_id: defaultProd ? defaultProd.id : '',
      quantity: 50
    });

    await this.renderProductionItems();
    await this.updateAggregatedRecipeChecklist();
  }

  removeProductionSKURow(index) {
    if (this.productionItems.length > 1) {
      this.productionItems.splice(index, 1);
      this.renderProductionItems();
      this.updateAggregatedRecipeChecklist();
    }
  }

  updateProductionSKU(index, field, val) {
    if (!this.productionItems[index]) return;

    if (field === 'product_id') {
      this.productionItems[index].product_id = val;
    } else if (field === 'quantity') {
      this.productionItems[index].quantity = parseInt(val, 10) || 0;
    }

    const totalPcs = this.productionItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
    const totalQtyBadge = document.getElementById('production-total-qty');
    if (totalQtyBadge) {
      totalQtyBadge.textContent = `${totalPcs} pcs total`;
    }

    const submitBtn = document.getElementById('production-submit-btn');
    if (submitBtn) {
      submitBtn.innerHTML = `<i class="fa-solid fa-gears"></i> Record Daily Batch (${totalPcs} pcs across ${this.productionItems.length} SKUs)`;
    }

    this.updateAggregatedRecipeChecklist();
  }

  async renderProductionItems() {
    const container = document.getElementById('production-items-container');
    if (!container) return;
    container.innerHTML = '';

    const products = await this.db.getProducts();

    // Group products by packaging category
    const categories = ['Bottles', 'Pouches', 'Sachets', 'Horeca'];

    this.productionItems.forEach((item, index) => {
      const box = document.createElement('div');
      box.className = 'multi-item-box';

      let optionsHtml = '<option value="" disabled selected>-- Select Product SKU --</option>';

      categories.forEach(cat => {
        const catProds = products.filter(p => p.packaging_type === cat);
        if (catProds.length > 0) {
          optionsHtml += `<optgroup label="📦 ${cat}">`;
          catProds.forEach(p => {
            const isSel = item.product_id === p.id ? 'selected' : '';
            optionsHtml += `<option value="${p.id}" ${isSel}>${p.name} (${p.code})</option>`;
          });
          optionsHtml += `</optgroup>`;
        }
      });

      // Products without matching standard category
      const otherProds = products.filter(p => !categories.includes(p.packaging_type));
      if (otherProds.length > 0) {
        optionsHtml += `<optgroup label="Other Products">`;
        otherProds.forEach(p => {
          const isSel = item.product_id === p.id ? 'selected' : '';
          optionsHtml += `<option value="${p.id}" ${isSel}>${p.name} (${p.code})</option>`;
        });
        optionsHtml += `</optgroup>`;
      }

      const removeBtnHtml = this.productionItems.length > 1
        ? `<button type="button" class="multi-item-remove-btn" onclick="app.removeProductionSKURow(${index})"><i class="fa-solid fa-trash-can"></i> Remove</button>`
        : '';

      box.innerHTML = `
        <div class="multi-item-header">
          <span><i class="fa-solid fa-tag"></i> Finished Good SKU #${index + 1}</span>
          ${removeBtnHtml}
        </div>
        <div class="form-group" style="margin-bottom:0.45rem;">
          <select class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" onchange="app.updateProductionSKU(${index}, 'product_id', this.value)" required>
            ${optionsHtml}
          </select>
        </div>
        <div class="form-row" style="margin-bottom:0.25rem;">
          <div class="form-group" style="margin-bottom:0; flex:1;">
            <label style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.2rem;">Batch Qty (pcs) *</label>
            <input type="number" step="1" min="1" class="form-control" style="font-size:0.8rem; padding:0.35rem 0.5rem;" value="${item.quantity || ''}" placeholder="Pieces" oninput="app.updateProductionSKU(${index}, 'quantity', this.value)" required>
          </div>
        </div>
      `;
      container.appendChild(box);
    });

    const totalPcs = this.productionItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
    const totalQtyBadge = document.getElementById('production-total-qty');
    if (totalQtyBadge) {
      totalQtyBadge.textContent = `${totalPcs} pcs total`;
    }

    const submitBtn = document.getElementById('production-submit-btn');
    if (submitBtn) {
      submitBtn.innerHTML = `<i class="fa-solid fa-gears"></i> Record Daily Batch (${totalPcs} pcs across ${this.productionItems.length} SKUs)`;
    }
  }

  // Pre-production forecast: aggregates BOM raw materials across ALL active SKUs
  async updateAggregatedRecipeChecklist() {
    const list = document.getElementById('production-checklist');
    const statusEl = document.getElementById('production-checklist-status');
    if (!list) return;

    list.innerHTML = '';

    const products = await this.db.getProducts();
    const rawMaterials = await this.db.getRawMaterials();

    const aggregated = {}; // material_id -> total needed
    let validSkusCount = 0;

    this.productionItems.forEach(item => {
      if (!item.product_id || !item.quantity || item.quantity <= 0) return;
      const prod = products.find(p => p.id === item.product_id);
      if (!prod || !prod.bom || prod.bom.length === 0) return;

      validSkusCount++;
      const batchQty = parseFloat(item.quantity) || 0;

      prod.bom.forEach(recipe => {
        const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage || 0) / 100);
        const needed = parseFloat(recipe.quantity) * batchQty * wasteFactor;
        aggregated[recipe.material_id] = (aggregated[recipe.material_id] || 0) + needed;
      });
    });

    const matIds = Object.keys(aggregated);

    if (matIds.length === 0) {
      list.innerHTML = `<span class="td-muted italic">Add Finished Good SKUs and quantities above to forecast ingredient covers.</span>`;
      if (statusEl) statusEl.textContent = '0 SKUs evaluated';
      return;
    }

    let hasShortage = false;
    let deficitCount = 0;

    matIds.forEach(matId => {
      const mat = rawMaterials.find(m => m.id === matId);
      const name = mat ? mat.name : 'Unknown Ingredient';
      const unit = mat ? mat.unit : 'units';
      const available = mat ? parseFloat(mat.current_stock || 0) : 0;
      const totalNeeded = aggregated[matId];
      const isShort = totalNeeded > available;

      if (isShort) {
        hasShortage = true;
        deficitCount++;
      }

      const itemDiv = document.createElement('div');
      itemDiv.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:0.25rem 0.35rem; border-radius:4px; font-size:0.75rem;';
      itemDiv.style.backgroundColor = isShort ? 'rgba(239, 68, 68, 0.08)' : 'rgba(16, 185, 129, 0.05)';
      itemDiv.style.color = isShort ? 'var(--color-danger)' : 'var(--color-success)';

      itemDiv.innerHTML = `
        <div>
          <strong>• ${name}</strong>: 
          <span>${totalNeeded.toFixed(3)} ${unit} needed</span>
        </div>
        <div style="text-align:right;">
          <span style="color:var(--text-muted); font-size:0.7rem;">(Avail: ${available.toFixed(3)} ${unit})</span>
          ${isShort ? '<strong style="color:var(--color-danger); margin-left:0.25rem;">⚠️ Deficit</strong>' : '<strong style="color:var(--color-success); margin-left:0.25rem;">✓ OK</strong>'}
        </div>
      `;
      list.appendChild(itemDiv);
    });

    if (statusEl) {
      statusEl.textContent = hasShortage 
        ? `⚠️ ${deficitCount} Ingredient Shortage(s)` 
        : `✓ All ${matIds.length} Ingredients in Stock`;
      statusEl.style.color = hasShortage ? 'var(--color-danger)' : 'var(--color-success)';
    }
  }

  async handleProductionSubmit(e) {
    e.preventDefault();

    const prodDate = (document.getElementById('production-date') && document.getElementById('production-date').value) || this.getTodayDate();
    const batchRef = (document.getElementById('production-batch-ref') ? document.getElementById('production-batch-ref').value.trim() : '');

    if (!this.productionItems || this.productionItems.length === 0) {
      alert("Please add at least one Finished Good SKU to the production batch.");
      return;
    }

    // Validate all items
    for (let i = 0; i < this.productionItems.length; i++) {
      const it = this.productionItems[i];
      if (!it.product_id) {
        alert(`Please select a Finished Good SKU for Item #${i + 1}.`);
        return;
      }
      if (!it.quantity || it.quantity <= 0) {
        alert(`Please specify a valid batch quantity for Item #${i + 1}.`);
        return;
      }
    }

    const products = await this.db.getProducts();
    const rawMaterials = await this.db.getRawMaterials();

    // Check aggregated ingredient deficits
    const aggregated = {};
    this.productionItems.forEach(item => {
      const prod = products.find(p => p.id === item.product_id);
      if (!prod || !prod.bom) return;
      const batchQty = parseFloat(item.quantity) || 0;
      prod.bom.forEach(recipe => {
        const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage || 0) / 100);
        const needed = parseFloat(recipe.quantity) * batchQty * wasteFactor;
        aggregated[recipe.material_id] = (aggregated[recipe.material_id] || 0) + needed;
      });
    });

    let deficitStr = '';
    Object.keys(aggregated).forEach(matId => {
      const mat = rawMaterials.find(m => m.id === matId);
      const name = mat ? mat.name : 'Unknown';
      const available = mat ? parseFloat(mat.current_stock || 0) : 0;
      const needed = aggregated[matId];
      if (needed > available) {
        deficitStr += `• Material "${name}": Warehouse has ${available.toFixed(3)}, but batch requires ${needed.toFixed(3)}.\n`;
      }
    });

    if (deficitStr) {
      const proceed = confirm(`Warning: Deficit detected in ingredients for this combined batch!\n\n${deficitStr}\nDo you wish to proceed and allow negative warehouse stock balance?`);
      if (!proceed) return;
    }

    let itemsTextList = '';
    let totalBatchPcs = 0;

    // Commit each production run SKU
    for (let i = 0; i < this.productionItems.length; i++) {
      const it = this.productionItems[i];
      const prod = products.find(p => p.id === it.product_id);
      if (prod) {
        totalBatchPcs += it.quantity;

        await this.db.insertProduction({
          date: prodDate,
          batch_ref: batchRef || undefined,
          product_id: prod.id,
          product_name: prod.name,
          quantity_produced: it.quantity,
          packaging_type: prod.packaging_type
        });

        itemsTextList += `${i + 1}. *${prod.name}* (${prod.code})\n` +
                         `   • Output: *${it.quantity} pcs* (${prod.packaging_type})\n`;
      }
    }

    // Compile WhatsApp Production Log
    const waText = `🏭 *MFP ERP - Daily Production Run Log*\n` +
                   `• *Date:* ${prodDate}\n` +
                   (batchRef ? `• *Batch / Shift:* ${batchRef}\n` : '') +
                   `• *Total Finished Goods Output:* ${totalBatchPcs} pcs across ${this.productionItems.length} SKUs\n\n` +
                   `*Manufactured SKUs:*\n` +
                   itemsTextList +
                   `\n_Raw materials deducted based on BOM recipes & Finished Goods warehouse updated. Logged via MFP Mobile Console._`;

    document.getElementById('production-wa-text').value = waText;
    document.getElementById('production-wa-widget').classList.remove('hidden');

    const prevCount = this.productionItems.length;
    document.getElementById('production-form').reset();
    this.productionItems = [{ product_id: (products[0] ? products[0].id : ''), quantity: 50 }];
    this.initDateInputs();

    await this.refreshAllViews();
    alert(`Success! Recorded daily batch of ${totalBatchPcs} pcs across ${prevCount} SKU(s) on ${prodDate}! Stocks updated & WhatsApp report compiled.`);
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

  // --- SALE OUTWARD DISPATCH: PDF INVOICE PARSING & BATCH PROCESSING ---

  async handleOutwardUpload(file) {
    if (file) {
      await this.handleOutwardUploadMultiple([file]);
    }
  }

  async handleOutwardUploadMultiple(fileList) {
    if (!fileList || fileList.length === 0) return;

    const files = Array.from(fileList).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) {
      alert("Please select one or more PDF sales invoice files.");
      return;
    }

    this.batchOutwardInvoices = [];
    this.activeBatchOutwardIdx = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const rawText = await this.parsePDFText(file);
        const extracted = this.heuristicsExtractSale(rawText, file.name);
        this.batchOutwardInvoices.push({
          fileName: file.name,
          invoice_no: extracted.invoice_no,
          date: extracted.date,
          customer: extracted.customer || 'Krishna Enterprises',
          gstin: extracted.gstin || '',
          net_amount: extracted.net_amount || 0,
          products: extracted.products
        });
      } catch (e) {
        console.error("Error parsing sales invoice PDF: " + file.name, e);
      }
    }

    if (this.batchOutwardInvoices.length === 0) {
      alert("Could not extract sales invoice details from the selected PDF(s). Please verify the file format.");
      return;
    }

    this.renderBatchOutwardModal();
  }

  renderBatchOutwardModal() {
    if (!this.batchOutwardInvoices || this.batchOutwardInvoices.length === 0) {
      this.closeModal('modal-verify-outward');
      return;
    }

    if (this.activeBatchOutwardIdx >= this.batchOutwardInvoices.length) {
      this.activeBatchOutwardIdx = this.batchOutwardInvoices.length - 1;
    }
    if (this.activeBatchOutwardIdx < 0) {
      this.activeBatchOutwardIdx = 0;
    }

    const cur = this.batchOutwardInvoices[this.activeBatchOutwardIdx];
    const isBatch = this.batchOutwardInvoices.length > 1;

    const titleEl = document.getElementById('vo-modal-title');
    if (titleEl) {
      titleEl.textContent = isBatch 
        ? `Review Sales Invoices (Batch: ${this.batchOutwardInvoices.length} Invoices)` 
        : `Review Outward Sales Dispatch`;
    }

    const batchNav = document.getElementById('vo-batch-nav');
    const batchTabs = document.getElementById('vo-batch-tabs');
    const batchBadge = document.getElementById('vo-batch-badge');
    const commitAllBtn = document.getElementById('vo-commit-all-btn');
    const discardBtn = document.getElementById('vo-discard-btn');

    if (batchNav) {
      if (isBatch) {
        batchNav.style.display = 'flex';
        if (batchBadge) batchBadge.innerHTML = `<i class="fa-solid fa-layer-group"></i> Batch (${this.activeBatchOutwardIdx + 1}/${this.batchOutwardInvoices.length})`;
        if (commitAllBtn) {
          commitAllBtn.innerHTML = `<i class="fa-solid fa-check-double"></i> Commit All (${this.batchOutwardInvoices.length}) Invoices`;
        }
        if (discardBtn) discardBtn.style.display = 'inline-block';

        if (batchTabs) {
          batchTabs.innerHTML = '';
          this.batchOutwardInvoices.forEach((inv, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `btn btn-sm ${idx === this.activeBatchOutwardIdx ? 'btn-primary' : 'btn-secondary'}`;
            btn.style.fontSize = '0.72rem';
            btn.style.padding = '0.2rem 0.45rem';
            btn.style.whiteSpace = 'nowrap';
            const label = inv.invoice_no || `Inv ${idx + 1}`;
            btn.innerHTML = `${idx + 1}. <strong>${label}</strong> (${inv.products.length})`;
            btn.onclick = () => this.switchBatchOutwardIdx(idx);
            batchTabs.appendChild(btn);
          });
        }
      } else {
        batchNav.style.display = 'none';
        if (discardBtn) discardBtn.style.display = 'none';
      }
    }

    const invEl = document.getElementById('vo-invoice');
    if (invEl) invEl.value = cur.invoice_no || '';

    const dateEl = document.getElementById('vo-date');
    if (dateEl) dateEl.value = cur.date || this.getTodayDate();

    const custEl = document.getElementById('vo-customer');
    if (custEl) custEl.value = cur.customer || '';

    const netEl = document.getElementById('vo-net-amount');
    if (netEl) netEl.innerHTML = `<i class="fa-solid fa-receipt"></i> Net Amount: Rs. ${(cur.net_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

    const countEl = document.getElementById('vo-item-count');
    if (countEl) countEl.textContent = `${cur.products.length} line item(s)`;

    this.currentVerifyOutwardItems = cur.products;
    this.renderVerifyOutwardRows();
    this.openModal('modal-verify-outward');
  }

  switchBatchOutwardIdx(idx) {
    if (this.batchOutwardInvoices && this.batchOutwardInvoices[this.activeBatchOutwardIdx]) {
      const invEl = document.getElementById('vo-invoice');
      if (invEl) this.batchOutwardInvoices[this.activeBatchOutwardIdx].invoice_no = invEl.value.trim();
      const dateEl = document.getElementById('vo-date');
      if (dateEl) this.batchOutwardInvoices[this.activeBatchOutwardIdx].date = dateEl.value;
      const custEl = document.getElementById('vo-customer');
      if (custEl) this.batchOutwardInvoices[this.activeBatchOutwardIdx].customer = custEl.value.trim();
    }
    this.activeBatchOutwardIdx = idx;
    this.renderBatchOutwardModal();
  }

  discardActiveOutwardBatch() {
    if (!this.batchOutwardInvoices || this.batchOutwardInvoices.length === 0) return;
    const discarded = this.batchOutwardInvoices[this.activeBatchOutwardIdx];
    if (!confirm(`Discard invoice ${discarded.invoice_no || ''} from current queue?`)) return;

    this.batchOutwardInvoices.splice(this.activeBatchOutwardIdx, 1);
    if (this.batchOutwardInvoices.length === 0) {
      this.closeModal('modal-verify-outward');
    } else {
      if (this.activeBatchOutwardIdx >= this.batchOutwardInvoices.length) {
        this.activeBatchOutwardIdx = this.batchOutwardInvoices.length - 1;
      }
      this.renderBatchOutwardModal();
    }
  }

  updateActiveBatchOutwardHeader(field, val) {
    if (this.batchOutwardInvoices && this.batchOutwardInvoices[this.activeBatchOutwardIdx]) {
      this.batchOutwardInvoices[this.activeBatchOutwardIdx][field] = val.trim();
    }
  }

  async renderVerifyOutwardRows() {
    const tbody = document.getElementById('verify-outward-rows');
    if (!tbody) return;
    tbody.innerHTML = '';

    const products = await this.db.getProducts();

    this.currentVerifyOutwardItems.forEach((item, index) => {
      const tr = document.createElement('tr');

      let pOptions = '<option value="" disabled selected>-- Select FG SKU --</option>';
      products.forEach(p => {
        const selected = item.product_id === p.id ? 'selected' : '';
        pOptions += `<option value="${p.id}" ${selected}>${p.name} (${p.code})</option>`;
      });

      const lineTotal = item.amount !== undefined ? item.amount : ((item.quantity_sold || 0) * Math.max(0, (item.rate || 0) - (item.discount || 0)));

      tr.innerHTML = `
        <td>
          <div class="td-bold" style="font-size:0.75rem; word-break:break-word;" title="${item.raw_text_name}">
            ${item.hsn ? `<span style="font-family:monospace; color:var(--text-muted); font-size:0.7rem;">[${item.hsn}]</span> ` : ''}${item.raw_text_name}
          </div>
          <select class="form-control" style="font-size:0.75rem; padding: 0.25rem 0.4rem; margin-top:0.25rem;" onchange="app.updateVerifyOutwardItem(${index}, 'product_id', this.value)">
            ${pOptions}
          </select>
        </td>
        <td>
          <input type="number" class="form-control" style="font-size:0.8rem; padding:0.25rem 0.35rem; width:100%;" value="${item.quantity_sold}" oninput="app.updateVerifyOutwardItem(${index}, 'quantity_sold', this.value)">
        </td>
        <td>
          <input type="number" step="0.01" class="form-control" style="font-size:0.8rem; padding:0.25rem 0.35rem; width:100%;" value="${item.rate}" oninput="app.updateVerifyOutwardItem(${index}, 'rate', this.value)">
        </td>
        <td>
          <input type="number" step="0.01" class="form-control" style="font-size:0.8rem; padding:0.25rem 0.35rem; width:100%;" value="${item.discount || 0}" oninput="app.updateVerifyOutwardItem(${index}, 'discount', this.value)">
        </td>
        <td style="font-size:0.8rem; font-weight:600; text-align:right; white-space:nowrap; vertical-align:middle;" id="vo-line-total-${index}">
          Rs. ${lineTotal.toFixed(2)}
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  updateVerifyOutwardItem(index, key, val) {
    if (this.currentVerifyOutwardItems[index]) {
      if (key === 'product_id') {
        this.currentVerifyOutwardItems[index].product_id = val;
      } else if (key === 'rate') {
        this.currentVerifyOutwardItems[index].rate = parseFloat(val) || 0;
      } else if (key === 'discount') {
        this.currentVerifyOutwardItems[index].discount = parseFloat(val) || 0;
      } else {
        this.currentVerifyOutwardItems[index].quantity_sold = parseInt(val, 10) || 0;
      }

      // Recompute line total
      const item = this.currentVerifyOutwardItems[index];
      item.amount = (item.quantity_sold || 0) * Math.max(0, (item.rate || 0) - (item.discount || 0));
      const totalEl = document.getElementById(`vo-line-total-${index}`);
      if (totalEl) totalEl.textContent = `Rs. ${item.amount.toFixed(2)}`;
    }
  }

  async commitVerifyOutward() {
    const invoiceNo = (document.getElementById('vo-invoice') ? document.getElementById('vo-invoice').value.trim() : '');
    const outwardDate = (document.getElementById('vo-date') && document.getElementById('vo-date').value) || this.getTodayDate();
    const customer = (document.getElementById('vo-customer') ? document.getElementById('vo-customer').value.trim() : '');

    if (!invoiceNo || !customer) {
      alert("Invoice No and Customer Name are required.");
      return;
    }

    if (!this.currentVerifyOutwardItems || this.currentVerifyOutwardItems.length === 0) {
      alert("No line items to dispatch.");
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

    for (const item of this.currentVerifyOutwardItems) {
      const p = products.find(prod => prod.id === item.product_id);
      if (p) {
        await this.db.insertOutward({
          date: outwardDate,
          invoice_no: invoiceNo,
          product_id: item.product_id,
          product_name: p.name,
          quantity_dispatched: item.quantity_sold,
          price_billed: item.rate || p.selling_price || 0,
          customer
        });
      }
    }

    await this.refreshAllViews();

    // Advance batch queue if in batch mode
    if (this.batchOutwardInvoices && this.batchOutwardInvoices.length > 1) {
      this.batchOutwardInvoices.splice(this.activeBatchOutwardIdx, 1);
      if (this.activeBatchOutwardIdx >= this.batchOutwardInvoices.length) {
        this.activeBatchOutwardIdx = this.batchOutwardInvoices.length - 1;
      }
      alert(`Invoice ${invoiceNo} committed successfully! Shipped quantities deducted from Finished Goods warehouse.\n\n${this.batchOutwardInvoices.length} invoice(s) remaining in batch.`);
      this.renderBatchOutwardModal();
    } else {
      this.batchOutwardInvoices = [];
      this.closeModal('modal-verify-outward');
      alert(`Invoice ${invoiceNo} committed for ${outwardDate}! Shipped quantities deducted from Finished Goods available.`);
    }
  }

  async commitAllBatchOutward() {
    if (!this.batchOutwardInvoices || this.batchOutwardInvoices.length === 0) return;

    // Save current active edits
    if (this.batchOutwardInvoices[this.activeBatchOutwardIdx]) {
      const invEl = document.getElementById('vo-invoice');
      if (invEl) this.batchOutwardInvoices[this.activeBatchOutwardIdx].invoice_no = invEl.value.trim();
      const dateEl = document.getElementById('vo-date');
      if (dateEl) this.batchOutwardInvoices[this.activeBatchOutwardIdx].date = dateEl.value;
      const custEl = document.getElementById('vo-customer');
      if (custEl) this.batchOutwardInvoices[this.activeBatchOutwardIdx].customer = custEl.value.trim();
    }

    // Validate all invoices have required headers & product mappings
    for (let i = 0; i < this.batchOutwardInvoices.length; i++) {
      const inv = this.batchOutwardInvoices[i];
      if (!inv.invoice_no) {
        alert(`Invoice #${i + 1} is missing an Invoice Number. Please inspect it.`);
        this.switchBatchOutwardIdx(i);
        return;
      }
      const unmapped = inv.products.find(p => !p.product_id);
      if (unmapped) {
        alert(`Invoice "${inv.invoice_no}" has unmapped item "${unmapped.raw_text_name}". Please map it before committing batch.`);
        this.switchBatchOutwardIdx(i);
        return;
      }
    }

    const totalInvoices = this.batchOutwardInvoices.length;
    let totalLines = 0;
    const products = await this.db.getProducts();

    for (const inv of this.batchOutwardInvoices) {
      for (const item of inv.products) {
        const p = products.find(prod => prod.id === item.product_id);
        if (p) {
          await this.db.insertOutward({
            date: inv.date || this.getTodayDate(),
            invoice_no: inv.invoice_no,
            product_id: item.product_id,
            product_name: p.name,
            quantity_dispatched: item.quantity_sold,
            price_billed: item.rate || p.selling_price || 0,
            customer: inv.customer || 'Customer Dispatch'
          });
          totalLines++;
        }
      }
    }

    this.batchOutwardInvoices = [];
    this.closeModal('modal-verify-outward');
    await this.refreshAllViews();

    alert(`Batch Commit Successful!\n\nAll ${totalInvoices} sales invoices (${totalLines} total product dispatches) have been recorded and deducted from Finished Goods warehouse.`);
  }

  async handleManualOutwardSubmit(e) {
    e.preventDefault();

    const invoiceNo = document.getElementById('outward-invoice').value.trim();
    const outwardDate = (document.getElementById('outward-date') && document.getElementById('outward-date').value) || this.getTodayDate();
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
      date: outwardDate,
      invoice_no: invoiceNo,
      product_id: pId,
      product_name: prod.name,
      quantity_dispatched: qty,
      price_billed: price,
      customer
    });

    document.getElementById('outward-manual-form').reset();
    this.initDateInputs();
    await this.refreshAllViews();
    alert(`Dispatch committed for ${outwardDate}! Reduced stock cover for ${prod.name}.`);
  }


  // --- PARSERS & TEXT EXTRACTORS ---

  // Document Text Parsers (Enhanced Layout-Aware Line Reconstructor)
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
            
            // Group text items by vertical row (tolerance ~3.5px)
            const linesByY = {};
            for (const item of textContent.items) {
              if (!item || !item.str) continue;
              const y = item.transform ? item.transform[5] : 0;
              const roundedY = Math.round(y / 3.5) * 3.5;
              if (!linesByY[roundedY]) linesByY[roundedY] = [];
              linesByY[roundedY].push(item);
            }

            // Sort lines descending (from top of page down)
            const sortedY = Object.keys(linesByY).map(Number).sort((a, b) => b - a);

            for (const y of sortedY) {
              const rowItems = linesByY[y];
              // Sort items left-to-right by X coordinate
              rowItems.sort((a, b) => (a.transform ? a.transform[4] : 0) - (b.transform ? b.transform[4] : 0));
              let rowText = '';
              for (const it of rowItems) {
                rowText += it.str + ' ';
              }
              if (rowText.trim()) {
                fullText += rowText.trim() + '\n';
              }
            }
            fullText += '\n'; // Page separator
          }
          resolve(fullText);
        } catch (e) {
          reject(e);
        }
      };
      fileReader.onerror = function() {
        reject(new Error("File reading error."));
      };
      fileReader.readAsArrayBuffer(file);
    });
  }

  async parseImageText(file) {
    if (typeof Tesseract !== 'undefined' && Tesseract.recognize) {
      try {
        const spinnerText = document.getElementById('inward-spinner-text');
        const { data: { text } } = await Tesseract.recognize(file, 'eng', {
          logger: (m) => {
            if (m.status === 'recognizing text' && m.progress && spinnerText) {
              spinnerText.textContent = `Scanning OCR (${Math.round(m.progress * 100)}%)...`;
            }
          }
        });
        return text || '';
      } catch (err) {
        console.warn("Tesseract OCR warning:", err);
      }
    }
    return '';
  }

  heuristicsExtractPurchase(text) {
    const result = {
      invoice_no: 'PUR-' + Math.floor(1000 + Math.random() * 9000),
      date: this.getTodayDate(),
      raw_text_name: 'Raw Dried Red Chilli',
      quantity: 50.00,
      rate: 180.00,
      supplier: 'Agro Supplies Ltd'
    };

    if (!text) return result;

    // Try finding date in YYYY-MM-DD or DD/MM/YYYY or DD-MM-YYYY
    const dateMatch = text.match(/\b(20\d\d[-/.](?:0[1-9]|1[0-2])[-/.](?:0[1-9]|[12]\d|3[01]))\b/) ||
                      text.match(/\b((?:0[1-9]|[12]\d|3[01])[-/.](?:0[1-9]|1[0-2])[-/.]20\d\d)\b/);
    if (dateMatch) {
      const rawDate = dateMatch[1].replace(/[/.]/g, '-');
      const parts = rawDate.split('-');
      if (parts[0].length === 4) {
        result.date = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      } else if (parts[2].length === 4) {
        result.date = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }
    }

    // Try finding invoice number
    const invMatch = text.match(/(?:inv(?:oice)?|bill|ref)[\s#.:-]*([A-Za-z0-9\-_/]+)/i);
    if (invMatch && invMatch[1].length >= 3) {
      result.invoice_no = invMatch[1].trim();
    }

    // Extractor triggers for quantity and rate
    const numMatches = text.match(/\b\d+(?:\.\d+)?\b/g);
    if (numMatches && numMatches.length >= 2) {
      const nums = numMatches.map(n => parseFloat(n)).filter(n => n > 0 && n < 1000000);
      if (nums.length >= 2) {
        result.quantity = nums[0];
        result.rate = nums[1];
      }
    }
    return result;
  }

  heuristicsExtractSale(text, fileName = '') {
    const result = {
      invoice_no: '',
      date: '',
      customer: '',
      gstin: '',
      net_amount: 0,
      products: []
    };

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // 1. EXTRACT INVOICE NUMBER
    // Check standard MFP prefix (e.g., MFP-26-68, MFP-PI-26-01, MFP-26-44)
    const mfpMatch = text.match(/\b(MFP(?:-[A-Za-z0-9]+)?-\d+-\d+)\b/i);
    if (mfpMatch) {
      result.invoice_no = mfpMatch[1].toUpperCase();
    } else {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/(?:invoice\s*(?:no\.?|number|#)|inv\s*no\.?)\s*[:\-#]?\s*([A-Za-z0-9\-_/]+)/i);
        if (match && match[1] && !/^(morella|date|dated)$/i.test(match[1])) {
          result.invoice_no = match[1];
          break;
        }
        if (/^invoice\s*no\.?$/i.test(line) && i + 1 < lines.length) {
          result.invoice_no = lines[i + 1].trim();
          break;
        }
      }
    }

    if (!result.invoice_no) {
      const fnMatch = fileName.match(/(MFP[A-Za-z0-9\-_]+)/i) || fileName.match(/(INV[A-Za-z0-9\-_]+)/i);
      result.invoice_no = fnMatch ? fnMatch[1] : ('SAL-' + Math.floor(1000 + Math.random() * 9000));
    }

    // 2. EXTRACT DATE
    const dateMatch = text.match(/(?:dated|date|invoice\s*date)\s*[:\-]?\s*(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/i) ||
                      text.match(/(\d{2}[-\/.]\d{2}[-\/.]\d{4})/);
    if (dateMatch) {
      result.date = this.formatDateToISO(dateMatch[1]);
    } else {
      result.date = this.getTodayDate();
    }

    // 3. EXTRACT BUYER / RECIPIENT / CUSTOMER
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/buyer\s*\/?\s*recipient/i.test(line) || /billed\s*to/i.test(line) || /bill\s*to/i.test(line)) {
        if (i + 1 < lines.length) {
          let custLine = lines[i + 1].trim();
          if (custLine.toLowerCase().includes('delivery address')) {
            custLine = custLine.split(/delivery address/i)[0].trim();
          }
          if (custLine) {
            result.customer = custLine;
            break;
          }
        }
      }
    }

    // GSTIN
    const gstinMatch = text.match(/gstin\s*[:\-]?\s*([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})/i);
    if (gstinMatch) result.gstin = gstinMatch[1];

    // Net Amount
    const netMatch = text.match(/net\s*amount\s*(?:\(rs\.?\))?\s*[:\-]?\s*([0-9,]+(?:\.\d{2})?)/i) ||
                     text.match(/grand\s*total\s*[:\-]?\s*([0-9,]+(?:\.\d{2})?)/i);
    if (netMatch) {
      result.net_amount = parseFloat(netMatch[1].replace(/,/g, '')) || 0;
    }

    // 4. EXTRACT LINE ITEMS TABLE
    const ignoredHeader = /^(hsn\s*code|description|terms|bank|branch|authorised|amount\s*in\s*words|cgst|sgst|round\s*off|net\s*amount|total|beneficiary|a\/c|ifsc)/i;

    lines.forEach(line => {
      if (ignoredHeader.test(line)) return;

      // Pattern 1: Starts with HSN Code (6-8 digits)
      // e.g. "21039040 truFLAVR Oregano Pizza Seasoning 10 gms Pouch 5% 1000 5.79 0.58 130.28 130.28 5211.00"
      const hsnLineMatch = line.match(/^(\d{6,8})\s+(.+?)\s+(\d+(?:\.\d+)?%)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?(?:\s+(\d+(?:\.\d+)?))?(?:\s+(\d+(?:\.\d+)?))?\s+(\d+(?:\.\d+)?)$/);
      if (hsnLineMatch) {
        const hsn = hsnLineMatch[1];
        const desc = hsnLineMatch[2].trim();
        const qty = parseFloat(hsnLineMatch[4]) || 1;
        const rate = parseFloat(hsnLineMatch[5]) || 0;
        const disc = hsnLineMatch[6] ? parseFloat(hsnLineMatch[6]) : 0;
        const amt = parseFloat(hsnLineMatch[9]) || (qty * Math.max(0, rate - disc));

        const mappedId = this.autoMapProduct(desc);
        result.products.push({
          raw_text_name: desc,
          hsn: hsn,
          product_id: mappedId,
          quantity_sold: Math.round(qty),
          rate: rate,
          discount: disc,
          amount: amt
        });
        return;
      }

      // Pattern 2: Contains GST % with description before and numbers after
      const gstMatch = line.match(/^(?:(\d{6,8})\s+)?(.+?)\s+(\d+(?:\.\d+)?%)\s+([\d\.\s]+)$/);
      if (gstMatch) {
        const hsn = gstMatch[1] || '';
        const desc = gstMatch[2].trim();
        const numPart = gstMatch[4].trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
        
        if (numPart.length >= 2) {
          const qty = numPart[0];
          const rate = numPart[1];
          const disc = numPart.length >= 5 ? numPart[2] : 0;
          const amt = numPart[numPart.length - 1];

          const mappedId = this.autoMapProduct(desc);
          result.products.push({
            raw_text_name: desc,
            hsn: hsn,
            product_id: mappedId,
            quantity_sold: Math.round(qty),
            rate: rate,
            discount: disc,
            amount: amt
          });
          return;
        }
      }

      // Pattern 3: Line contains product name keywords followed by numerical columns
      const lowerLine = line.toLowerCase();
      const hasProductKw = lowerLine.includes('truflavr') || 
                           lowerLine.includes('seasoning') || 
                           lowerLine.includes('chilli flakes') || 
                           lowerLine.includes('oregano') || 
                           lowerLine.includes('peri peri') || 
                           lowerLine.includes('herb mix') || 
                           lowerLine.includes('pouch') || 
                           lowerLine.includes('bottle') || 
                           lowerLine.includes('sachet');

      if (hasProductKw) {
        const numMatches = line.match(/\b\d+(?:\.\d+)?\b/g);
        if (numMatches && numMatches.length >= 2) {
          let startIndex = 0;
          let hsn = '';
          if (numMatches[0].length >= 6 && numMatches[0].length <= 8) {
            hsn = numMatches[0];
            startIndex = 1;
          }
          const validNums = numMatches.slice(startIndex).map(parseFloat);
          if (validNums.length >= 2) {
            const firstNumIdx = line.indexOf(numMatches[startIndex]);
            let desc = line.substring(0, firstNumIdx).trim().replace(/^\d{6,8}\s+/, '').replace(/%$/, '').trim();
            if (!desc && hsn) {
              desc = line.replace(/^\d{6,8}\s+/, '').trim();
            }
            if (desc) {
              const qty = validNums[0];
              const rate = validNums[1];
              const amt = validNums.length >= 3 ? validNums[validNums.length - 1] : (qty * rate);

              const mappedId = this.autoMapProduct(desc);
              result.products.push({
                raw_text_name: desc,
                hsn: hsn,
                product_id: mappedId,
                quantity_sold: Math.round(qty),
                rate: rate,
                discount: 0,
                amount: amt
              });
            }
          }
        }
      }
    });

    if (result.products.length === 0) {
      const products = this.db.offlineDb.products;
      const defaultProduct = products.length > 0 ? products[0] : { id: '', name: 'Manual Dispatch Item', code: '', selling_price: 0 };
      result.products.push({
        raw_text_name: defaultProduct.name,
        hsn: '',
        product_id: defaultProduct.id,
        quantity_sold: 1,
        rate: defaultProduct.selling_price || 0,
        discount: 0,
        amount: 0
      });
    }

    return result;
  }

  autoMapProduct(name) {
    if (!name) return '';
    const clean = name.toLowerCase()
      .replace(/\bchilly\b/g, "chilli")
      .replace(/\bpiri\b/g, "peri")
      .replace(/\bchess\b/g, "cheese")
      .replace(/\bssong\b/g, "seasoning")
      .replace(/\bsong\b/g, "seasoning");

    const prods = this.db.offlineDb.products || [];

    // 1. Direct match with existing products
    let match = prods.find(p => p.name && p.name.toLowerCase() === clean);
    if (match) return match.id;

    match = prods.find(p => {
      const pClean = (p.name || '').toLowerCase();
      return clean.includes(pClean) || pClean.includes(clean) || (p.code && clean.includes(p.code.toLowerCase()));
    });
    if (match) return match.id;

    // 2. Keyword matching with core product words
    const noise = ['truflavr', 'gms', 'gm', 'pouch', 'pouches', 'bottle', 'bottles', 'sachet', 'sachets', 'pcs', 'box', 'boxes'];
    const keywords = clean.split(/\s+/).filter(w => w.length > 2 && !noise.includes(w));
    
    let bestScore = 0;
    let bestProduct = null;

    prods.forEach(p => {
      const pWords = (p.name || '').toLowerCase().split(/\s+/).filter(w => w.length > 2 && !noise.includes(w));
      if (pWords.length === 0) return;
      let common = 0;
      keywords.forEach(kw => {
        if (pWords.some(pw => pw.includes(kw) || kw.includes(pw))) common++;
      });
      const score = common / Math.max(keywords.length, pWords.length);
      if (score > bestScore && score >= 0.4) {
        bestScore = score;
        bestProduct = p;
      }
    });

    if (bestProduct) return bestProduct.id;

    // 3. Known catalogue products auto-seeding
    const catalogue = [
      { id: 'fg_or_pz_10g', name: 'truFLAVR Oregano Pizza Seasoning 10 gms Pouch', code: 'FG-OR-PZ-10G', price: 5.79, selling_price: 5.79, current_stock: 5000, min_stock: 500, packaging_type: 'Pouches' },
      { id: 'fg_cf_10g', name: 'truFLAVR Chilli Flakes 10 gms Pouch', code: 'FG-CF-10G', price: 5.79, selling_price: 5.79, current_stock: 5000, min_stock: 500, packaging_type: 'Pouches' },
      { id: 'fg_cf_45g', name: 'truFLAVR Chilli Flakes 45 gms Bottle', code: 'FG-CF-45G', price: 63.64, selling_price: 63.64, current_stock: 500, min_stock: 50, packaging_type: 'Bottles' },
      { id: 'fg_or_25g', name: 'truFLAVR Oregano 25 gms Bottle', code: 'FG-OR-25G', price: 57.28, selling_price: 57.28, current_stock: 500, min_stock: 50, packaging_type: 'Bottles' },
      { id: 'fg_is_40g', name: 'truFLAVR Italian Seasoning 40 gms Bottle', code: 'FG-IS-40G', price: 63.64, selling_price: 63.64, current_stock: 500, min_stock: 50, packaging_type: 'Bottles' },
      { id: 'fg_pp_50g', name: 'truFLAVR Peri Peri 50 gms Bottle', code: 'FG-PP-50G', price: 57.28, selling_price: 57.28, current_stock: 500, min_stock: 50, packaging_type: 'Bottles' },
      { id: 'fg_cpp_50g', name: 'truFLAVR Cheese Peri Peri 50 gms Bottle', code: 'FG-CPP-50G', price: 57.28, selling_price: 57.28, current_stock: 500, min_stock: 50, packaging_type: 'Bottles' },
      { id: 'fg_bs_10g', name: 'truFLAVR Bombay Sandwich 10 gms Pouch', code: 'FG-BS-10G', price: 5.79, selling_price: 5.79, current_stock: 2000, min_stock: 200, packaging_type: 'Pouches' },
      { id: 'fg_im_10g', name: 'truFLAVR Italian Mix 10 gms Pouch', code: 'FG-IM-10G', price: 5.79, selling_price: 5.79, current_stock: 2000, min_stock: 200, packaging_type: 'Pouches' },
      { id: 'fg_pp_10g', name: 'truFLAVR Peri Peri 10 gms Pouch', code: 'FG-PP-10G', price: 5.79, selling_price: 5.79, current_stock: 2000, min_stock: 200, packaging_type: 'Pouches' }
    ];

    for (const catProd of catalogue) {
      const catKeywords = catProd.name.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !noise.includes(w));
      let matchCount = 0;
      keywords.forEach(kw => {
        if (catKeywords.some(cw => cw.includes(kw) || kw.includes(cw))) matchCount++;
      });
      if (matchCount >= 2 || (keywords.length > 0 && matchCount / keywords.length >= 0.5)) {
        let existing = prods.find(p => p.id === catProd.id);
        if (!existing) {
          existing = {
            id: catProd.id,
            code: catProd.code,
            name: catProd.name,
            price: catProd.price,
            selling_price: catProd.selling_price,
            current_stock: catProd.current_stock || 1000,
            min_stock: catProd.min_stock || 100,
            packaging_type: catProd.packaging_type || 'Pouches',
            bom: []
          };
          prods.push(existing);
          this.db.saveOfflineDb();
          if (this.db.config.isOnline && this.db.supabase) {
            this.db.supabase.from('products').upsert([existing]).then();
          }
        }
        return existing.id;
      }
    }

    return prods.length > 0 ? prods[0].id : '';
  }


  // --- QUICK ADD RAW MATERIAL MODAL & CLOUD SYNC ---

  openAddMaterialModal(context = 'order', targetIndex = 0) {
    this.addMaterialContext = { context, targetIndex };
    const nameInput = document.getElementById('q-mat-name');
    const codeInput = document.getElementById('q-mat-code');
    const unitSelect = document.getElementById('q-mat-unit');
    const priceInput = document.getElementById('q-mat-price');
    const minStockInput = document.getElementById('q-mat-min-stock');
    const descInput = document.getElementById('q-mat-desc');

    if (nameInput) nameInput.value = '';
    if (codeInput) codeInput.value = '';
    if (unitSelect) unitSelect.value = 'Pieces';
    if (priceInput) priceInput.value = '';
    if (minStockInput) minStockInput.value = '10';
    if (descInput) descInput.value = '';

    this.openModal('modal-add-raw-material');
    if (nameInput) setTimeout(() => nameInput.focus(), 150);
  }

  async handleQuickAddMaterial(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-save-new-mat');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    }

    try {
      const name = document.getElementById('q-mat-name').value.trim();
      let code = document.getElementById('q-mat-code').value.trim();
      const unit = document.getElementById('q-mat-unit').value;
      const price = parseFloat(document.getElementById('q-mat-price').value) || 0;
      const minStock = parseFloat(document.getElementById('q-mat-min-stock').value) || 10;
      const desc = document.getElementById('q-mat-desc').value.trim();

      if (!name) {
        alert("Material name is required.");
        return;
      }

      if (!code) {
        const cleanName = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
        code = 'RM-' + cleanName;
      }

      const newMat = {
        id: 'rm_' + Date.now(),
        code: code,
        name: name,
        unit: unit,
        average_price: price,
        current_stock: 0,
        min_stock: minStock,
        description: desc
      };

      const saved = await this.db.insertRawMaterial(newMat);
      this.closeModal('modal-add-raw-material');

      const ctx = this.addMaterialContext || { context: 'order', targetIndex: 0 };
      if (ctx.context === 'order') {
        const idx = ctx.targetIndex || 0;
        if (!this.orderItems[idx]) {
          this.orderItems[idx] = { material_id: '', quantity: 10, target_price: 0 };
        }
        this.orderItems[idx].material_id = saved.id;
        if (saved.average_price && (!this.orderItems[idx].target_price || this.orderItems[idx].target_price === 0)) {
          this.orderItems[idx].target_price = saved.average_price;
        }
        await this.renderOrderItems();
      } else if (ctx.context === 'inward') {
        const idx = ctx.targetIndex || 0;
        if (!this.inwardItems[idx]) {
          this.inwardItems[idx] = { linked_order_id: '', material_id: '', quantity: 10, rate: 0 };
        }
        this.inwardItems[idx].material_id = saved.id;
        this.inwardItems[idx].linked_order_id = '';
        if (saved.average_price && (!this.inwardItems[idx].rate || this.inwardItems[idx].rate === 0)) {
          this.inwardItems[idx].rate = saved.average_price;
        }
        await this.renderInwardItems();
      } else if (ctx.context === 'verify') {
        const idx = ctx.targetIndex || 0;
        if (this.currentVerifyInwardItems && this.currentVerifyInwardItems[idx]) {
          this.currentVerifyInwardItems[idx].material_id = saved.id;
          if (saved.average_price && !this.currentVerifyInwardItems[idx].rate) {
            this.currentVerifyInwardItems[idx].rate = saved.average_price;
          }
        }
        await this.renderVerifyInwardTable();
      } else {
        await this.refreshAllViews();
      }

      alert(`✓ Raw material "${saved.name}" (${saved.code}) added successfully!`);
    } catch (err) {
      console.error("Error creating raw material:", err);
      alert("Failed to create raw material: " + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-check"></i> Save & Use Material`;
      }
    }
  }

  async refreshCloudData() {
    const icon = document.getElementById('sync-icon');
    if (icon) icon.classList.add('fa-spin');

    if (!this.db.config.isOnline || !this.db.supabase) {
      if (icon) icon.classList.remove('fa-spin');
      if (confirm("You are currently in Sandbox Mode (Offline). Would you like to connect your Supabase Cloud Database URL & Anon Key now?")) {
        this.openSettingsModal();
      }
      return;
    }

    try {
      const mats = await this.db.getRawMaterials();
      const prods = await this.db.getProducts();
      const orders = await this.db.getOrders();

      await this.refreshAllViews();
      alert(`✓ Cloud Sync Successful!\n• ${mats.length} Raw Materials synced\n• ${prods.length} Products synced\n• ${orders.length} Orders synced`);
    } catch (err) {
      console.error("Cloud sync failed:", err);
      alert("Cloud sync failed: " + err.message);
    } finally {
      if (icon) icon.classList.remove('fa-spin');
    }
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
