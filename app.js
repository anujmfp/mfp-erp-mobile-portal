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
    if (!this.offlineDb.debit_notes) {
      this.offlineDb.debit_notes = [];
    }

    // Cutoff migration to 7-Nov-2026 dataset
    const CUTOFF_VERSION = (typeof MFP_CUTOFF_DATA_7NOV !== 'undefined' && MFP_CUTOFF_DATA_7NOV.version) ? MFP_CUTOFF_DATA_7NOV.version : '2026-11-07-v5';
    const currentVersion = localStorage.getItem('mfp_cutoff_version');
    if (currentVersion !== CUTOFF_VERSION && typeof MFP_CUTOFF_DATA_7NOV !== 'undefined') {
      console.log("Auto-applying 7-Nov-2026 Cutoff Starting Dataset & purging test/pre-cutoff operational records...");
      this.applyCutoff7Nov(true);
    } else if (this.offlineDb.raw_materials.length === 0 && this.offlineDb.products.length === 0) {
      this.seedSandboxData();
    }
  }

  applyCutoff7Nov(resetAllOperationalRecords = false) {
    if (typeof MFP_CUTOFF_DATA_7NOV === 'undefined') return;

    // 1. Overwrite raw materials & products with exact 7-Nov cutoff stock
    this.offlineDb.raw_materials = JSON.parse(JSON.stringify(MFP_CUTOFF_DATA_7NOV.raw_materials || []));
    this.offlineDb.products = JSON.parse(JSON.stringify(MFP_CUTOFF_DATA_7NOV.products || []));

    // 2. Wipe operational records
    if (resetAllOperationalRecords) {
      this.offlineDb.orders = [];
      this.offlineDb.inwards = [];
      this.offlineDb.productions = [];
      this.offlineDb.outwards = [];
      this.offlineDb.returns = [];
      this.offlineDb.debit_notes = [];
    } else {
      const cutoffDate = (MFP_CUTOFF_DATA_7NOV.cutoffDate || '2026-11-07');
      this.offlineDb.orders = (this.offlineDb.orders || []).filter(o => {
        const d = (o.date || o.created_at || '').slice(0, 10);
        return d && d >= cutoffDate;
      });
      this.offlineDb.inwards = (this.offlineDb.inwards || []).filter(i => {
        const d = (i.date || '').slice(0, 10);
        return d && d >= cutoffDate;
      });
      this.offlineDb.productions = (this.offlineDb.productions || []).filter(p => {
        const d = (p.date || '').slice(0, 10);
        if (d < cutoffDate) return false;
        if (p.product_id === 'fg_btl_basil' || (p.product_name && p.product_name.includes('Basil Bottle'))) return false;
        return true;
      });
      this.offlineDb.outwards = (this.offlineDb.outwards || []).filter(o => {
        const d = (o.dispatch_date || o.date || '').slice(0, 10);
        return d && d >= cutoffDate;
      });
      this.offlineDb.returns = (this.offlineDb.returns || []).filter(r => {
        const d = (r.return_date || r.date || '').slice(0, 10);
        return d && d >= cutoffDate;
      });
      this.offlineDb.debit_notes = (this.offlineDb.debit_notes || []).filter(d => {
        const dt = (d.date || '').slice(0, 10);
        return dt && dt >= cutoffDate;
      });
    }

    this.saveOfflineDb();
    localStorage.setItem('mfp_cutoff_version', MFP_CUTOFF_DATA_7NOV.version || '2026-11-07-v5');

    // Clean up any accidental Basil runs from cloud
    if (this.config.isOnline && this.supabase) {
      try {
        this.supabase.from('productions').delete().eq('product_id', 'fg_btl_basil').then(() => {
          console.log("✓ Purged accidental Basil Bottle production runs from Supabase cloud");
        });
      } catch (_) {}
    }

    // 3. Upsert clean schema-compatible records to cloud database if online
    if (this.config.isOnline && this.supabase) {
      try {
        const cleanRMs = this.offlineDb.raw_materials.map(m => ({
          id: m.id,
          code: m.code,
          name: m.name,
          current_stock: parseFloat(m.current_stock) || 0,
          unit: m.unit || 'kg',
          average_price: parseFloat(m.average_price) || 0,
          min_stock: parseFloat(m.min_stock || m.buffer) || 5.0,
          description: m.description || ''
        }));

        const cleanProds = this.offlineDb.products.map(p => ({
          id: p.id,
          code: p.code,
          name: p.name,
          price: parseFloat(p.price || p.selling_price) || 0,
          selling_price: parseFloat(p.selling_price || p.price) || 0,
          current_stock: parseFloat(p.current_stock) || 0,
          min_stock: parseFloat(p.min_stock || p.buffer) || 10.0,
          packaging_type: p.packaging_type || 'Bottles',
          description: p.description || '',
          bom: p.bom || []
        }));

        this.supabase.from('raw_materials').upsert(cleanRMs, { onConflict: 'id' }).then(({ error }) => {
          if (error) console.error("Cloud cutoff sync error (raw_materials):", error);
          else console.log("✓ Cloud raw_materials successfully synced to 7-Nov cutoff balances!");
        });
        this.supabase.from('products').upsert(cleanProds, { onConflict: 'id' }).then(({ error }) => {
          if (error) console.error("Cloud cutoff sync error (products):", error);
          else console.log("✓ Cloud products successfully synced to 7-Nov cutoff balances!");
        });
      } catch (e) {
        console.error("Cloud cutoff sync exception:", e);
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
          const mergedMap = new Map();
          if (typeof MFP_CUTOFF_DATA_7NOV !== 'undefined' && Array.isArray(MFP_CUTOFF_DATA_7NOV.raw_materials)) {
            MFP_CUTOFF_DATA_7NOV.raw_materials.forEach(m => mergedMap.set(m.id, { ...m }));
          }
          data.forEach(m => {
            const existing = mergedMap.get(m.id);
            if (existing) {
              mergedMap.set(m.id, { ...existing, ...m });
            } else {
              mergedMap.set(m.id, m);
            }
          });
          const mergedList = Array.from(mergedMap.values());
          this.offlineDb.raw_materials = mergedList;
          this.saveOfflineDb();
          return mergedList.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
      } catch (e) {
        console.error("Exception fetching raw materials:", e);
      }
    }
    return [...this.offlineDb.raw_materials].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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
          const mergedMap = new Map();
          if (typeof MFP_CUTOFF_DATA_7NOV !== 'undefined' && Array.isArray(MFP_CUTOFF_DATA_7NOV.products)) {
            MFP_CUTOFF_DATA_7NOV.products.forEach(p => mergedMap.set(p.id, { ...p }));
          }
          data.forEach(p => {
            const existing = mergedMap.get(p.id);
            if (existing) {
              mergedMap.set(p.id, { ...existing, ...p });
            } else {
              mergedMap.set(p.id, p);
            }
          });
          const mergedList = Array.from(mergedMap.values());
          this.offlineDb.products = mergedList;
          this.saveOfflineDb();
          return mergedList.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        }
      } catch (e) {
        console.error("Exception fetching products:", e);
      }
    }
    return [...this.offlineDb.products].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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

  async deleteOrder(orderId) {
    if (this.config.isOnline && this.supabase) {
      try {
        const { error } = await this.supabase.from('orders').delete().eq('id', orderId);
        if (error) console.error("Error deleting order from Supabase:", error);
      } catch (e) {
        console.error("Exception deleting order from Supabase:", e);
      }
    }
    this.offlineDb.orders = this.offlineDb.orders.filter(o => o.id !== orderId);
    this.saveOfflineDb();
    return true;
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

  async getProductions() {
    if (this.config.isOnline && this.supabase) {
      try {
        const { data, error } = await this.supabase.from('productions').select('*').order('created_at', { ascending: false });
        if (error) {
          console.error("Supabase error fetching productions:", error);
        } else if (data) {
          return data;
        }
      } catch (e) {
        console.error("Exception fetching productions:", e);
      }
    }
    if (!this.offlineDb.productions) this.offlineDb.productions = [];
    return [...this.offlineDb.productions].sort((a, b) => new Date(b.created_at || b.date) - new Date(a.created_at || a.date));
  }

  async insertProduction(prod) {
    prod.id = 'run_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
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
          const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage || 0) / 100);
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
      try {
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
      } catch (e) {
        console.error("Supabase insert production exception:", e);
      }
    }
    
    if (!this.offlineDb.productions) this.offlineDb.productions = [];
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

  async getDebitNotes() {
    if (this.config.isOnline && this.supabase) {
      try {
        const { data, error } = await this.supabase.from('debit_notes').select('*').order('created_at', { ascending: false });
        if (!error && data) {
          this.offlineDb.debit_notes = data;
          this.saveOfflineDb();
          return data;
        }
      } catch (e) {
        console.error("Exception fetching debit notes:", e);
      }
    }
    return (this.offlineDb.debit_notes || []).slice().reverse();
  }

  async insertDebitNote(debitNoteData) {
    if (!debitNoteData.id) {
      debitNoteData.id = 'dn_' + Date.now();
    }
    const dateStr = debitNoteData.date || new Date().toISOString().split('T')[0];
    debitNoteData.date = dateStr;
    debitNoteData.created_at = debitNoteData.created_at || new Date(dateStr + 'T12:00:00Z').toISOString();

    const rawMaterials = await this.getRawMaterials();
    if (!this.offlineDb.debit_notes) this.offlineDb.debit_notes = [];

    // 1. Deduct defective returned quantities from Raw Materials stock if deduct_stock is enabled
    if (debitNoteData.deduct_stock !== false && Array.isArray(debitNoteData.items)) {
      for (const item of debitNoteData.items) {
        if (item.material_id) {
          const mat = rawMaterials.find(m => m.id === item.material_id);
          if (mat) {
            const currentStock = parseFloat(mat.current_stock || 0);
            const returnQty = parseFloat(item.quantity || 0);
            const newStock = Math.max(0, currentStock - returnQty);
            await this.updateMaterialStock(mat.id, newStock, mat.average_price);
          }
        }
      }
    }

    // 2. Insert into Supabase if online
    if (this.config.isOnline && this.supabase) {
      try {
        const payload = {
          id: debitNoteData.id,
          created_at: debitNoteData.created_at,
          debit_note_no: debitNoteData.debit_note_no,
          date: debitNoteData.date,
          vendor_name: debitNoteData.vendor_name,
          vendor_gstin: debitNoteData.vendor_gstin || null,
          vendor_address: debitNoteData.vendor_address || null,
          original_invoice_ref: debitNoteData.original_invoice_ref || null,
          reason: debitNoteData.reason || null,
          items: debitNoteData.items || [],
          subtotal: parseFloat(debitNoteData.subtotal || 0),
          tax_amount: parseFloat(debitNoteData.tax_amount || 0),
          grand_total: parseFloat(debitNoteData.grand_total || 0),
          photo_proof: debitNoteData.photo_proof || null,
          notes: debitNoteData.notes || null
        };
        const { error } = await this.supabase.from('debit_notes').insert([payload]);
        if (error) {
          console.error("Supabase error inserting debit note:", error);
        }
      } catch (err) {
        console.error("Exception inserting debit note to Supabase:", err);
      }
    }

    this.offlineDb.debit_notes.push(debitNoteData);
    this.saveOfflineDb();
    return debitNoteData;
  }

  async deleteDebitNote(id) {
    if (this.config.isOnline && this.supabase) {
      try {
        await this.supabase.from('debit_notes').delete().eq('id', id);
      } catch (e) {
        console.error("Error deleting debit note from Supabase:", e);
      }
    }
    if (this.offlineDb.debit_notes) {
      this.offlineDb.debit_notes = this.offlineDb.debit_notes.filter(d => d.id !== id);
      this.saveOfflineDb();
    }
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
    if (typeof MFP_CUTOFF_DATA_7NOV !== 'undefined') {
      this.applyCutoff7Nov();
      return;
    }
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
    this.debitNoteItems = [];
    this.debitNotePhotoBase64 = null;
    this.activeDebitNoteSlip = null;
    this.inwardActiveSubTab = 'raw';

    // Sample Dispatch state
    this.sampleItems = [];
    this.currentSampleCategory = 'All';
    this.currentOutwardSubSection = 'invoice';
    this.currentSamplePhotoUrl = null;

    // Status Tab simplified primary tabs and sub-filter state
    this.statusMainTab = 'raw_materials'; // 'raw_materials' or 'finished_goods'
    this.statusSubFilter = 'deficit'; // 'deficit' (items to order/produce) or 'all'

    this.init();
  }

  escapeHtml(str) {
    if (!str && str !== 0) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
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
    const dateInputIds = ['order-date', 'inward-date', 'dn-date', 'return-date', 'production-date', 'outward-date', 'sample-date', 'vi-date', 'vo-date'];
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
    this.currentView = 'view-order';

    // Prevent virtual keyboards / enter key from unintentionally submitting forms on mobile
    document.querySelectorAll('form').forEach(form => {
      form.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'submit') {
          e.preventDefault();
          e.target.blur();
        }
      });
    });

    this.initDateInputs();
    this.setupDropzones();
    this.loadSettingsForm();
    await this.refreshAllViews();
  }

  switchView(viewId, tabElement) {
    if (this.currentView === viewId) {
      // Already on this view - do not re-render and lose user's active inputs
      return;
    }
    this.currentView = viewId;

    document.querySelectorAll('.app-view').forEach(view => {
      view.classList.remove('active');
    });
    const targetView = document.getElementById(viewId);
    if (targetView) targetView.classList.add('active');

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
    } else if (viewId === 'view-status') {
      await this.renderStatusPane();
    }
  }

  async refreshAllViews() {
    await this.renderOrderPane();
    await this.renderInwardPane();
    await this.renderProductionPane();
    await this.renderOutwardPane();
    await this.renderStatusPane();
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
            <div style="flex:1; padding-right:0.5rem;">
              <div class="td-bold" style="font-size:0.85rem;">${ord.material_name}</div>
              <div class="td-muted" style="font-size:0.75rem;">Date: ${dateDisplay} • Qty: ${ord.quantity_requested} • Vendor: ${ord.vendor_name || 'N/A'}</div>
            </div>
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <span class="badge badge-warning" style="font-size:0.65rem;">Pending</span>
              <button type="button" class="btn btn-secondary btn-sm" onclick="app.deleteOrder('${ord.id}')" title="Delete order created by mistake" style="padding:0.22rem 0.45rem; font-size:0.72rem; color:var(--color-danger); border:1px solid rgba(239, 68, 68, 0.35); background:rgba(239, 68, 68, 0.08); border-radius:4px;">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
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

  async deleteOrder(orderId) {
    const orders = await this.db.getOrders();
    const ord = orders.find(o => o.id === orderId);
    const label = ord ? `${ord.material_name} (${ord.quantity_requested} pcs)` : 'this order';
    if (!confirm(`Delete purchase order for ${label} created by mistake?`)) {
      return;
    }
    await this.db.deleteOrder(orderId);
    await this.renderOrderPane();
    if (this.currentVerifyInwardItems) {
      await this.renderVerifyInwardTable();
    }
    alert("✓ Order deleted successfully.");
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

    const materials = await this.db.getRawMaterials();
    const fragment = document.createDocumentFragment();

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
      fragment.appendChild(box);
    });

    container.innerHTML = '';
    container.appendChild(fragment);

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

    const orders = await this.db.getOrders();
    const pendingOrders = orders.filter(o => o.status === 'Pending');
    const materials = await this.db.getRawMaterials();
    const fragment = document.createDocumentFragment();

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
      fragment.appendChild(box);
    });

    container.innerHTML = '';
    container.appendChild(fragment);

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


  // --- 2B. VENDOR DEBIT NOTE (DEFECTIVE / REJECTED GOODS) WORKFLOW ---

  switchInwardSubSection(tab) {
    this.inwardActiveSubTab = tab;
    const btnRaw = document.getElementById('btn-inward-raw');
    const btnDebit = document.getElementById('btn-inward-debit');
    const btnReturn = document.getElementById('btn-inward-return');
    const secRaw = document.getElementById('inward-raw-section');
    const secDebit = document.getElementById('inward-debit-section');
    const secReturn = document.getElementById('inward-return-section');

    if (btnRaw) btnRaw.classList.remove('active');
    if (btnDebit) btnDebit.classList.remove('active');
    if (btnReturn) btnReturn.classList.remove('active');
    if (secRaw) secRaw.classList.add('hidden');
    if (secDebit) secDebit.classList.add('hidden');
    if (secReturn) secReturn.classList.add('hidden');

    if (tab === 'debit') {
      if (btnDebit) btnDebit.classList.add('active');
      if (secDebit) secDebit.classList.remove('hidden');
      this.renderDebitNotePane();
    } else if (tab === 'return') {
      if (btnReturn) btnReturn.classList.add('active');
      if (secReturn) secReturn.classList.remove('hidden');
      this.renderReturnPane();
    } else {
      if (btnRaw) btnRaw.classList.add('active');
      if (secRaw) secRaw.classList.remove('hidden');
      this.renderInwardItems();
    }
  }

  async renderDebitNotePane() {
    this.initDateInputs();
    const rawMaterials = await this.db.getRawMaterials();

    // Auto-fill next Debit Note Number if blank
    const dnNoInput = document.getElementById('dn-number');
    if (dnNoInput && !dnNoInput.value.trim()) {
      const existingDns = await this.db.getDebitNotes();
      const nextNo = (existingDns.length || 0) + 1;
      dnNoInput.value = `MFP-DN-26-${String(nextNo).padStart(3, '0')}`;
    }

    // Populate vendor datalist from past transactions
    const vendorDatalist = document.getElementById('dn-vendor-datalist');
    if (vendorDatalist) {
      const vendorSet = new Set();
      (this.db.offlineDb.inwards || []).forEach(inw => { if (inw.supplier) vendorSet.add(inw.supplier); });
      (this.db.offlineDb.orders || []).forEach(ord => { if (ord.supplier) vendorSet.add(ord.supplier); });
      (this.db.offlineDb.debit_notes || []).forEach(dn => { if (dn.vendor_name) vendorSet.add(dn.vendor_name); });
      vendorDatalist.innerHTML = Array.from(vendorSet).map(v => `<option value="${this.escapeHtml(v)}"></option>`).join('');
    }

    // Initialize debit note items if empty
    if (!this.debitNoteItems || this.debitNoteItems.length === 0) {
      const firstMat = rawMaterials[0];
      this.debitNoteItems = [{
        material_id: firstMat ? firstMat.id : '',
        material_name: firstMat ? firstMat.name : '',
        description: '',
        quantity: 1,
        unit: firstMat ? (firstMat.unit || 'pcs') : 'pcs',
        rate: firstMat ? (parseFloat(firstMat.average_price || 0) || 0) : 0,
        gst_rate: 18
      }];
    }

    await this.renderDebitNoteItems();
    await this.renderRecentDebitNotesList();
  }

  async addDebitNoteItemRow() {
    if (!Array.isArray(this.debitNoteItems)) {
      this.debitNoteItems = [];
    }
    const rawMaterials = await this.db.getRawMaterials();
    const firstMat = (rawMaterials && rawMaterials.length > 0) ? rawMaterials[0] : null;
    this.debitNoteItems.push({
      material_id: firstMat ? firstMat.id : '',
      material_name: firstMat ? firstMat.name : '',
      description: '',
      quantity: 1,
      unit: firstMat ? (firstMat.unit || 'pcs') : 'pcs',
      rate: firstMat ? (parseFloat(firstMat.average_price || 0) || 0) : 0,
      gst_rate: 18
    });
    await this.renderDebitNoteItems();
  }

  removeDebitNoteItemRow(index) {
    if (this.debitNoteItems.length > 1) {
      this.debitNoteItems.splice(index, 1);
      this.renderDebitNoteItems();
    } else {
      alert("At least one defective item row is required.");
    }
  }

  async updateDebitNoteItem(index, field, val) {
    if (!this.debitNoteItems[index]) return;
    const item = this.debitNoteItems[index];

    if (field === 'material_id') {
      item.material_id = val;
      const rawMaterials = await this.db.getRawMaterials();
      const m = rawMaterials.find(x => x.id === val);
      if (m) {
        item.material_name = m.name;
        item.unit = m.unit || 'pcs';
        if (!item.rate || item.rate === 0) {
          item.rate = parseFloat(m.average_price || 0) || 0;
        }
      }
      await this.renderDebitNoteItems();
      return;
    } else if (field === 'description') {
      item.description = val;
    } else if (field === 'quantity') {
      item.quantity = parseFloat(val) || 0;
    } else if (field === 'unit') {
      item.unit = val;
    } else if (field === 'rate') {
      item.rate = parseFloat(val) || 0;
    } else if (field === 'gst_rate') {
      item.gst_rate = parseFloat(val) || 0;
    }

    // Update row line total live
    const lineTotal = (item.quantity * item.rate) * (1 + (item.gst_rate || 0) / 100);
    const lineEl = document.getElementById(`dn-item-total-${index}`);
    if (lineEl) {
      lineEl.textContent = `₹ ${lineTotal.toFixed(2)}`;
    }

    // Update overall debit note total
    let grandTotal = 0;
    this.debitNoteItems.forEach(it => {
      const base = (it.quantity || 0) * (it.rate || 0);
      const tax = base * ((it.gst_rate || 0) / 100);
      grandTotal += (base + tax);
    });
    const totalBadge = document.getElementById('dn-total-amount');
    if (totalBadge) {
      totalBadge.textContent = `Total: Rs. ${grandTotal.toFixed(2)}`;
    }
  }

  async renderDebitNoteItems() {
    const container = document.getElementById('debit-items-container');
    if (!container) return;
    container.innerHTML = '';

    const rawMaterials = await this.db.getRawMaterials();
    let overallTotal = 0;

    this.debitNoteItems.forEach((item, idx) => {
      const selectedMat = rawMaterials.find(m => m.id === item.material_id);
      const currentStock = selectedMat ? (parseFloat(selectedMat.current_stock || 0)) : 0;
      const matUnit = selectedMat ? (selectedMat.unit || 'pcs') : (item.unit || 'pcs');
      const baseAmt = (item.quantity || 0) * (item.rate || 0);
      const taxAmt = baseAmt * ((item.gst_rate || 0) / 100);
      const lineTotal = baseAmt + taxAmt;
      overallTotal += lineTotal;

      const row = document.createElement('div');
      row.className = 'multi-item-box debit-box';
      row.innerHTML = `
        <div class="multi-item-header">
          <span><i class="fa-solid fa-circle-minus" style="color:var(--color-danger);"></i> Defective Item #${idx + 1}</span>
          <div style="display:flex; align-items:center; gap:0.5rem;">
            <span style="font-size:0.7rem; color:var(--text-dim);">Warehouse Stock: <strong style="color:var(--color-primary);">${currentStock} ${matUnit}</strong></span>
            ${this.debitNoteItems.length > 1 ? `
              <button type="button" class="multi-item-remove-btn" onclick="app.removeDebitNoteItemRow(${idx})">
                <i class="fa-solid fa-trash-can"></i> Remove
              </button>
            ` : ''}
          </div>
        </div>

        <div class="form-group" style="margin-bottom:0.4rem;">
          <label style="font-size:0.7rem; color:var(--text-muted);">Raw Material (from Inventory) *</label>
          <div style="display:flex; gap:0.35rem;">
            <select class="form-control" style="font-size:0.75rem; padding:0.3rem 0.45rem;" onchange="app.updateDebitNoteItem(${idx}, 'material_id', this.value)" required>
              <option value="">-- Select Raw Material --</option>
              ${rawMaterials.map(m => `
                <option value="${m.id}" ${m.id === item.material_id ? 'selected' : ''}>
                  ${this.escapeHtml(m.name)} (${m.code || 'RM'}) [${m.current_stock || 0} ${m.unit || 'pcs'}]
                </option>
              `).join('')}
            </select>
          </div>
        </div>

        <div class="form-group" style="margin-bottom:0.4rem;">
          <label style="font-size:0.7rem; color:var(--text-muted);">Defect Details / Description on Debit Note</label>
          <input type="text" class="form-control" style="font-size:0.75rem; padding:0.3rem 0.45rem;" placeholder="e.g. 28mm bottle caps damaged / off-color / leaked seal" value="${this.escapeHtml(item.description || '')}" oninput="app.updateDebitNoteItem(${idx}, 'description', this.value)">
        </div>

        <div class="form-row" style="margin-bottom:0.4rem; gap:0.4rem;">
          <div class="form-group" style="flex:1.2; margin-bottom:0;">
            <label style="font-size:0.7rem;">Defective Qty *</label>
            <input type="number" step="0.01" min="0.01" class="form-control" style="font-size:0.75rem; padding:0.3rem 0.45rem;" value="${item.quantity || 1}" oninput="app.updateDebitNoteItem(${idx}, 'quantity', this.value)" required>
          </div>
          <div class="form-group" style="flex:0.8; margin-bottom:0;">
            <label style="font-size:0.7rem;">Unit</label>
            <input type="text" class="form-control" style="font-size:0.75rem; padding:0.3rem 0.45rem;" value="${this.escapeHtml(item.unit || 'pcs')}" oninput="app.updateDebitNoteItem(${idx}, 'unit', this.value)">
          </div>
          <div class="form-group" style="flex:1; margin-bottom:0;">
            <label style="font-size:0.7rem;">Rate (Rs.) *</label>
            <input type="number" step="0.01" min="0" class="form-control" style="font-size:0.75rem; padding:0.3rem 0.45rem;" value="${item.rate || 0}" oninput="app.updateDebitNoteItem(${idx}, 'rate', this.value)" required>
          </div>
          <div class="form-group" style="flex:0.9; margin-bottom:0;">
            <label style="font-size:0.7rem;">GST %</label>
            <select class="form-control" style="font-size:0.75rem; padding:0.3rem 0.45rem;" onchange="app.updateDebitNoteItem(${idx}, 'gst_rate', this.value)">
              <option value="0" ${item.gst_rate === 0 ? 'selected' : ''}>0%</option>
              <option value="5" ${item.gst_rate === 5 ? 'selected' : ''}>5%</option>
              <option value="12" ${item.gst_rate === 12 ? 'selected' : ''}>12%</option>
              <option value="18" ${item.gst_rate === 18 ? 'selected' : ''}>18%</option>
              <option value="28" ${item.gst_rate === 28 ? 'selected' : ''}>28%</option>
            </select>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.15); padding:0.25rem 0.5rem; border-radius:4px; font-size:0.72rem;">
          <span style="color:var(--text-muted);">Line Total (incl. GST):</span>
          <strong id="dn-item-total-${idx}" style="color:var(--color-danger);">₹ ${lineTotal.toFixed(2)}</strong>
        </div>
      `;
      container.appendChild(row);
    });

    const totalBadge = document.getElementById('dn-total-amount');
    if (totalBadge) {
      totalBadge.textContent = `Total: Rs. ${overallTotal.toFixed(2)}`;
    }
  }

  handleDebitNotePhoto(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.debitNotePhotoBase64 = e.target.result;
      const previewImg = document.getElementById('dn-photo-preview');
      const previewWrap = document.getElementById('dn-photo-preview-wrap');
      const statusLabel = document.getElementById('dn-photo-status');
      if (previewImg) previewImg.src = this.debitNotePhotoBase64;
      if (previewWrap) previewWrap.style.display = 'inline-block';
      if (statusLabel) statusLabel.textContent = file.name || 'Photo captured';
    };
    reader.readAsDataURL(file);
  }

  removeDebitNotePhoto() {
    this.debitNotePhotoBase64 = null;
    const previewWrap = document.getElementById('dn-photo-preview-wrap');
    const previewImg = document.getElementById('dn-photo-preview');
    const statusLabel = document.getElementById('dn-photo-status');
    const cInput = document.getElementById('dn-camera-input');
    const fInput = document.getElementById('dn-file-input');
    if (previewWrap) previewWrap.style.display = 'none';
    if (previewImg) previewImg.src = '';
    if (statusLabel) statusLabel.textContent = 'No photo selected';
    if (cInput) cInput.value = '';
    if (fInput) fInput.value = '';
  }

  async handleDebitNoteSubmit(e) {
    e.preventDefault();

    const dnNumber = (document.getElementById('dn-number') ? document.getElementById('dn-number').value.trim() : '');
    const dnDate = (document.getElementById('dn-date') && document.getElementById('dn-date').value) || this.getTodayDate();
    const vendor = (document.getElementById('dn-vendor') ? document.getElementById('dn-vendor').value.trim() : '');
    const vendorGst = (document.getElementById('dn-vendor-gst') ? document.getElementById('dn-vendor-gst').value.trim().toUpperCase() : '');
    const inwardRef = (document.getElementById('dn-inward-ref') ? document.getElementById('dn-inward-ref').value.trim() : '');
    const reason = (document.getElementById('dn-reason') ? document.getElementById('dn-reason').value.trim() : '');
    const vendorAddress = (document.getElementById('dn-vendor-address') ? document.getElementById('dn-vendor-address').value.trim() : '');
    const deductStock = document.getElementById('dn-deduct-stock') ? document.getElementById('dn-deduct-stock').checked : true;
    const notes = (document.getElementById('dn-notes') ? document.getElementById('dn-notes').value.trim() : '');

    if (!dnNumber || !vendor) {
      alert("Please provide Debit Note Number and Vendor Name.");
      return;
    }

    if (!this.debitNoteItems || this.debitNoteItems.length === 0) {
      alert("Please add at least one defective item.");
      return;
    }

    const rawMaterials = await this.db.getRawMaterials();
    let totalTaxable = 0;
    let totalCGST = 0;
    let totalSGST = 0;
    let totalIGST = 0;

    // Check if intra-state: Gujarat GST starts with 24
    const isIntraState = !vendorGst || vendorGst.startsWith('24');

    const cleanItems = [];
    let itemsSummaryText = '';

    for (let i = 0; i < this.debitNoteItems.length; i++) {
      const it = this.debitNoteItems[i];
      if (!it.material_id) {
        alert(`Please select a raw material for Item #${i + 1}.`);
        return;
      }
      if (!it.quantity || it.quantity <= 0) {
        alert(`Please enter a valid defective quantity for Item #${i + 1}.`);
        return;
      }

      const mat = rawMaterials.find(m => m.id === it.material_id);
      const matName = mat ? mat.name : (it.material_name || 'Raw Material');
      const matCode = mat ? mat.code : '';
      const hsn = (mat && mat.hsn) ? mat.hsn : '39235010';
      const qty = parseFloat(it.quantity || 0);
      const rate = parseFloat(it.rate || 0);
      const gstRate = parseFloat(it.gst_rate || 0);
      const lineTaxable = qty * rate;
      const lineTax = lineTaxable * (gstRate / 100);

      totalTaxable += lineTaxable;
      if (isIntraState) {
        totalCGST += lineTax / 2;
        totalSGST += lineTax / 2;
      } else {
        totalIGST += lineTax;
      }

      itemsSummaryText += `${i + 1}. *${matName}* (${matCode || 'RM'})\n` +
                          `   • Returned: *${qty} ${it.unit || 'pcs'}* @ Rs. ${rate.toFixed(2)}\n` +
                          (it.description ? `   • Defect: ${it.description}\n` : '') +
                          `   • Line Total: Rs. ${(lineTaxable + lineTax).toFixed(2)}\n`;

      cleanItems.push({
        material_id: it.material_id,
        material_name: matName,
        material_code: matCode,
        hsn: hsn,
        description: it.description || `Defective ${matName} returned`,
        quantity: qty,
        unit: it.unit || 'pcs',
        rate: rate,
        gst_rate: gstRate,
        taxable_amount: lineTaxable,
        tax_amount: lineTax,
        line_total: lineTaxable + lineTax
      });
    }

    const totalTax = isIntraState ? (totalCGST + totalSGST) : totalIGST;
    const combinedTotal = totalTaxable + totalTax;
    const roundedGrandTotal = Math.round(combinedTotal);
    const roundOff = roundedGrandTotal - combinedTotal;

    const payload = {
      debit_note_no: dnNumber,
      date: dnDate,
      vendor_name: vendor,
      vendor_gstin: vendorGst,
      vendor_address: vendorAddress,
      original_invoice_ref: inwardRef,
      reason: reason,
      items: cleanItems,
      subtotal: totalTaxable,
      tax_amount: totalTax,
      cgst_amount: totalCGST,
      sgst_amount: totalSGST,
      igst_amount: totalIGST,
      round_off: roundOff,
      grand_total: roundedGrandTotal,
      deduct_stock: deductStock,
      photo_proof: this.debitNotePhotoBase64,
      notes: notes
    };

    // Save Debit Note into DB and deduct raw material stock
    const savedDn = await this.db.insertDebitNote(payload);

    // Also record transaction into local storage DB so stock ledger modal displays it as an outward reduction!
    if (!this.db.offlineDb.transactions) this.db.offlineDb.transactions = [];
    this.db.offlineDb.transactions.push({
      id: 'tx_dn_' + savedDn.id,
      type: 'debit_note',
      date: dnDate,
      invoice_no: dnNumber,
      description: `Vendor Debit Note: ${vendor} (${reason})`,
      items: cleanItems.map(it => ({
        name: it.material_name,
        qty: it.quantity,
        rate: it.rate,
        total: it.line_total
      })),
      raw_material_changes: cleanItems.map(it => ({
        material_id: it.material_id,
        material_name: it.material_name,
        qty_change: it.quantity,
        direction: 'out',
        wastage_qty: 0
      }))
    });
    this.db.saveOfflineDb();

    // Compile WhatsApp Debit Notice
    const waText = `🚨 *MORELLA FARMPRO LLP - DEBIT NOTE NOTICE*\n` +
                   `• *Debit Note No:* ${dnNumber}\n` +
                   `• *Date:* ${dnDate}\n` +
                   `• *To Vendor:* ${vendor}\n` +
                   (vendorGst ? `• *Vendor GSTIN:* ${vendorGst}\n` : '') +
                   (inwardRef ? `• *Original Bill / Inward Ref:* ${inwardRef}\n` : '') +
                   `• *Reason for Rejection:* ${reason}\n` +
                   `• *Total Debit Amount:* Rs. ${roundedGrandTotal.toFixed(2)} (Taxable: Rs. ${totalTaxable.toFixed(2)})\n\n` +
                   `*Defective Materials Returned:*\n` +
                   itemsSummaryText +
                   (notes ? `\n• *Remarks:* ${notes}\n` : '') +
                   `\n_Official signed Debit Note generated. Please credit our account or adjust against next billing._`;

    const waTextEl = document.getElementById('dn-wa-text');
    const waWidget = document.getElementById('dn-wa-widget');
    if (waTextEl && waWidget) {
      waTextEl.value = waText;
      waWidget.classList.remove('hidden');
    }

    // Refresh views and recent debit notes list
    await this.refreshAllViews();
    await this.renderRecentDebitNotesList();

    // Automatically preview signed Debit Note PDF slip
    this.openDebitNoteSlip(savedDn.id);
  }

  async renderRecentDebitNotesList() {
    const container = document.getElementById('recent-debit-notes-container');
    if (!container) return;

    const list = await this.db.getDebitNotes();
    if (!list || list.length === 0) {
      container.innerHTML = `<div class="td-muted italic text-center" style="padding:0.75rem;">No debit notes issued yet.</div>`;
      return;
    }

    container.innerHTML = list.slice(0, 10).map(dn => {
      const itemsCount = Array.isArray(dn.items) ? dn.items.length : 1;
      const amt = parseFloat(dn.grand_total || dn.total_amount || 0).toFixed(2);
      return `
        <div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-color); border-radius:6px; padding:0.6rem; display:flex; justify-content:space-between; align-items:center; gap:0.5rem;">
          <div style="flex:1;">
            <div style="display:flex; align-items:center; gap:0.4rem;">
              <span style="font-weight:700; font-size:0.8rem; color:var(--color-danger);">${this.escapeHtml(dn.debit_note_no || 'DN')}</span>
              <span style="font-size:0.7rem; color:var(--text-dim);">${dn.date || ''}</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-main); margin-top:2px;">
              <strong>${this.escapeHtml(dn.vendor_name || 'Vendor')}</strong>
            </div>
            <div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px;">
              ${this.escapeHtml(dn.reason || 'Defective material')} • ${itemsCount} item(s)
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:700; font-size:0.85rem; color:var(--color-danger);">Rs. ${amt}</div>
            <div style="display:flex; gap:0.3rem; margin-top:0.35rem; justify-content:flex-end;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="app.openDebitNoteSlip('${dn.id}')" style="padding:0.2rem 0.45rem; font-size:0.7rem;" title="View & Download Signed PDF">
                <i class="fa-solid fa-file-pdf" style="color:var(--color-primary);"></i> Slip
              </button>
              <button type="button" class="btn btn-danger-sm btn-sm" onclick="app.deleteDebitNoteEntry('${dn.id}')" style="padding:0.2rem 0.45rem; font-size:0.7rem;" title="Delete Debit Note">
                <i class="fa-solid fa-trash-can"></i>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  async openDebitNoteSlip(id) {
    const list = await this.db.getDebitNotes();
    let dn = list.find(x => x.id === id);
    if (!dn && this.db.offlineDb.debit_notes) {
      dn = this.db.offlineDb.debit_notes.find(x => x.id === id);
    }
    if (!dn) {
      alert("Debit Note record not found.");
      return;
    }

    this.activeDebitNoteSlip = dn;
    const body = document.getElementById('debit-note-slip-body');
    if (!body) return;

    const vendorGst = dn.vendor_gstin || '';
    const isIntraState = !vendorGst || vendorGst.startsWith('24');
    const items = Array.isArray(dn.items) ? dn.items : [];

    let totalTaxable = 0;
    let totalCGST = 0;
    let totalSGST = 0;
    let totalIGST = 0;

    let tableRowsHtml = '';
    items.forEach((it, idx) => {
      const taxable = parseFloat(it.taxable_amount || (it.quantity * it.rate) || 0);
      const gstRate = parseFloat(it.gst_rate || 0);
      const taxAmt = parseFloat(it.tax_amount || (taxable * gstRate / 100) || 0);
      const lineTotal = parseFloat(it.line_total || (taxable + taxAmt) || 0);

      totalTaxable += taxable;
      if (isIntraState) {
        totalCGST += taxAmt / 2;
        totalSGST += taxAmt / 2;
      } else {
        totalIGST += taxAmt;
      }

      const desc = it.description || it.material_name || 'Defective Material';
      const hsn = it.hsn || '39235010';

      const taxCells = isIntraState
        ? `<td class="right">${(taxAmt / 2).toFixed(2)}</td><td class="right">${(taxAmt / 2).toFixed(2)}</td>`
        : `<td colspan="2" class="right">${taxAmt.toFixed(2)}</td>`;

      tableRowsHtml += `
        <tr class="item-row">
          <td class="center">${hsn}</td>
          <td>
            <strong>${this.escapeHtml(it.material_name || '')}</strong>
            ${it.description ? `<div style="font-size:11px; color:#444;">${this.escapeHtml(it.description)}</div>` : ''}
          </td>
          <td class="center">${gstRate}%</td>
          <td class="center">${it.quantity} ${this.escapeHtml(it.unit || 'pcs')}</td>
          <td class="right">${parseFloat(it.rate || 0).toFixed(2)}</td>
          <td class="center">-</td>
          ${taxCells}
          <td class="right" style="font-weight:bold;">${lineTotal.toFixed(2)}</td>
        </tr>
      `;
    });

    // Pad blank rows to preserve standard A4 invoice height like Morella Farmpro invoice sheet
    const blankRowsNeeded = Math.max(0, 4 - items.length);
    for (let b = 0; b < blankRowsNeeded; b++) {
      tableRowsHtml += `
        <tr style="height: 22px;">
          <td></td><td></td><td></td><td></td><td></td><td></td><td colspan="2"></td><td></td>
        </tr>
      `;
    }

    const roundedGrandTotal = Math.round(parseFloat(dn.grand_total || (totalTaxable + (isIntraState ? (totalCGST + totalSGST) : totalIGST))));
    const roundOff = roundedGrandTotal - (totalTaxable + (isIntraState ? (totalCGST + totalSGST) : totalIGST));
    const amountInWords = this.numberToIndianWords(roundedGrandTotal);

    const taxHeader = isIntraState
      ? '<th style="width: 6%">CGST</th><th style="width: 6%">SGST</th>'
      : '<th colspan="2" style="width: 12%">IGST</th>';

    const botGstDetails = isIntraState ? `
      <div class="inv-totals-col">
        <div class="inv-totals-col-label">CGST</div>
        <div class="inv-totals-col-val">${items[0] ? (items[0].gst_rate / 2).toFixed(1) : '9.0'}%</div>
      </div>
      <div class="inv-totals-col">
        <div class="inv-totals-col-label">SGST</div>
        <div class="inv-totals-col-val">${items[0] ? (items[0].gst_rate / 2).toFixed(1) : '9.0'}%</div>
      </div>
      <div class="inv-totals-col" style="flex: 1.5;">
        <div class="inv-totals-col-label">On Amt.</div>
        <div class="inv-totals-col-val">${totalTaxable.toFixed(2)}</div>
      </div>
      <div class="inv-totals-col">
        <div class="inv-totals-col-label">CGST</div>
        <div class="inv-totals-col-val">${totalCGST.toFixed(2)}</div>
      </div>
      <div class="inv-totals-col">
        <div class="inv-totals-col-label">SGST</div>
        <div class="inv-totals-col-val">${totalSGST.toFixed(2)}</div>
      </div>
    ` : `
      <div class="inv-totals-col" style="flex: 2;">
        <div class="inv-totals-col-label">IGST</div>
        <div class="inv-totals-col-val">${items[0] ? items[0].gst_rate.toFixed(1) : '18.0'}%</div>
      </div>
      <div class="inv-totals-col" style="flex: 2;">
        <div class="inv-totals-col-label">On Amt.</div>
        <div class="inv-totals-col-val">${totalTaxable.toFixed(2)}</div>
      </div>
      <div class="inv-totals-col" style="flex: 2;">
        <div class="inv-totals-col-label">IGST Amt</div>
        <div class="inv-totals-col-val">${totalIGST.toFixed(2)}</div>
      </div>
    `;

    const totalsRightHtml = (isIntraState ? `
      <div class="inv-totals-row">
        <span class="inv-totals-label" style="font-weight: bold;">CGST</span>
        <span class="inv-totals-val">${totalCGST.toFixed(2)}</span>
      </div>
      <div class="inv-totals-row">
        <span class="inv-totals-label" style="font-weight: bold;">SGST</span>
        <span class="inv-totals-val">${totalSGST.toFixed(2)}</span>
      </div>
    ` : `
      <div class="inv-totals-row">
        <span class="inv-totals-label" style="font-weight: bold;">IGST</span>
        <span class="inv-totals-val">${totalIGST.toFixed(2)}</span>
      </div>
    `) + `
      <div class="inv-totals-row">
        <span class="inv-totals-label">Round off</span>
        <span class="inv-totals-val">${roundOff.toFixed(2)}</span>
      </div>
    `;

    body.innerHTML = `
      <div class="invoice-sheet-container">
        <div class="invoice-sheet" id="debit-note-slip-sheet">
          <!-- Brand Headers -->
          <div class="inv-top-row">
            <div class="inv-logo-area">
              <img class="inv-logo-img" src="${(window.MFP_ASSETS && window.MFP_ASSETS.logoMorella) || 'logo_morella.jpg'}" alt="Morella Farmpro Logo" onerror="this.style.display='none'">
            </div>
            
            <div class="inv-contact-area">
              <div style="font-weight: bold; color: #2e7d32 !important; margin-bottom: 2px;">info@mfpco.in</div>
              <div style="font-weight: bold; color: #2e7d32 !important; margin-bottom: 4px;">www.mfpco.in</div>
              <div>B210, Sussex Industrial Estate, DK Cross Marg,</div>
              <div>Byculla (E), Mumbai 400027</div>
              <div style="margin-top: 4px;"><strong>LLPIN:</strong> ACB-0349</div>
              <div><strong>GST No.</strong> 24ABXFM1791N1ZE</div>
            </div>
          </div>

          <div class="inv-title">DEBIT NOTE</div>

          <!-- 3-Column Seller details & PO / Invoice details Grid -->
          <div class="inv-details-grid">
            <!-- Column 1: Issuer Details -->
            <div class="inv-grid-cell" style="flex: 1.5; border-right: 1px solid #000000; padding: 6px;">
              <div style="font-weight: bold; font-size: 13px;">MORELLA FARMPRO LLP</div>
              <div style="font-size: 11.5px; line-height: 1.35; margin-top: 4px;">
                Survey No 544 Dahad village, Umbergaon, Valsad, Gujarat Pin code 396170<br>
                <strong>Email:</strong> info@mfpco.in
              </div>
            </div>
            <!-- Column 2: Ref / DN No -->
            <div class="inv-grid-cell" style="flex: 1; border-right: 1px solid #000000; padding: 0; display: flex; flex-direction: column;">
              <div style="flex: 1; border-bottom: 1px solid #000000; padding: 5px 6px; display: flex; flex-direction: column; justify-content: center;">
                <div class="inv-grid-label" style="font-size: 10.5px; margin-bottom: 1px;">Original Inward/Bill Ref:</div>
                <div class="inv-grid-value" style="font-size: 12px; font-weight: bold;">${this.escapeHtml(dn.original_invoice_ref || 'N/A')}</div>
              </div>
              <div style="flex: 1; padding: 5px 6px; display: flex; flex-direction: column; justify-content: center;">
                <div class="inv-grid-label" style="font-size: 10.5px; margin-bottom: 1px;">Debit Note No.:</div>
                <div class="inv-grid-value" style="font-size: 12px; font-weight: bold; color:#dc2626;">${this.escapeHtml(dn.debit_note_no)}</div>
              </div>
            </div>
            <!-- Column 3: Dated / Date -->
            <div class="inv-grid-cell" style="flex: 1; padding: 0; display: flex; flex-direction: column;">
              <div style="flex: 1; border-bottom: 1px solid #000000; padding: 5px 6px; display: flex; flex-direction: column; justify-content: center;">
                <div class="inv-grid-label" style="font-size: 10.5px; margin-bottom: 1px;">Rejection Reason:</div>
                <div class="inv-grid-value" style="font-size: 11.5px; font-weight: bold;">${this.escapeHtml(dn.reason || 'Defective Goods')}</div>
              </div>
              <div style="flex: 1; padding: 5px 6px; display: flex; flex-direction: column; justify-content: center;">
                <div class="inv-grid-label" style="font-size: 10.5px; margin-bottom: 1px;">Date:</div>
                <div class="inv-grid-value" style="font-size: 12px; font-weight: bold;">${dn.date || ''}</div>
              </div>
            </div>
          </div>

          <!-- 2-Column Buyer / Vendor & Return Address Grid -->
          <div class="inv-details-grid" style="border-bottom: 1px solid #000000;">
            <div class="inv-grid-cell" style="flex: 1.2; border-right: 1px solid #000000; padding: 6px; display: flex; flex-direction: column; justify-content: space-between; min-height: 70px;">
              <div>
                <div class="inv-grid-label" style="font-size: 10.5px; margin-bottom: 2px;">To / Vendor / Supplier:</div>
                <div class="inv-grid-value" style="font-size: 13px; font-weight: bold;">${this.escapeHtml(dn.vendor_name)}</div>
                <div class="inv-grid-value" style="font-size: 11.5px; font-weight: normal; margin-top: 4px; line-height: 1.3;">${this.escapeHtml(dn.vendor_address || 'Vendor Registered Address')}</div>
              </div>
              <div style="margin-top: 6px; font-size: 12px; font-weight: bold;">
                <span class="inv-grid-label" style="font-size: 10.5px; text-transform: uppercase;">GSTIN:</span> ${this.escapeHtml(dn.vendor_gstin || 'Unregistered')}
              </div>
            </div>
            <div class="inv-grid-cell" style="flex: 1; padding: 6px; display: flex; flex-direction: column; justify-content: flex-start; text-align: left;">
              <div class="inv-grid-label" style="font-size: 10.5px; margin-bottom: 2px;">Return Dispatch Address / Notes:</div>
              <div class="inv-grid-value" style="font-size: 11.5px; font-weight: normal; line-height: 1.35; white-space: pre-wrap;">${this.escapeHtml(dn.notes || 'Defective goods rejected upon delivery inspection. Transporter returned or held at warehouse for supplier pickup.')}</div>
              ${dn.photo_proof ? `
                <div style="margin-top: 6px; display:flex; align-items:center; gap:6px;">
                  <span style="font-size:10px; font-weight:bold; color:#555;">Defect Proof:</span>
                  <img src="${dn.photo_proof}" alt="Proof" style="height:35px; border:1px solid #000; object-fit:contain;">
                </div>
              ` : ''}
            </div>
          </div>

          <!-- Items table -->
          <table class="inv-items-table">
            <thead>
              <tr>
                <th style="width: 12%">HSN/SAC</th>
                <th style="width: 34%">Description of Defective Goods</th>
                <th style="width: 6%">GST</th>
                <th style="width: 9%">Qty</th>
                <th style="width: 9%">Rate</th>
                <th style="width: 7%">Disc.</th>
                ${taxHeader}
                <th style="width: 13%">Amount (Rs.)</th>
              </tr>
            </thead>
            <tbody>
              ${tableRowsHtml}
            </tbody>
          </table>

          <!-- Totals Block -->
          <div class="inv-totals-box">
            <div class="inv-totals-left">
              ${botGstDetails}
            </div>
            <div class="inv-totals-right">
              ${totalsRightHtml}
            </div>
          </div>

          <!-- Words and net total -->
          <div class="inv-words-net-row">
            <div class="inv-words-cell">
              <span class="inv-grid-label">Amount in Words:</span>
              <span class="inv-grid-value" style="font-size: 13px;">${amountInWords}</span>
            </div>
            <div class="inv-net-cell">
              <span style="font-weight: bold; font-size: 13px;">Total Debit (Rs.)</span>
              <span style="font-weight: bold; font-size: 15px; text-decoration: underline;">₹ ${roundedGrandTotal.toFixed(2)}</span>
            </div>
          </div>

          <!-- Remarks Section -->
          <div class="inv-remarks-box" style="border: 1px solid #000000; border-top: none; padding: 6px 8px; font-size: 11px; line-height: 1.45; text-align: left; background: #ffffff;">
            <div style="margin-bottom: 2px;"><strong>Debit Terms:</strong> Value of returned defective goods debited to vendor account. To be adjusted against pending payables or refunded.</div>
            ${dn.reason ? `<div><strong>Rejection Specification:</strong> ${this.escapeHtml(dn.reason)}</div>` : ''}
          </div>

          <!-- Beneficiary & Signature Footer -->
          <div class="inv-footer-row">
            <div class="inv-beneficiary-box">
              <div class="inv-beneficiary-title">Beneficiary / Bank Details</div>
              <div class="inv-beneficiary-grid">
                <span class="inv-beneficiary-label">Bank Name</span>
                <span class="inv-beneficiary-val">State Bank of India</span>
                
                <span class="inv-beneficiary-label">Branch</span>
                <span class="inv-beneficiary-val">Kemps Corner, Mumbai</span>
                
                <span class="inv-beneficiary-label">Beneficiary name</span>
                <span class="inv-beneficiary-val">Morella Farmpro LLP</span>
                
                <span class="inv-beneficiary-label">A/C No.</span>
                <span class="inv-beneficiary-val">41973685223</span>
                
                <span class="inv-beneficiary-label">IFSC Code</span>
                <span class="inv-beneficiary-val">SBIN0000527</span>
                
                <span class="inv-beneficiary-label">A/C Type</span>
                <span class="inv-beneficiary-val">Current Account</span>
              </div>
            </div>

            <div class="inv-brand-box">
              <img class="inv-brand-logo" src="${(window.MFP_ASSETS && window.MFP_ASSETS.logoTruflavr) || 'logo_truflavr.png'}" alt="truFLAVR Logo" onerror="this.style.display='none'">
            </div>

            <div class="inv-signature-box" style="display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end;">
              <div class="inv-signature-label" style="align-self: flex-end;">Authorised Signature</div>
              <div style="margin: 4px 0; text-align: right;">
                <!-- Real signature image containing "For Morella Farmpro LLP", the partner signature, and "Designated Partner" -->
                <img src="${(window.MFP_ASSETS && window.MFP_ASSETS.signature) || 'signature.jpg'}" alt="Signature" style="height: 55px; width: auto; object-fit: contain;">
              </div>
              <div class="inv-signature-date-row" style="width: 100%; justify-content: flex-end;">
                <span class="inv-signature-date-label" style="margin-right: 10px;">Date</span>
                <div class="inv-signature-date-box">${dn.date || ''}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.openModal('modal-debit-note-slip');
  }

  async downloadActiveDebitSlipPdf() {
    const btn = document.getElementById('btn-dn-download-pdf');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating PDF...`;
    }

    try {
      const el = document.getElementById('debit-note-slip-sheet');
      if (!el) {
        alert("Slip sheet element not found.");
        return;
      }
      const dnNo = (this.activeDebitNoteSlip && this.activeDebitNoteSlip.debit_note_no) ? this.activeDebitNoteSlip.debit_note_no : 'Debit_Note';
      const cleanFilename = `${dnNo.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;

      if (typeof html2pdf !== 'undefined') {
        const opt = {
          margin: [3, 3, 3, 3],
          filename: cleanFilename,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: {
            scale: 2,
            useCORS: true,
            allowTaint: true,
            scrollY: 0,
            scrollX: 0,
            logging: false
          },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
        };
        await html2pdf().set(opt).from(el).save();
      } else {
        alert("PDF generator library not loaded. Opening standard print window to Save as PDF...");
        window.print();
      }
    } catch (err) {
      console.error("PDF generation error:", err);
      alert("Direct PDF export encountered an error (" + (err.message || err) + "). Opening print window so you can Save as PDF...");
      window.print();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml || `<i class="fa-solid fa-file-pdf"></i> Download Signed PDF`;
      }
    }
  }

  printDebitSlip() {
    window.print();
  }

  async deleteDebitNoteEntry(id) {
    if (!confirm("Are you sure you want to delete this Debit Note?")) return;
    await this.db.deleteDebitNote(id);
    await this.renderRecentDebitNotesList();
    await this.refreshAllViews();
  }

  numberToIndianWords(num) {
    if (!num || num === 0) return 'Zero Rupees Only';
    const a = [
      '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
      'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'
    ];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function g(n) {
      if (n < 20) return a[n];
      const digit = n % 10;
      return b[Math.floor(n / 10)] + (digit ? ' ' + a[digit] : '');
    }

    function translate(n) {
      let str = "";
      if (n >= 10000000) {
        str += translate(Math.floor(n / 10000000)) + " Crore ";
        n %= 10000000;
      }
      if (n >= 100000) {
        str += translate(Math.floor(n / 100000)) + " Lakh ";
        n %= 100000;
      }
      if (n >= 1000) {
        str += translate(Math.floor(n / 1000)) + " Thousand ";
        n %= 1000;
      }
      if (n >= 100) {
        str += g(Math.floor(n / 100)) + " Hundred ";
        n %= 100;
      }
      if (n > 0) {
        if (str !== "") str += "and ";
        str += g(n);
      }
      return str.trim();
    }

    return 'Rupees ' + translate(Math.floor(num)) + ' Only';
  }

  // --- 2C. MATERIAL RETURNED (CREDIT NOTE / SALES RETURN) WORKFLOW ---

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

    const products = await this.db.getProducts();
    const categories = ['Bottles', 'Pouches', 'Sachets', 'Horeca'];
    const fragment = document.createDocumentFragment();

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
      fragment.appendChild(box);
    });

    container.innerHTML = '';
    container.appendChild(fragment);

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
      this.productionItems = [{ product_id: '', quantity: '' }];
      await this.renderProductionItems();
    } else {
      const container = document.getElementById('production-items-container');
      if (container && container.children.length === 0) {
        await this.renderProductionItems();
      }
    }

    // Render Recent Production Runs History
    const historyList = document.getElementById('production-history-list');
    if (historyList) {
      const runs = await this.db.getProductions();
      historyList.innerHTML = '';
      if (!runs || runs.length === 0) {
        historyList.innerHTML = '<div class="td-muted italic text-center" style="padding:0.75rem;">No production runs logged yet.</div>';
      } else {
        runs.slice(0, 20).forEach(run => {
          const card = document.createElement('div');
          card.className = 'stock-cover-item';
          card.style.flexDirection = 'column';
          card.style.alignItems = 'stretch';
          card.style.gap = '0.35rem';
          card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-weight:700; font-size:0.85rem; color:var(--color-primary);"><i class="fa-solid fa-industry"></i> ${run.product_name || 'Finished Good'}</span>
              <span class="badge" style="background:rgba(16, 185, 129, 0.15); color:#10b981; font-size:0.7rem;">${run.date || (run.created_at || '').slice(0, 10)}</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.78rem;">
              <span class="td-muted">${run.packaging_type || 'Pack'}${run.batch_ref ? ' • ' + run.batch_ref : ''}</span>
              <div style="display:flex; align-items:center; gap:0.4rem;">
                <span style="font-weight:700; color:var(--text-main); font-size:0.85rem;">+${run.quantity_produced} pcs</span>
                <button type="button" class="btn btn-secondary btn-sm" onclick="app.deleteProduction('${run.id}')" title="Delete accidental batch" style="color:var(--color-danger); border:1px solid rgba(239, 68, 68, 0.4); background:rgba(239, 68, 68, 0.08); padding:0.15rem 0.45rem; font-size:0.72rem; border-radius:4px;">
                  <i class="fa-solid fa-trash-can"></i> Delete
                </button>
              </div>
            </div>
          `;
          historyList.appendChild(card);
        });
      }
    }

    await this.updateAggregatedRecipeChecklist();
  }

  switchProductionCategory(cat, btn) {
    this.currentProductionCategory = cat;
    
    document.querySelectorAll('.sub-tabs-bar .sub-tab-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Category filter sets default packaging for newly added SKUs; does not destructively rebuild existing entered rows
  }

  createProductionRowElement(item, index, products) {
    const box = document.createElement('div');
    box.className = 'multi-item-box';
    box.setAttribute('data-production-index', index);

    // Group products by packaging category
    const categories = ['Bottles', 'Pouches', 'Sachets', 'Horeca'];

    let optionsHtml = `<option value="" disabled ${!item.product_id ? 'selected' : ''}>-- Select Product SKU --</option>`;

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

    const showRemove = this.productionItems.length > 1;

    box.innerHTML = `
      <div class="multi-item-header">
        <span class="production-sku-header-title"><i class="fa-solid fa-tag"></i> Finished Good SKU #${index + 1}</span>
        <button type="button" class="multi-item-remove-btn" onclick="app.removeProductionSKURow(${index})" style="display:${showRemove ? 'inline-flex' : 'none'};"><i class="fa-solid fa-trash-can"></i> Remove</button>
      </div>
      <div class="form-group" style="margin-bottom:0.45rem;">
        <select class="form-control prod-sku-select" style="font-size:0.8rem; padding:0.35rem 0.5rem;" onchange="app.updateProductionSKU(${index}, 'product_id', this.value)">
          ${optionsHtml}
        </select>
      </div>
      <div class="form-row" style="margin-bottom:0.25rem;">
        <div class="form-group" style="margin-bottom:0; flex:1;">
          <label style="font-size:0.7rem; color:var(--text-muted); margin-bottom:0.2rem;">Batch Qty (pcs) *</label>
          <input type="number" step="1" min="1" class="form-control prod-qty-input" style="font-size:0.8rem; padding:0.35rem 0.5rem;" value="${item.quantity || ''}" placeholder="Pieces" oninput="app.updateProductionSKU(${index}, 'quantity', this.value)">
        </div>
      </div>
    `;
    return box;
  }

  appendSingleProductionRow(item, index, products) {
    const container = document.getElementById('production-items-container');
    if (!container) return;

    const box = this.createProductionRowElement(item, index, products);
    container.appendChild(box);
    this.refreshProductionRemoveButtons();

    try {
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (_) {}
  }

  refreshProductionRemoveButtons() {
    const container = document.getElementById('production-items-container');
    if (!container) return;
    const boxes = container.querySelectorAll('.multi-item-box');
    boxes.forEach(box => {
      const removeBtn = box.querySelector('.multi-item-remove-btn');
      if (removeBtn) {
        removeBtn.style.display = boxes.length > 1 ? 'inline-flex' : 'none';
      }
    });
  }

  reindexProductionRows() {
    const container = document.getElementById('production-items-container');
    if (!container) return;
    const boxes = container.querySelectorAll('.multi-item-box');
    boxes.forEach((box, idx) => {
      box.setAttribute('data-production-index', idx);
      const title = box.querySelector('.production-sku-header-title');
      if (title) {
        title.innerHTML = `<i class="fa-solid fa-tag"></i> Finished Good SKU #${idx + 1}`;
      }
      const removeBtn = box.querySelector('.multi-item-remove-btn');
      if (removeBtn) {
        removeBtn.setAttribute('onclick', `app.removeProductionSKURow(${idx})`);
        removeBtn.style.display = boxes.length > 1 ? 'inline-flex' : 'none';
      }
      const select = box.querySelector('.prod-sku-select');
      if (select) {
        select.setAttribute('onchange', `app.updateProductionSKU(${idx}, 'product_id', this.value)`);
      }
      const qtyInput = box.querySelector('.prod-qty-input');
      if (qtyInput) {
        qtyInput.setAttribute('oninput', `app.updateProductionSKU(${idx}, 'quantity', this.value)`);
      }
    });
  }

  async addProductionSKURow() {
    const products = await this.db.getProducts();
    const newItem = {
      product_id: '',
      quantity: ''
    };
    this.productionItems.push(newItem);

    // Smooth single row append - no screen refresh, no loss of typed inputs
    this.appendSingleProductionRow(newItem, this.productionItems.length - 1, products);
    this.updateProductionSummary();
    this.scheduleDebouncedAggregatedChecklist();
  }

  removeProductionSKURow(index) {
    if (this.productionItems.length <= 1) return;

    this.productionItems.splice(index, 1);

    const container = document.getElementById('production-items-container');
    if (container) {
      const boxes = container.querySelectorAll('.multi-item-box');
      if (boxes[index]) {
        boxes[index].remove();
      }
      this.reindexProductionRows();
    }

    this.updateProductionSummary();
    this.scheduleDebouncedAggregatedChecklist();
  }

  updateProductionSummary() {
    const totalPcs = this.productionItems.reduce((sum, item) => sum + (parseInt(item.quantity, 10) || 0), 0);
    const totalQtyBadge = document.getElementById('production-total-qty');
    if (totalQtyBadge) {
      totalQtyBadge.textContent = `${totalPcs} pcs total`;
    }

    const submitBtn = document.getElementById('production-submit-btn');
    if (submitBtn) {
      submitBtn.innerHTML = `<i class="fa-solid fa-gears"></i> Record Daily Batch (${totalPcs} pcs across ${this.productionItems.length} SKUs)`;
    }
  }

  updateProductionSKU(index, field, val) {
    if (!this.productionItems[index]) return;

    if (field === 'product_id') {
      this.productionItems[index].product_id = val;
    } else if (field === 'quantity') {
      this.productionItems[index].quantity = parseInt(val, 10) || 0;
    }

    this.updateProductionSummary();
    this.scheduleDebouncedAggregatedChecklist();
  }

  scheduleDebouncedAggregatedChecklist() {
    if (this._recipeDebounceTimer) {
      clearTimeout(this._recipeDebounceTimer);
    }
    this._recipeDebounceTimer = setTimeout(() => {
      this.updateAggregatedRecipeChecklist();
    }, 250);
  }

  async renderProductionItems() {
    const container = document.getElementById('production-items-container');
    if (!container) return;

    this._renderItemsReqId = (this._renderItemsReqId || 0) + 1;
    const reqId = this._renderItemsReqId;

    // Fetch products first so container is NOT wiped before data is ready
    const products = await this.db.getProducts();
    if (reqId !== this._renderItemsReqId) return; // Stale render request

    const fragment = document.createDocumentFragment();
    this.productionItems.forEach((item, index) => {
      const box = this.createProductionRowElement(item, index, products);
      fragment.appendChild(box);
    });

    // Atomic replacement - prevents race conditions, duplicated DOM elements and blank screen flicker
    container.innerHTML = '';
    container.appendChild(fragment);

    this.updateProductionSummary();
  }

  // Pre-production forecast: aggregates BOM raw materials across ALL active SKUs
  async updateAggregatedRecipeChecklist() {
    const list = document.getElementById('production-checklist');
    const statusEl = document.getElementById('production-checklist-status');
    if (!list) return;

    this._checklistReqId = (this._checklistReqId || 0) + 1;
    const reqId = this._checklistReqId;

    // Fetch data first before touching DOM to avoid async duplication
    const products = await this.db.getProducts();
    const rawMaterials = await this.db.getRawMaterials();
    if (reqId !== this._checklistReqId) return; // Stale checklist request

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
      if (statusEl) {
        statusEl.textContent = '0 SKUs evaluated';
        statusEl.style.color = 'var(--text-dim)';
      }
      return;
    }

    let hasShortage = false;
    let deficitCount = 0;
    const fragment = document.createDocumentFragment();

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
      fragment.appendChild(itemDiv);
    });

    // Atomic DOM replacement - eliminates duplicate items
    list.innerHTML = '';
    list.appendChild(fragment);

    if (statusEl) {
      statusEl.textContent = hasShortage 
        ? `⚠️ ${deficitCount} Ingredient Shortage(s)` 
        : `✓ All ${matIds.length} Ingredients in Stock`;
      statusEl.style.color = hasShortage ? 'var(--color-danger)' : 'var(--color-success)';
    }
  }

  async handleProductionSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();

    try {
      const dateInput = document.getElementById('production-date');
      const prodDate = (dateInput && dateInput.value) ? dateInput.value : this.getTodayDate();
      const batchRefInput = document.getElementById('production-batch-ref');
      const batchRef = batchRefInput ? batchRefInput.value.trim() : '';

      if (!this.productionItems || this.productionItems.length === 0) {
        alert("Please add at least one Finished Good SKU to the production batch.");
        return;
      }

      // Filter and validate only filled rows
      const validItems = this.productionItems.filter(it => it.product_id && parseInt(it.quantity, 10) > 0);
      if (validItems.length === 0) {
        alert("Please select a Finished Good SKU and specify a valid batch quantity (pcs).");
        return;
      }

      const products = await this.db.getProducts();
      const rawMaterials = await this.db.getRawMaterials();

      // Check aggregated ingredient deficits
      const aggregated = {};
      validItems.forEach(item => {
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

      // Commit each valid production run SKU
      for (let i = 0; i < validItems.length; i++) {
        const it = validItems[i];
        const prod = products.find(p => p.id === it.product_id);
        if (prod) {
          const qty = parseInt(it.quantity, 10) || 0;
          totalBatchPcs += qty;

          await this.db.insertProduction({
            date: prodDate,
            batch_ref: batchRef || undefined,
            product_id: prod.id,
            product_name: prod.name,
            quantity_produced: qty,
            packaging_type: prod.packaging_type
          });

          itemsTextList += `${i + 1}. *${prod.name}* (${prod.code})\n` +
                           `   • Output: *${qty} pcs* (${prod.packaging_type})\n`;
        }
      }

      // Compile WhatsApp Production Log
      const waText = `🏭 *MFP ERP - Daily Production Run Log*\n` +
                     `• *Date:* ${prodDate}\n` +
                     (batchRef ? `• *Batch / Shift:* ${batchRef}\n` : '') +
                     `• *Total Finished Goods Output:* ${totalBatchPcs} pcs across ${validItems.length} SKUs\n\n` +
                     `*Manufactured SKUs:*\n` +
                     itemsTextList +
                     `\n_Raw materials deducted based on BOM recipes & Finished Goods warehouse updated. Logged via MFP Mobile Console._`;

      const waTextEl = document.getElementById('production-wa-text');
      if (waTextEl) waTextEl.value = waText;
      const waWidget = document.getElementById('production-wa-widget');
      if (waWidget) waWidget.classList.remove('hidden');

      const prevCount = validItems.length;
      const formEl = document.getElementById('production-form');
      if (formEl) formEl.reset();

      this.productionItems = [{ product_id: '', quantity: '' }];
      this.initDateInputs();

      await this.renderProductionPane();
      await this.refreshAllViews();
      alert(`Success! Recorded daily batch of ${totalBatchPcs} pcs across ${prevCount} SKU(s) on ${prodDate}!\n\nRaw materials debited & Finished Goods warehouse credited.`);
    } catch (err) {
      console.error("Failed to record production batch:", err);
      alert("Error recording production batch: " + (err.message || err));
    }
  }

  async deleteProduction(id) {
    if (!id) return;
    const productions = await this.db.getProductions();
    const run = productions.find(p => p.id === id);
    if (!run) {
      alert("Production run not found.");
      return;
    }

    const confirmMsg = `Are you sure you want to delete this production batch?\n\n• Product: ${run.product_name}\n• Quantity: ${run.quantity_produced} pcs\n• Date: ${run.date || (run.created_at || '').slice(0, 10)}\n\nThis will reverse the batch: Finished Goods stock will decrease by ${run.quantity_produced} pcs, and raw materials will be credited back to the warehouse.`;
    if (!confirm(confirmMsg)) return;

    try {
      const products = await this.db.getProducts();
      const rawMaterials = await this.db.getRawMaterials();
      const targetProduct = products.find(p => p.id === run.product_id);

      if (targetProduct) {
        // 1. Revert Finished Goods Stock
        const currentFG = parseFloat(targetProduct.current_stock || 0);
        const newFGStock = Math.max(0, currentFG - parseFloat(run.quantity_produced));
        await this.db.updateProductStock(targetProduct.id, newFGStock);

        // 2. Restore Raw Materials based on BOM
        if (Array.isArray(targetProduct.bom)) {
          for (const recipe of targetProduct.bom) {
            const mat = rawMaterials.find(m => m.id === recipe.material_id);
            if (mat) {
              const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage || 0) / 100);
              const restoredQty = parseFloat(recipe.quantity) * parseFloat(run.quantity_produced) * wasteFactor;
              const newRMStock = parseFloat(mat.current_stock || 0) + restoredQty;
              await this.db.updateMaterialStock(mat.id, newRMStock, mat.average_price);
            }
          }
        }
      }

      // 3. Delete from Supabase cloud if connected
      if (this.db.config.isOnline && this.db.supabase) {
        try {
          const { error } = await this.db.supabase.from('productions').delete().eq('id', id);
          if (error) console.error("Error deleting production from Supabase:", error);
        } catch (e) {
          console.error("Supabase delete production error:", e);
        }
      }

      // 4. Delete from offline DB
      if (this.db.offlineDb.productions) {
        this.db.offlineDb.productions = this.db.offlineDb.productions.filter(p => p.id !== id);
        this.db.saveOfflineDb();
      }

      await this.renderProductionPane();
      await this.refreshAllViews();
      alert(`✓ Successfully deleted batch of ${run.product_name} (${run.quantity_produced} pcs). Inventory stock reversed.`);
    } catch (err) {
      console.error("Error deleting production batch:", err);
      alert("Failed to delete production batch: " + (err.message || err));
    }
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

    // Initialize & render sample dispatch items
    await this.renderSampleItems();
  }

  // --- SALE OUTWARD DISPATCH: PDF INVOICE & PHOTO PARSING & BATCH PROCESSING ---

  async handleOutwardUpload(file) {
    if (file) {
      await this.handleOutwardUploadMultiple([file]);
    }
  }

  async handleOutwardUploadMultiple(fileList) {
    if (!fileList || fileList.length === 0) return;

    const files = Array.from(fileList).filter(f => 
      f.type === 'application/pdf' || 
      f.name.toLowerCase().endsWith('.pdf') ||
      f.type.startsWith('image/') ||
      /\.(jpe?g|png|gif|bmp|webp)$/i.test(f.name)
    );

    if (files.length === 0) {
      alert("Please select one or more PDF sales invoices or invoice photos/images.");
      return;
    }

    this.batchOutwardInvoices = [];
    this.activeBatchOutwardIdx = 0;

    const loadingDiv = document.getElementById('inward-loading-spinner');
    const spinnerText = document.getElementById('inward-spinner-text');
    if (loadingDiv) {
      loadingDiv.style.display = 'flex';
      if (spinnerText) spinnerText.textContent = `Processing ${files.length} invoice(s)...`;
    }

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        let rawText = '';
        let imagePreviewUrl = null;

        if (spinnerText) {
          spinnerText.textContent = `Scanning invoice ${i + 1}/${files.length} (${file.name})...`;
        }

        try {
          if (isPdf) {
            rawText = await this.parsePDFText(file);
          } else {
            imagePreviewUrl = await new Promise((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result);
              r.onerror = () => resolve(null);
              r.readAsDataURL(file);
            });
            rawText = await this.parseImageText(file);
          }

          const extracted = this.heuristicsExtractSale(rawText, file.name);
          this.batchOutwardInvoices.push({
            fileName: file.name,
            imagePreviewUrl: imagePreviewUrl,
            invoice_no: extracted.invoice_no,
            date: extracted.date,
            customer: extracted.customer || 'Customer Dispatch',
            gstin: extracted.gstin || '',
            net_amount: extracted.net_amount || 0,
            products: extracted.products
          });
        } catch (e) {
          console.error("Error parsing sales invoice: " + file.name, e);
        }
      }
    } finally {
      if (loadingDiv) {
        loadingDiv.style.display = 'none';
      }
    }

    if (this.batchOutwardInvoices.length === 0) {
      alert("Could not extract sales invoice details from the selected file(s). Please verify the file format.");
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

    // Display photo/image preview thumbnail if available
    const imgContainer = document.getElementById('vo-image-preview-container');
    const imgEl = document.getElementById('vo-image-preview');
    if (imgContainer && imgEl) {
      if (cur.imagePreviewUrl) {
        imgEl.src = cur.imagePreviewUrl;
        imgContainer.style.display = 'block';
        const wrapper = document.getElementById('vo-image-wrapper');
        if (wrapper) wrapper.style.display = 'block';
        const toggleBtn = document.getElementById('vo-photo-toggle-btn');
        if (toggleBtn) toggleBtn.textContent = 'Collapse';
      } else {
        imgContainer.style.display = 'none';
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
    this.updateVerifyOutwardSummary();
    this.openModal('modal-verify-outward');
  }

  toggleOutwardPhotoPreview() {
    const wrapper = document.getElementById('vo-image-wrapper');
    const btn = document.getElementById('vo-photo-toggle-btn');
    if (!wrapper || !btn) return;
    if (wrapper.style.display === 'none') {
      wrapper.style.display = 'block';
      btn.textContent = 'Collapse';
    } else {
      wrapper.style.display = 'none';
      btn.textContent = 'Expand';
    }
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
        <td style="text-align:center; vertical-align:middle;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="app.removeVerifyOutwardRow(${index})" style="padding:0.2rem 0.4rem; font-size:0.7rem; color:var(--danger);" title="Remove line item">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  async addVerifyOutwardRow() {
    const products = await this.db.getProducts();
    const firstProd = products.length > 0 ? products[0] : { id: '', selling_price: 0, name: 'Finished Good' };
    this.currentVerifyOutwardItems.push({
      raw_text_name: firstProd.name || 'New Item',
      hsn: '',
      product_id: firstProd.id || '',
      quantity_sold: 1,
      rate: firstProd.selling_price || 0,
      discount: 0,
      amount: firstProd.selling_price || 0
    });
    this.renderVerifyOutwardRows();
    this.updateVerifyOutwardSummary();
  }

  removeVerifyOutwardRow(index) {
    if (this.currentVerifyOutwardItems.length <= 1) {
      alert("At least one line item is required. Use Discard Invoice if you wish to skip this invoice.");
      return;
    }
    this.currentVerifyOutwardItems.splice(index, 1);
    this.renderVerifyOutwardRows();
    this.updateVerifyOutwardSummary();
  }

  updateVerifyOutwardSummary() {
    let totalAmt = 0;
    let totalPcs = 0;
    if (this.currentVerifyOutwardItems) {
      this.currentVerifyOutwardItems.forEach(it => {
        const lineTotal = (it.quantity_sold || 0) * Math.max(0, (it.rate || 0) - (it.discount || 0));
        totalAmt += lineTotal;
        totalPcs += (it.quantity_sold || 0);
      });
    }
    const netEl = document.getElementById('vo-net-amount');
    if (netEl) netEl.innerHTML = `<i class="fa-solid fa-receipt"></i> Net Amount: Rs. ${totalAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    const countEl = document.getElementById('vo-item-count');
    if (countEl) countEl.textContent = `${this.currentVerifyOutwardItems.length} item(s) (${totalPcs} pcs)`;

    if (this.batchOutwardInvoices && this.batchOutwardInvoices[this.activeBatchOutwardIdx]) {
      this.batchOutwardInvoices[this.activeBatchOutwardIdx].net_amount = totalAmt;
    }
  }

  updateVerifyOutwardItem(index, key, val) {
    if (this.currentVerifyOutwardItems[index]) {
      if (key === 'product_id') {
        this.currentVerifyOutwardItems[index].product_id = val;
        const prod = this.db.offlineDb.products.find(p => p.id === val);
        if (prod && !this.currentVerifyOutwardItems[index].rate) {
          this.currentVerifyOutwardItems[index].rate = prod.selling_price || 0;
          this.renderVerifyOutwardRows();
          this.updateVerifyOutwardSummary();
          return;
        }
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
      this.updateVerifyOutwardSummary();
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

  // --- SAMPLE DISPATCH (NO INVOICE) WORKFLOW ---

  switchOutwardSubSection(mode) {
    this.currentOutwardSubSection = mode;
    const btnInvoice = document.getElementById('btn-outward-invoice');
    const btnSample = document.getElementById('btn-outward-sample');
    const secInvoice = document.getElementById('outward-invoice-section');
    const secSample = document.getElementById('outward-sample-section');

    if (mode === 'sample') {
      if (btnInvoice) btnInvoice.classList.remove('active');
      if (btnSample) btnSample.classList.add('active');
      if (secInvoice) secInvoice.style.display = 'none';
      if (secSample) secSample.style.display = 'block';

      const sampleDateEl = document.getElementById('sample-date');
      if (sampleDateEl && !sampleDateEl.value) {
        sampleDateEl.value = this.getTodayDate();
      }
      this.renderSampleItems();
    } else {
      if (btnSample) btnSample.classList.remove('active');
      if (btnInvoice) btnInvoice.classList.add('active');
      if (secSample) secSample.style.display = 'none';
      if (secInvoice) secInvoice.style.display = 'block';
    }
  }

  switchSampleCategory(cat, btn) {
    this.currentSampleCategory = cat;
    const tabBtns = document.querySelectorAll('#sample-cat-tabs .sub-tab-btn');
    tabBtns.forEach(b => b.classList.remove('active'));
    if (btn) {
      btn.classList.add('active');
    }
    this.renderSampleItems();
  }

  async renderSampleItems() {
    const container = document.getElementById('sample-items-container');
    if (!container) return;

    const products = await this.db.getProducts();
    if (this.sampleItems.length === 0) {
      const firstId = products.length > 0 ? products[0].id : '';
      this.sampleItems = [{ product_id: firstId, quantity: 1 }];
    }

    // Filter products if category is selected
    let filteredProducts = products;
    if (this.currentSampleCategory && this.currentSampleCategory !== 'All') {
      const catLower = this.currentSampleCategory.toLowerCase();
      filteredProducts = products.filter(p => {
        const pkg = (p.packaging_type || '').toLowerCase();
        const name = (p.name || '').toLowerCase();
        if (catLower.startsWith('bottle')) return pkg.includes('bottle') || name.includes('bottle');
        if (catLower.startsWith('pouch')) return pkg.includes('pouch') || name.includes('pouch');
        if (catLower.startsWith('sachet')) return pkg.includes('sachet') || name.includes('sachet');
        return true;
      });
      if (filteredProducts.length === 0) {
        filteredProducts = products;
      }
    }

    container.innerHTML = '';
    let totalQty = 0;

    this.sampleItems.forEach((item, index) => {
      totalQty += (parseInt(item.quantity, 10) || 0);

      const row = document.createElement('div');
      row.className = 'sample-item-row';
      row.style.cssText = 'display:flex; gap:0.4rem; align-items:flex-end; margin-bottom:0.5rem; background:rgba(255,255,255,0.03); padding:0.4rem; border-radius:6px; border:1px solid var(--border-light);';

      let optHtml = '<option value="" disabled ' + (!item.product_id ? 'selected' : '') + '>-- Select SKU --</option>';
      filteredProducts.forEach(p => {
        const sel = p.id === item.product_id ? 'selected' : '';
        const stock = Math.round(parseFloat(p.current_stock || 0));
        optHtml += `<option value="${p.id}" ${sel}>${p.name} [${p.packaging_type}] (${stock} in stock)</option>`;
      });

      if (item.product_id && !filteredProducts.some(p => p.id === item.product_id)) {
        const currP = products.find(p => p.id === item.product_id);
        if (currP) {
          const stock = Math.round(parseFloat(currP.current_stock || 0));
          optHtml = `<option value="${currP.id}" selected>${currP.name} [${currP.packaging_type}] (${stock} in stock)</option>` + optHtml;
        }
      }

      row.innerHTML = `
        <div style="flex: 1; min-width: 0;">
          <label style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 0.15rem; display: block;">SKU #${index + 1} *</label>
          <select class="form-control" style="font-size:0.78rem; padding:0.35rem 0.45rem;" onchange="app.updateSampleItem(${index}, 'product_id', this.value)">
            ${optHtml}
          </select>
        </div>
        <div style="width: 85px;">
          <label style="font-size: 0.7rem; color: var(--text-muted); margin-bottom: 0.15rem; display: block;">Pcs *</label>
          <input type="number" min="1" class="form-control" style="font-size:0.8rem; padding:0.35rem 0.45rem;" value="${item.quantity || 1}" oninput="app.updateSampleItem(${index}, 'quantity', this.value)">
        </div>
        <div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="app.removeSampleItemRow(${index})" ${this.sampleItems.length <= 1 ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} style="padding:0.35rem 0.55rem; color:var(--danger);" title="Remove SKU">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      `;
      container.appendChild(row);
    });

    const totalEl = document.getElementById('sample-total-qty');
    if (totalEl) {
      totalEl.textContent = `${totalQty} pcs total`;
    }
  }

  updateSampleItem(idx, field, val) {
    if (this.sampleItems[idx]) {
      if (field === 'quantity') {
        this.sampleItems[idx].quantity = Math.max(1, parseInt(val, 10) || 1);
        let totalQty = 0;
        this.sampleItems.forEach(i => totalQty += (parseInt(i.quantity, 10) || 0));
        const totalEl = document.getElementById('sample-total-qty');
        if (totalEl) totalEl.textContent = `${totalQty} pcs total`;
      } else {
        this.sampleItems[idx].product_id = val;
      }
    }
  }

  addSampleItemRow() {
    this.sampleItems.push({ product_id: '', quantity: 1 });
    this.renderSampleItems();
  }

  removeSampleItemRow(idx) {
    if (this.sampleItems.length > 1) {
      this.sampleItems.splice(idx, 1);
      this.renderSampleItems();
    }
  }

  handleSamplePhoto(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.currentSamplePhotoUrl = e.target.result;
      const previewCont = document.getElementById('sample-photo-preview-container');
      const previewImg = document.getElementById('sample-photo-preview');
      if (previewCont && previewImg) {
        previewImg.src = this.currentSamplePhotoUrl;
        previewCont.style.display = 'block';
      }
    };
    reader.readAsDataURL(file);
  }

  async handleSampleSubmit(e) {
    e.preventDefault();

    const recipient = (document.getElementById('sample-recipient') ? document.getElementById('sample-recipient').value.trim() : '');
    const dispatchDate = (document.getElementById('sample-date') && document.getElementById('sample-date').value) || this.getTodayDate();
    const courier = (document.getElementById('sample-courier') ? document.getElementById('sample-courier').value.trim() : '');
    const notes = (document.getElementById('sample-notes') ? document.getElementById('sample-notes').value.trim() : '');

    if (!recipient) {
      alert("Please specify who the sample is dispatched to (Recipient / Customer).");
      return;
    }

    if (!this.sampleItems || this.sampleItems.length === 0) {
      alert("Please add at least one sample SKU to dispatch.");
      return;
    }

    const invalidItem = this.sampleItems.find(it => !it.product_id || (parseInt(it.quantity, 10) || 0) <= 0);
    if (invalidItem) {
      alert("Please make sure all sample items have a selected SKU and quantity greater than 0.");
      return;
    }

    const products = await this.db.getProducts();

    // Check stock cover warnings
    let warningStr = '';
    this.sampleItems.forEach(it => {
      const p = products.find(prod => prod.id === it.product_id);
      if (p) {
        const avail = parseFloat(p.current_stock || 0);
        if (it.quantity > avail) {
          warningStr += `SKU "${p.name}" stock cover is ${avail} pcs, but dispatch request is ${it.quantity} pcs.\n`;
        }
      }
    });

    if (warningStr) {
      const proceed = confirm(`Finished Goods Stock Cover Warning:\n\n${warningStr}\nProceed with sample dispatch?`);
      if (!proceed) return;
    }

    const sampleRef = 'SAMPLE-' + Math.floor(1000 + Math.random() * 9000);
    let totalPcs = 0;
    let itemsTextList = '';

    for (let i = 0; i < this.sampleItems.length; i++) {
      const it = this.sampleItems[i];
      const prod = products.find(p => p.id === it.product_id);
      if (prod) {
        const qty = parseInt(it.quantity, 10) || 0;
        totalPcs += qty;

        await this.db.insertOutward({
          date: dispatchDate,
          invoice_no: sampleRef,
          product_id: prod.id,
          product_name: prod.name,
          quantity_dispatched: qty,
          price_billed: 0,
          customer: `[SAMPLE] ${recipient}`
        });

        itemsTextList += `${i + 1}. *${prod.name}* (${prod.code})\n` +
                         `   • Qty: *${qty} pcs* (${prod.packaging_type})\n`;
      }
    }

    // Compile WhatsApp Sample Dispatch Note
    const waText = `🎁 *MFP ERP - Sample Dispatch Note*\n` +
                   `• *Recipient / Party:* ${recipient}\n` +
                   `• *Date:* ${dispatchDate}\n` +
                   (courier ? `• *Courier / Handover:* ${courier}\n` : '') +
                   (notes ? `• *Purpose / Remarks:* ${notes}\n` : '') +
                   `• *Sample Ref:* ${sampleRef}\n` +
                   `• *Total Free Output:* ${totalPcs} pcs across ${this.sampleItems.length} SKU(s)\n\n` +
                   `*Sample SKUs Dispatched (No Invoice):*\n` +
                   itemsTextList +
                   `\n_Stock deducted from Finished Goods warehouse. Logged via MFP Mobile Console._`;

    const waTextEl = document.getElementById('sample-wa-text');
    const waWidget = document.getElementById('sample-wa-widget');
    if (waTextEl && waWidget) {
      waTextEl.value = waText;
      waWidget.classList.remove('hidden');
    }

    // Reset form
    document.getElementById('sample-dispatch-form').reset();
    this.currentSamplePhotoUrl = null;
    const previewCont = document.getElementById('sample-photo-preview-container');
    if (previewCont) previewCont.style.display = 'none';

    this.sampleItems = [{ product_id: (products[0] ? products[0].id : ''), quantity: 1 }];
    this.initDateInputs();

    await this.refreshAllViews();
    alert(`Success! Dispatched ${totalPcs} pcs sample across ${itemsTextList ? this.sampleItems.length : 1} SKU(s) to ${recipient} (Ref: ${sampleRef})!\n\nFinished Goods warehouse stock has been deducted.`);
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
      } else if (ctx.context === 'debit') {
        const idx = ctx.targetIndex || 0;
        if (!this.debitNoteItems[idx]) {
          this.debitNoteItems[idx] = { material_id: '', description: '', quantity: 1, unit: 'pcs', rate: 0, gst_rate: 18 };
        }
        this.debitNoteItems[idx].material_id = saved.id;
        this.debitNoteItems[idx].material_name = saved.name;
        this.debitNoteItems[idx].unit = saved.unit || 'pcs';
        if (saved.average_price && (!this.debitNoteItems[idx].rate || this.debitNoteItems[idx].rate === 0)) {
          this.debitNoteItems[idx].rate = saved.average_price;
        }
        await this.renderDebitNoteItems();
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

  applyCutoff7NovData() {
    if (!confirm("Are you sure you want to reset your inventory to the 7th November 2026 Cutoff Starting Dataset? Pre-cutoff operational records will be purged, and starting opening stock (including 47.5 kg Chilli Regular) will be restored.")) {
      return;
    }
    this.db.applyCutoff7Nov(true);
    this.refreshAllViews();
    alert("✓ Successfully loaded 7-Nov-2026 Cutoff Starting Stock (100 items: 78 Raw Materials/Packaging + 22 Finished Goods)!\n\nChilli Regular restored to 47.5 Kgs and Pouch Roll to 92,000 Pcs.");
  }

  resetLocalStorage() {
    if (confirm("Are you sure you want to WIPE all local data? This action is permanent.")) {
      localStorage.clear();
      location.reload();
    }
  }

  // --- 5. REAL-TIME STOCK STATUS & BUFFER MONITORING ---

  // --- 5. REAL-TIME STOCK STATUS & BUFFER MONITORING (SIMPLIFIED TABS & TABLE) ---

  switchStatusMainTab(tab) {
    this.statusMainTab = tab; // 'raw_materials' or 'finished_goods'

    // Update primary tab buttons
    const btnRm = document.getElementById('btn-status-tab-rm');
    const btnFg = document.getElementById('btn-status-tab-fg');
    if (btnRm && btnFg) {
      if (tab === 'raw_materials') {
        btnRm.classList.add('active');
        btnFg.classList.remove('active');
      } else {
        btnFg.classList.add('active');
        btnRm.classList.remove('active');
      }
    }

    // Update sub-filter labels
    const lblDeficit = document.getElementById('lbl-status-sub-deficit');
    const lblAll = document.getElementById('lbl-status-sub-all');
    if (lblDeficit && lblAll) {
      if (tab === 'raw_materials') {
        lblDeficit.textContent = '⚠️ Need to Order';
        lblAll.textContent = '📋 All Materials';
      } else {
        lblDeficit.textContent = '⚠️ Need to Produce';
        lblAll.textContent = '📋 All Finished Goods';
      }
    }

    // Populate category dropdown options based on active main tab
    const catSelect = document.getElementById('status-category-filter');
    if (catSelect) {
      if (tab === 'raw_materials') {
        catSelect.innerHTML = `
          <option value="all">All Categories</option>
          <option value="Raw material">Spices & Crops</option>
          <option value="Bottle Stickers">Bottle Stickers</option>
          <option value="Material">Boxes & Sleeves</option>
          <option value="Cap Stickers">Cap Stickers</option>
          <option value="Horeca Stickers">Horeca Stickers</option>
          <option value="Caps">Caps</option>
          <option value="Pouch Roll">Pouch Rolls</option>
          <option value="Sachet Roll">Sachet Rolls</option>
          <option value="consumables">Consumables & Marketing</option>
        `;
      } else {
        catSelect.innerHTML = `
          <option value="all">All Packaging Types</option>
          <option value="Bottles">Bottles (13 SKUs)</option>
          <option value="Pouches">Pouches (7 SKUs)</option>
          <option value="Sachets">Sachets (2 SKUs)</option>
          <option value="Horeca">Horeca Bulk (2 SKUs)</option>
        `;
      }
    }

    this.renderStatusPane();
  }

  setStatusSubFilter(sub) {
    this.statusSubFilter = sub; // 'deficit' or 'all'

    const btnDeficit = document.getElementById('btn-status-sub-deficit');
    const btnAll = document.getElementById('btn-status-sub-all');
    if (btnDeficit && btnAll) {
      if (sub === 'deficit') {
        btnDeficit.classList.add('active');
        btnAll.classList.remove('active');
      } else {
        btnAll.classList.add('active');
        btnDeficit.classList.remove('active');
      }
    }

    this.renderStatusPane();
  }

  // Backward compatibility wrapper
  filterStatusCategory(cat) {
    if (cat === 'finished_goods') {
      this.switchStatusMainTab('finished_goods');
    } else {
      this.switchStatusMainTab('raw_materials');
      if (cat === 'below_buffer') {
        this.setStatusSubFilter('deficit');
      }
    }
  }

  async renderStatusPane() {
    const tableHead = document.getElementById('status-table-head');
    const tableBody = document.getElementById('status-table-body');
    const summaryEl = document.getElementById('status-table-summary');
    if (!tableBody) return;

    if (!this.statusMainTab) {
      this.statusMainTab = 'raw_materials';
    }
    if (!this.statusSubFilter) {
      this.statusSubFilter = 'deficit';
    }

    const materials = await this.db.getRawMaterials();
    const products = await this.db.getProducts();

    // 1. Calculate live deficits
    const rmDeficitItems = materials.filter(m => {
      const stock = parseFloat(m.current_stock || 0);
      const buffer = parseFloat(m.buffer !== undefined ? m.buffer : (m.min_stock !== undefined ? m.min_stock : 0));
      return stock < buffer;
    });

    const fgDeficitItems = products.filter(p => {
      const stock = parseFloat(p.current_stock || 0);
      const buffer = parseFloat(p.buffer !== undefined ? p.buffer : (p.min_stock !== undefined ? p.min_stock : 0));
      return stock < buffer;
    });

    // Update primary tab badge counts
    const badgeRm = document.getElementById('badge-rm-deficit-count');
    if (badgeRm) {
      if (rmDeficitItems.length > 0) {
        badgeRm.textContent = `⚠️ ${rmDeficitItems.length} To Order`;
        badgeRm.style.background = 'rgba(239, 68, 68, 0.2)';
        badgeRm.style.color = '#ef4444';
      } else {
        badgeRm.textContent = `✓ In Stock`;
        badgeRm.style.background = 'rgba(16, 185, 129, 0.15)';
        badgeRm.style.color = '#10b981';
      }
    }

    const badgeFg = document.getElementById('badge-fg-deficit-count');
    if (badgeFg) {
      if (fgDeficitItems.length > 0) {
        badgeFg.textContent = `⚠️ ${fgDeficitItems.length} To Produce`;
        badgeFg.style.background = 'rgba(239, 68, 68, 0.2)';
        badgeFg.style.color = '#ef4444';
      } else {
        badgeFg.textContent = `✓ In Stock`;
        badgeFg.style.background = 'rgba(16, 185, 129, 0.15)';
        badgeFg.style.color = '#10b981';
      }
    }

    const searchInput = document.getElementById('status-search-input');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

    const catSelect = document.getElementById('status-category-filter');
    const selectedCat = catSelect ? catSelect.value : 'all';

    // 2. Render RAW MATERIALS Table
    if (this.statusMainTab === 'raw_materials') {
      if (tableHead) {
        tableHead.innerHTML = `
          <tr>
            <th style="min-width:140px; text-align:left;">Material / Packaging</th>
            <th style="min-width:85px; text-align:right;">Stock / Buffer</th>
            <th style="min-width:75px; text-align:right;">To Order</th>
            <th style="min-width:70px; text-align:center;">Action</th>
          </tr>
        `;
      }

      let list = materials.map(m => {
        const stock = parseFloat(m.current_stock || 0);
        const buffer = parseFloat(m.buffer !== undefined ? m.buffer : (m.min_stock !== undefined ? m.min_stock : 0));
        const isBelow = stock < buffer;
        return {
          id: m.id,
          code: m.code || 'RM',
          name: m.name,
          category: m.category || 'Material',
          unit: m.unit || 'Pcs',
          current_stock: stock,
          buffer: buffer,
          rate: parseFloat(m.average_price || 0),
          isBelowBuffer: isBelow,
          deficit: Math.max(0, buffer - stock)
        };
      });

      // Filter by deficit if sub-filter active
      if (this.statusSubFilter === 'deficit') {
        list = list.filter(item => item.isBelowBuffer);
      }

      // Filter by category
      if (selectedCat && selectedCat !== 'all') {
        if (selectedCat === 'consumables') {
          list = list.filter(item => ['Cello tape', 'Sample Box', 'Hangers', 'Posters'].includes(item.category));
        } else {
          list = list.filter(item => item.category === selectedCat);
        }
      }

      // Filter by search query
      if (query) {
        list = list.filter(item => 
          item.name.toLowerCase().includes(query) ||
          item.code.toLowerCase().includes(query) ||
          item.category.toLowerCase().includes(query)
        );
      }

      // Sort: below buffer first, then largest deficit, then name
      list.sort((a, b) => {
        if (a.isBelowBuffer && !b.isBelowBuffer) return -1;
        if (!a.isBelowBuffer && b.isBelowBuffer) return 1;
        if (a.deficit !== b.deficit) return b.deficit - a.deficit;
        return a.name.localeCompare(b.name);
      });

      if (list.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="4" style="text-align:center; padding:2.5rem 1rem; color:var(--text-muted);">
              ${this.statusSubFilter === 'deficit' ? `
                <div style="color:#10b981; font-weight:700; font-size:1rem; margin-bottom:0.35rem;">
                  <i class="fa-solid fa-circle-check" style="font-size:2rem; margin-bottom:0.5rem; display:block;"></i>
                  All Raw Materials & Packaging are above buffer!
                </div>
                <div style="font-size:0.75rem;">No immediate replenishment purchase orders needed.</div>
              ` : `
                <i class="fa-solid fa-boxes-stacked" style="font-size:2rem; margin-bottom:0.5rem; display:block; opacity:0.5;"></i>
                No materials found matching "${this.escapeHtml(query || selectedCat)}".
              `}
            </td>
          </tr>
        `;
      } else {
        tableBody.innerHTML = list.map(item => {
          const rowClass = item.isBelowBuffer ? 'status-table-row below-buffer' : 'status-table-row';
          return `
            <tr class="${rowClass}">
              <td>
                <div class="status-item-name">${this.escapeHtml(item.name)}</div>
                <div class="td-muted" style="font-size:0.68rem; margin-top:2px; display:flex; align-items:center; gap:0.3rem; flex-wrap:wrap;">
                  <span class="badge" style="font-size:0.62rem; padding:0.1rem 0.3rem; background:rgba(255,255,255,0.06);">${this.escapeHtml(item.category)}</span>
                  <span style="font-family:monospace; opacity:0.8;">${this.escapeHtml(item.code)}</span>
                </div>
              </td>
              <td style="text-align:right;">
                <div class="status-item-stock">${item.current_stock.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${item.unit}</div>
                <div class="td-muted" style="font-size:0.68rem;">Buffer: ${item.buffer.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</div>
              </td>
              <td style="text-align:right;">
                ${item.isBelowBuffer ? `
                  <div class="status-deficit-val">-${item.deficit.toLocaleString('en-IN', { maximumFractionDigits: 3 })}</div>
                  <div style="font-size:0.65rem; color:#f87171; font-weight:700;">${item.unit}</div>
                ` : `
                  <div style="color:#10b981; font-weight:700; font-size:0.75rem;">✓ OK</div>
                `}
              </td>
              <td style="text-align:center;">
                ${item.isBelowBuffer ? `
                  <button type="button" class="status-btn-action-order" onclick="app.quickOrderMaterial('${item.id}', ${item.deficit})" title="Requisition this material now">
                    <i class="fa-solid fa-cart-plus"></i> Order
                  </button>
                ` : `
                  <button type="button" class="btn btn-secondary btn-sm" onclick="app.quickOrderMaterial('${item.id}', 10)" style="padding:0.2rem 0.45rem; font-size:0.7rem; opacity:0.5;" title="Order regular quantity">
                    <i class="fa-solid fa-plus"></i>
                  </button>
                `}
              </td>
            </tr>
          `;
        }).join('');
      }

      if (summaryEl) {
        summaryEl.innerHTML = `
          <span>Showing <strong>${list.length}</strong> items (${this.statusSubFilter === 'deficit' ? 'Deficit / Reorder Needed' : 'All Materials'})</span>
          <span><strong>${rmDeficitItems.length}</strong> below buffer</span>
        `;
      }

    // 3. Render FINISHED GOODS Table
    } else {
      if (tableHead) {
        tableHead.innerHTML = `
          <tr>
            <th style="min-width:140px; text-align:left;">Product / SKU</th>
            <th style="min-width:85px; text-align:right;">Stock / Buffer</th>
            <th style="min-width:75px; text-align:right;">To Produce</th>
            <th style="min-width:70px; text-align:center;">Action</th>
          </tr>
        `;
      }

      let list = products.map(p => {
        const stock = parseFloat(p.current_stock || 0);
        const buffer = parseFloat(p.buffer !== undefined ? p.buffer : (p.min_stock !== undefined ? p.min_stock : 0));
        const isBelow = stock < buffer;
        return {
          id: p.id,
          code: p.code || p.sku || 'FG',
          name: p.name,
          category: p.packaging_type || 'General',
          current_stock: stock,
          buffer: buffer,
          selling_price: parseFloat(p.selling_price || p.price || 0),
          isBelowBuffer: isBelow,
          deficit: Math.max(0, buffer - stock)
        };
      });

      // Filter by deficit if sub-filter active
      if (this.statusSubFilter === 'deficit') {
        list = list.filter(item => item.isBelowBuffer);
      }

      // Filter by packaging category
      if (selectedCat && selectedCat !== 'all') {
        list = list.filter(item => item.category === selectedCat);
      }

      // Filter by search query
      if (query) {
        list = list.filter(item => 
          item.name.toLowerCase().includes(query) ||
          item.code.toLowerCase().includes(query) ||
          item.category.toLowerCase().includes(query)
        );
      }

      // Sort: below buffer first, then largest deficit, then name
      list.sort((a, b) => {
        if (a.isBelowBuffer && !b.isBelowBuffer) return -1;
        if (!a.isBelowBuffer && b.isBelowBuffer) return 1;
        if (a.deficit !== b.deficit) return b.deficit - a.deficit;
        return a.name.localeCompare(b.name);
      });

      if (list.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="4" style="text-align:center; padding:2.5rem 1rem; color:var(--text-muted);">
              ${this.statusSubFilter === 'deficit' ? `
                <div style="color:#10b981; font-weight:700; font-size:1rem; margin-bottom:0.35rem;">
                  <i class="fa-solid fa-circle-check" style="font-size:2rem; margin-bottom:0.5rem; display:block;"></i>
                  All Finished Goods are at or above buffer stock!
                </div>
                <div style="font-size:0.75rem;">No immediate production batch runs needed right now.</div>
              ` : `
                <i class="fa-solid fa-boxes-stacked" style="font-size:2rem; margin-bottom:0.5rem; display:block; opacity:0.5;"></i>
                No products found matching "${this.escapeHtml(query || selectedCat)}".
              `}
            </td>
          </tr>
        `;
      } else {
        tableBody.innerHTML = list.map(item => {
          const rowClass = item.isBelowBuffer ? 'status-table-row below-buffer' : 'status-table-row';
          return `
            <tr class="${rowClass}">
              <td>
                <div class="status-item-name">${this.escapeHtml(item.name)}</div>
                <div class="td-muted" style="font-size:0.68rem; margin-top:2px; display:flex; align-items:center; gap:0.3rem; flex-wrap:wrap;">
                  <span class="badge" style="font-size:0.62rem; padding:0.1rem 0.3rem; background:rgba(255,255,255,0.06);">${this.escapeHtml(item.category)}</span>
                  <span style="font-family:monospace; opacity:0.8;">${this.escapeHtml(item.code)}</span>
                </div>
              </td>
              <td style="text-align:right;">
                <div class="status-item-stock">${item.current_stock.toLocaleString('en-IN')} pcs</div>
                <div class="td-muted" style="font-size:0.68rem;">Buffer: ${item.buffer.toLocaleString('en-IN')} pcs</div>
              </td>
              <td style="text-align:right;">
                ${item.isBelowBuffer ? `
                  <div class="status-deficit-val">-${item.deficit.toLocaleString('en-IN')}</div>
                  <div style="font-size:0.65rem; color:#f87171; font-weight:700;">pcs</div>
                ` : `
                  <div style="color:#10b981; font-weight:700; font-size:0.75rem;">✓ OK</div>
                `}
              </td>
              <td style="text-align:center;">
                ${item.isBelowBuffer ? `
                  <button type="button" class="status-btn-action-produce" onclick="app.quickPlanProduction('${item.id}', ${item.deficit})" title="Stage this production batch now">
                    <i class="fa-solid fa-industry"></i> Produce
                  </button>
                ` : `
                  <button type="button" class="btn btn-secondary btn-sm" onclick="app.quickPlanProduction('${item.id}', 50)" style="padding:0.2rem 0.45rem; font-size:0.7rem; opacity:0.5;" title="Produce standard batch">
                    <i class="fa-solid fa-plus"></i>
                  </button>
                `}
              </td>
            </tr>
          `;
        }).join('');
      }

      if (summaryEl) {
        summaryEl.innerHTML = `
          <span>Showing <strong>${list.length}</strong> products (${this.statusSubFilter === 'deficit' ? 'Deficit / Production Needed' : 'All Products'})</span>
          <span><strong>${fgDeficitItems.length}</strong> below buffer</span>
        `;
      }
    }
  }

  quickOrderMaterial(materialId, diff) {
    this.orderItems = [{
      material_id: materialId,
      quantity: Math.max(1, Math.ceil(diff)),
      target_price: 0
    }];
    const orderTab = document.querySelector('.bottom-nav .nav-tab[data-target="view-order"]');
    this.switchView('view-order', orderTab);
    this.renderOrderPane();
  }

  quickPlanProduction(productId, diff) {
    this.productionItems = [{
      product_id: productId,
      quantity: Math.max(1, Math.ceil(diff))
    }];
    const prodTab = document.querySelector('.bottom-nav .nav-tab[data-target="view-production"]');
    this.switchView('view-production', prodTab);
    this.renderProductionPane();
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

  // ==========================================
  // EXCEL / CSV VARIABLE RANGE EXPORT ENGINE (MOBILE)
  // ==========================================

  openExportModal(defaultModule = 'raw_materials') {
    const modal = document.getElementById('modal-export-excel');
    if (!modal) return;

    const moduleSelect = document.getElementById('export-module-select');
    if (moduleSelect) {
      if (defaultModule) {
        moduleSelect.value = defaultModule;
      }
      this.onExportModuleChange(moduleSelect.value);
    }

    this.openModal('modal-export-excel');
  }

  onExportModuleChange(module) {
    const prodGroup = document.getElementById('export-product-filter-group');
    const prodLabel = document.getElementById('export-product-filter-label');
    const prodSelect = document.getElementById('export-product-select');

    const secGroup = document.getElementById('export-secondary-filter-group');
    const secLabel = document.getElementById('export-secondary-filter-label');
    const secSelect = document.getElementById('export-secondary-select');

    const partyGroup = document.getElementById('export-party-group');
    const partyLabel = document.getElementById('export-party-label');
    const partyInput = document.getElementById('export-party-search');

    const dateContainer = document.getElementById('export-date-range-container');

    if (!prodSelect || !secSelect) return;

    prodSelect.innerHTML = '<option value="all">All Products / Materials</option>';
    secSelect.innerHTML = '<option value="all">All Records</option>';
    if (partyInput) partyInput.value = '';

    const dbData = (this.db && this.db.offlineDb) ? this.db.offlineDb : {};

    if (module === 'raw_materials') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Raw Material Range';
      prodSelect.innerHTML = '<option value="all">All Raw Materials</option>' +
        (dbData.raw_materials || []).map(m => `<option value="${m.id || m.code}">${this.escapeHtml(m.name)} (${m.code || 'RM'})</option>`).join('');

      if (secLabel) secLabel.textContent = 'Stock Level Filter';
      secSelect.innerHTML = `
        <option value="all">All Stock Levels</option>
        <option value="in_stock">In Stock Only (> 0)</option>
        <option value="low_stock">Low Stock / Reorder Needed (<= Min Stock)</option>
      `;

      if (partyGroup) partyGroup.style.display = 'none';

    } else if (module === 'production') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Finished Good / Recipe Filter';
      prodSelect.innerHTML = '<option value="all">All Products & Batches</option>' +
        (dbData.products || []).map(p => `<option value="${p.id || p.sku}">${this.escapeHtml(p.name)} (${p.sku || 'SKU'})</option>`).join('');

      if (secLabel) secLabel.textContent = 'Packaging Filter';
      const uniquePack = Array.from(new Set((dbData.products || []).map(p => p.packaging).filter(Boolean)));
      secSelect.innerHTML = '<option value="all">All Packaging Types</option>' +
        uniquePack.map(pkg => `<option value="${this.escapeHtml(pkg)}">${this.escapeHtml(pkg)}</option>`).join('');

      if (partyGroup) partyGroup.style.display = 'none';

    } else if (module === 'finished_goods') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Finished Product Range';
      prodSelect.innerHTML = '<option value="all">All Finished Goods</option>' +
        (dbData.products || []).map(p => `<option value="${p.id || p.sku}">${this.escapeHtml(p.name)} (${p.sku || 'SKU'})</option>`).join('');

      if (secLabel) secLabel.textContent = 'Category Filter';
      const uniqueCats = Array.from(new Set((dbData.products || []).map(p => p.category).filter(Boolean)));
      secSelect.innerHTML = '<option value="all">All Categories</option>' +
        uniqueCats.map(cat => `<option value="${this.escapeHtml(cat)}">${this.escapeHtml(cat)}</option>`).join('') +
        '<option value="low_stock">Low Stock / Reorder Needed</option>';

      if (partyGroup) partyGroup.style.display = 'none';

    } else if (module === 'purchase_inwards') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Raw Material Range';
      prodSelect.innerHTML = '<option value="all">All Inward Materials</option>' +
        (dbData.raw_materials || []).map(m => `<option value="${m.id || m.code}">${this.escapeHtml(m.name)} (${m.code || 'RM'})</option>`).join('');

      if (secLabel) secLabel.textContent = 'PO Link Status';
      secSelect.innerHTML = `
        <option value="all">All Inward Bills</option>
        <option value="linked_po">Linked to Purchase Order</option>
        <option value="direct">Direct Inward (Without PO)</option>
      `;

      if (partyGroup) partyGroup.style.display = 'block';
      if (partyLabel) partyLabel.textContent = 'Vendor / Supplier Filter';

    } else if (module === 'sales_outwards') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Finished Product Range';
      prodSelect.innerHTML = '<option value="all">All Finished Goods</option>' +
        (dbData.products || []).map(p => `<option value="${p.id || p.sku}">${this.escapeHtml(p.name)} (${p.sku || 'SKU'})</option>`).join('');

      if (secLabel) secLabel.textContent = 'Dispatch Type';
      secSelect.innerHTML = `
        <option value="all">All Dispatches & Samples</option>
        <option value="sales_only">Commercial Sales Invoices Only</option>
        <option value="samples_only">Sample Dispatches Only (No Invoice)</option>
      `;

      if (partyGroup) partyGroup.style.display = 'block';
      if (partyLabel) partyLabel.textContent = 'Customer / Client Filter';

    } else if (module === 'debit_notes') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Defective Material Range';
      prodSelect.innerHTML = '<option value="all">All Defective Materials</option>' +
        (dbData.raw_materials || []).map(m => `<option value="${m.id || m.code}">${this.escapeHtml(m.name)} (${m.code || 'RM'})</option>`).join('');

      if (secLabel) secLabel.textContent = 'Stock Deduction Status';
      secSelect.innerHTML = `
        <option value="all">All Debit Notes</option>
        <option value="deducted">Warehouse Stock Deducted</option>
        <option value="not_deducted">Warehouse Stock Not Deducted</option>
      `;

      if (partyGroup) partyGroup.style.display = 'block';
      if (partyLabel) partyLabel.textContent = 'Vendor / Supplier Name Filter';
    }

    this.updateExportPreviewCount();
  }

  setExportDatePreset(preset) {
    const fromInput = document.getElementById('export-date-from');
    const toInput = document.getElementById('export-date-to');
    if (!fromInput || !toInput) return;

    const today = new Date();
    const formatDate = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    if (preset === 'all') {
      fromInput.value = '';
      toInput.value = '';
    } else if (preset === 'today') {
      fromInput.value = formatDate(today);
      toInput.value = formatDate(today);
    } else if (preset === 'this_month') {
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      fromInput.value = formatDate(firstDay);
      toInput.value = formatDate(today);
    } else if (preset === 'last_month') {
      const firstDay = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
      fromInput.value = formatDate(firstDay);
      toInput.value = formatDate(lastDay);
    } else if (preset === 'last_30') {
      const past = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));
      fromInput.value = formatDate(past);
      toInput.value = formatDate(today);
    } else if (preset === 'fy_current') {
      const curYear = today.getFullYear();
      const isPostMarch = today.getMonth() >= 3;
      const startYear = isPostMarch ? curYear : curYear - 1;
      fromInput.value = `${startYear}-04-01`;
      toInput.value = `${startYear + 1}-03-31`;
    }

    this.updateExportPreviewCount();
  }

  getFilteredExportData() {
    const moduleSelect = document.getElementById('export-module-select');
    const module = moduleSelect ? moduleSelect.value : 'raw_materials';

    const fromDate = (document.getElementById('export-date-from')?.value || '').trim();
    const toDate = (document.getElementById('export-date-to')?.value || '').trim();
    const productVal = document.getElementById('export-product-select')?.value || 'all';
    const secondaryVal = document.getElementById('export-secondary-select')?.value || 'all';
    const partyVal = (document.getElementById('export-party-search')?.value || '').trim().toLowerCase();

    let rows = [];
    let sheetName = 'Sheet1';
    let baseFilename = 'MFP_Export';

    const dbData = (this.db && this.db.offlineDb) ? this.db.offlineDb : {};

    const dateSuffix = fromDate || toDate 
      ? `_${fromDate || 'Start'}_to_${toDate || 'Present'}`
      : `_${new Date().toISOString().split('T')[0]}`;

    const isDateInRange = (rowDateStr) => {
      if (!rowDateStr) return true;
      const d = String(rowDateStr).split('T')[0];
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    };

    if (module === 'raw_materials') {
      sheetName = 'Raw_Materials';
      baseFilename = `MFP_Raw_Materials_Inventory${dateSuffix}`;

      let rawList = (dbData.raw_materials || []).slice();

      if (productVal !== 'all') {
        rawList = rawList.filter(m => (m.id && String(m.id) === productVal) || (m.code && String(m.code) === productVal));
      }

      if (secondaryVal === 'in_stock') {
        rawList = rawList.filter(m => (Number(m.current_stock) || 0) > 0);
      } else if (secondaryVal === 'low_stock') {
        rawList = rawList.filter(m => (Number(m.current_stock) || 0) <= (Number(m.min_stock) || 0));
      }

      let totalStock = 0;
      let totalValuation = 0;

      rawList.forEach(m => {
        const stock = Number(m.current_stock) || 0;
        const rate = Number(m.average_price || m.last_price) || 0;
        const val = stock * rate;
        totalStock += stock;
        totalValuation += val;

        rows.push({
          'Material Code': m.code || '',
          'Material Name': m.name || '',
          'Category': m.category || 'General',
          'Unit': m.unit || 'kg',
          'Current Stock': stock,
          'Min Stock Alert': Number(m.min_stock) || 0,
          'Avg Purchase Price (Rs)': rate,
          'Inventory Valuation (Rs)': Math.round(val * 100) / 100,
          'Stock Status': stock <= (Number(m.min_stock) || 0) ? 'LOW STOCK - REORDER' : 'OPTIMAL'
        });
      });

      if (rows.length > 0) {
        rows.push({
          'Material Code': 'TOTAL',
          'Material Name': `${rows.length} Materials`,
          'Category': '',
          'Unit': '',
          'Current Stock': Math.round(totalStock * 1000) / 1000,
          'Min Stock Alert': '',
          'Avg Purchase Price (Rs)': '',
          'Inventory Valuation (Rs)': Math.round(totalValuation * 100) / 100,
          'Stock Status': ''
        });
      }

    } else if (module === 'production') {
      sheetName = 'Production_Runs';
      baseFilename = `MFP_Production_Batches${dateSuffix}`;

      const rawProds = (dbData.productions || []).slice();
      const txProds = (dbData.transactions || []).filter(t => t.type === 'production');

      const seen = new Set();
      const combined = [];

      rawProds.forEach(p => {
        const key = p.id || `${p.batch_no || p.batch_ref}_${p.date}`;
        if (!seen.has(key)) {
          seen.add(key);
          combined.push(p);
        }
      });

      txProds.forEach(t => {
        const key = t.id || `${t.ref || t.batch_no}_${t.date}`;
        if (!seen.has(key)) {
          seen.add(key);
          combined.push({
            date: t.date,
            batch_no: t.ref || t.batch_no,
            product_name: t.product_name || (t.title ? t.title.replace('Production: ', '') : ''),
            quantity: t.quantity || 0,
            notes: t.description || ''
          });
        }
      });

      let filtered = combined.filter(p => {
        const d = p.date || (p.created_at ? p.created_at.split('T')[0] : '');
        if (!isDateInRange(d)) return false;

        if (productVal !== 'all') {
          const matchId = (p.product_id && String(p.product_id) === productVal);
          const matchSku = (p.product_sku && String(p.product_sku) === productVal);
          const matchName = (p.product_name && p.product_name.toLowerCase().includes(productVal.toLowerCase()));
          if (!matchId && !matchSku && !matchName) return false;
        }

        if (secondaryVal !== 'all') {
          const pkg = p.packaging || p.packaging_type;
          if (pkg !== secondaryVal) return false;
        }

        return true;
      });

      let totalQty = 0;
      let totalCost = 0;

      filtered.forEach(p => {
        const qty = Number(p.quantity || p.quantity_produced) || 0;
        const cost = Number(p.total_cost) || 0;
        totalQty += qty;
        totalCost += cost;

        let bomSummary = '';
        if (Array.isArray(p.bom_consumed)) {
          bomSummary = p.bom_consumed.map(b => `${b.material_name || b.name || 'Item'}: ${b.quantity} ${b.unit || ''}`).join('; ');
        }

        rows.push({
          'Date': p.date || (p.created_at ? p.created_at.split('T')[0] : ''),
          'Batch No / Ref': p.batch_no || p.batch_ref || p.id || '',
          'Product Name': p.product_name || '',
          'Packaging': p.packaging || p.packaging_type || 'Standard',
          'Quantity Produced (Units)': qty,
          'Production Cost (Rs)': cost,
          'BOM Ingredients Consumed': bomSummary,
          'Wastage Applied %': Number(p.wastage_percentage) || 1.5,
          'Notes / Remarks': p.notes || ''
        });
      });

      if (rows.length > 0) {
        rows.push({
          'Date': 'TOTAL',
          'Batch No / Ref': `${rows.length} Batches`,
          'Product Name': '',
          'Packaging': '',
          'Quantity Produced (Units)': totalQty,
          'Production Cost (Rs)': Math.round(totalCost * 100) / 100,
          'BOM Ingredients Consumed': '',
          'Wastage Applied %': '',
          'Notes / Remarks': ''
        });
      }

    } else if (module === 'finished_goods') {
      sheetName = 'Finished_Goods';
      baseFilename = `MFP_Finished_Goods_Inventory${dateSuffix}`;

      let prodList = (dbData.products || []).slice();

      if (productVal !== 'all') {
        prodList = prodList.filter(p => (p.id && String(p.id) === productVal) || (p.sku && String(p.sku) === productVal));
      }

      if (secondaryVal === 'low_stock') {
        prodList = prodList.filter(p => (Number(p.current_stock) || 0) <= (Number(p.min_stock) || 0));
      } else if (secondaryVal !== 'all') {
        prodList = prodList.filter(p => p.category === secondaryVal);
      }

      let totalStock = 0;
      let totalValuation = 0;

      prodList.forEach(p => {
        const stock = Number(p.current_stock) || 0;
        const price = Number(p.selling_price) || 0;
        const val = stock * price;
        totalStock += stock;
        totalValuation += val;

        rows.push({
          'SKU': p.sku || '',
          'Product Name': p.name || '',
          'Category': p.category || 'General',
          'Packaging': p.packaging || '',
          'Current Stock (Units)': stock,
          'Min Stock Alert': Number(p.min_stock) || 0,
          'Selling Price (Rs)': price,
          'Finished Goods Valuation (Rs)': Math.round(val * 100) / 100,
          'Stock Status': stock <= (Number(p.min_stock) || 0) ? 'LOW STOCK - REORDER' : 'OPTIMAL',
          'BOM Recipe Set': (p.bom && p.bom.length > 0) ? `Yes (${p.bom.length} items)` : 'No'
        });
      });

      if (rows.length > 0) {
        rows.push({
          'SKU': 'TOTAL',
          'Product Name': `${rows.length} SKUs`,
          'Category': '',
          'Packaging': '',
          'Current Stock (Units)': totalStock,
          'Min Stock Alert': '',
          'Selling Price (Rs)': '',
          'Finished Goods Valuation (Rs)': Math.round(totalValuation * 100) / 100,
          'Stock Status': '',
          'BOM Recipe Set': ''
        });
      }

    } else if (module === 'purchase_inwards') {
      sheetName = 'Purchase_Inwards';
      baseFilename = `MFP_Purchase_Inwards${dateSuffix}`;

      let inwList = (dbData.inwards || []).slice();

      let filtered = inwList.filter(inw => {
        if (!isDateInRange(inw.date)) return false;

        if (productVal !== 'all') {
          const matchId = inw.material_id && String(inw.material_id) === productVal;
          const matchName = inw.material_name && inw.material_name.toLowerCase().includes(productVal.toLowerCase());
          if (!matchId && !matchName) return false;
        }

        if (secondaryVal === 'linked_po' && !inw.linked_order_id) return false;
        if (secondaryVal === 'direct' && inw.linked_order_id) return false;

        if (partyVal) {
          const sup = (inw.supplier || inw.vendor || '').toLowerCase();
          if (!sup.includes(partyVal)) return false;
        }

        return true;
      });

      let totalQty = 0;
      let totalAmount = 0;

      filtered.forEach(inw => {
        const qty = Number(inw.quantity) || 0;
        const rate = Number(inw.rate || inw.price) || 0;
        const tot = Number(inw.total_amount) || (qty * rate);
        totalQty += qty;
        totalAmount += tot;

        const mat = (dbData.raw_materials || []).find(m => m.id === inw.material_id || m.name === inw.material_name);

        rows.push({
          'Date': inw.date || '',
          'Invoice / Bill No': inw.invoice_no || inw.bill_no || '',
          'Supplier / Vendor': inw.supplier || inw.vendor || '',
          'Vendor GSTIN': inw.vendor_gstin || '',
          'Material Name': inw.material_name || inw.item_name || '',
          'Material Code': mat ? (mat.code || '') : '',
          'Quantity Inwarded': qty,
          'Unit': inw.unit || (mat ? mat.unit : 'kg'),
          'Unit Rate (Rs)': rate,
          'GST %': Number(inw.gst_rate || inw.gst_percentage) || 0,
          'Taxable Amount (Rs)': Math.round((Number(inw.taxable_amount) || (qty * rate)) * 100) / 100,
          'Total Amount (Rs)': Math.round(tot * 100) / 100,
          'Linked PO Ref': inw.linked_order_id || 'Direct',
          'PDF Document': inw.pdf_filename || ''
        });
      });

      if (rows.length > 0) {
        rows.push({
          'Date': 'TOTAL',
          'Invoice / Bill No': `${rows.length} Inwards`,
          'Supplier / Vendor': '',
          'Vendor GSTIN': '',
          'Material Name': '',
          'Material Code': '',
          'Quantity Inwarded': Math.round(totalQty * 1000) / 1000,
          'Unit': '',
          'Unit Rate (Rs)': '',
          'GST %': '',
          'Taxable Amount (Rs)': '',
          'Total Amount (Rs)': Math.round(totalAmount * 100) / 100,
          'Linked PO Ref': '',
          'PDF Document': ''
        });
      }

    } else if (module === 'sales_outwards') {
      sheetName = 'Sales_Dispatches';
      baseFilename = `MFP_Sales_Dispatches${dateSuffix}`;

      let outwList = (dbData.outwards || []).slice();

      let filtered = outwList.filter(outw => {
        if (!isDateInRange(outw.date)) return false;

        if (productVal !== 'all') {
          const matchId = outw.product_id && String(outw.product_id) === productVal;
          const matchName = outw.product_name && outw.product_name.toLowerCase().includes(productVal.toLowerCase());
          if (!matchId && !matchName) return false;
        }

        if (secondaryVal === 'sales_only' && outw.is_sample) return false;
        if (secondaryVal === 'samples_only' && !outw.is_sample) return false;

        if (partyVal) {
          const cust = (outw.customer || outw.client || outw.party_name || '').toLowerCase();
          if (!cust.includes(partyVal)) return false;
        }

        return true;
      });

      let totalQty = 0;
      let totalAmount = 0;

      filtered.forEach(outw => {
        const qty = Number(outw.quantity) || 0;
        const rate = Number(outw.rate || outw.selling_price) || 0;
        const tot = outw.is_sample ? 0 : (Number(outw.total_amount) || (qty * rate));
        totalQty += qty;
        totalAmount += tot;

        const prod = (dbData.products || []).find(p => p.id === outw.product_id || p.name === outw.product_name);

        rows.push({
          'Date': outw.date || '',
          'Dispatch / Invoice No': outw.invoice_no || outw.dispatch_no || '',
          'Type': outw.is_sample ? 'SAMPLE DISPATCH (Free)' : 'COMMERCIAL SALE',
          'Customer / Client': outw.customer || outw.client || '',
          'Product Name': outw.product_name || '',
          'Product SKU': prod ? (prod.sku || '') : (outw.product_sku || ''),
          'Packaging': outw.packaging || (prod ? prod.packaging : '') || '',
          'Quantity Dispatched (Units)': qty,
          'Unit Price (Rs)': rate,
          'Total Sale Amount (Rs)': Math.round(tot * 100) / 100,
          'Courier / Transporter Ref': outw.courier_ref || '',
          'Photos Attached': (outw.photos && outw.photos.length > 0) ? `Yes (${outw.photos.length} photos)` : (outw.photo ? 'Yes (1 photo)' : 'No'),
          'Notes': outw.notes || ''
        });
      });

      if (rows.length > 0) {
        rows.push({
          'Date': 'TOTAL',
          'Dispatch / Invoice No': `${rows.length} Dispatches`,
          'Type': '',
          'Customer / Client': '',
          'Product Name': '',
          'Product SKU': '',
          'Packaging': '',
          'Quantity Dispatched (Units)': totalQty,
          'Unit Price (Rs)': '',
          'Total Sale Amount (Rs)': Math.round(totalAmount * 100) / 100,
          'Courier / Transporter Ref': '',
          'Photos Attached': '',
          'Notes': ''
        });
      }

    } else if (module === 'debit_notes') {
      sheetName = 'Vendor_Debit_Notes';
      baseFilename = `MFP_Vendor_Debit_Notes${dateSuffix}`;

      let dnList = (dbData.debit_notes || []).slice();

      let filteredDns = dnList.filter(dn => {
        if (!isDateInRange(dn.date)) return false;

        if (secondaryVal === 'deducted' && dn.deduct_stock === false) return false;
        if (secondaryVal === 'not_deducted' && dn.deduct_stock !== false) return false;

        if (partyVal) {
          const v = (dn.vendor_name || '').toLowerCase();
          if (!v.includes(partyVal)) return false;
        }

        return true;
      });

      let totalQty = 0;
      let totalAmount = 0;

      filteredDns.forEach(dn => {
        const items = Array.isArray(dn.items) && dn.items.length > 0 ? dn.items : [
          {
            material_id: dn.material_id,
            material_name: dn.material_name || 'Defective Material',
            description: dn.description || '',
            quantity: dn.quantity || 0,
            unit: dn.unit || 'kg',
            rate: dn.rate || 0,
            gst_rate: dn.gst_rate || 0,
            gst_amount: dn.gst_amount || 0,
            line_total: dn.grand_total || 0
          }
        ];

        items.forEach(it => {
          if (productVal !== 'all') {
            const matchId = it.material_id && String(it.material_id) === productVal;
            const matchName = it.material_name && it.material_name.toLowerCase().includes(productVal.toLowerCase());
            if (!matchId && !matchName) return;
          }

          const qty = Number(it.quantity) || 0;
          const rate = Number(it.rate) || 0;
          const lineTotal = Number(it.line_total) || (qty * rate);

          totalQty += qty;
          totalAmount += lineTotal;

          rows.push({
            'Date': dn.date || '',
            'Debit Note No': dn.debit_note_no || '',
            'Original Invoice Ref': dn.original_invoice_ref || '',
            'Vendor / Supplier': dn.vendor_name || '',
            'Vendor GSTIN': dn.vendor_gstIN || dn.vendor_gstin || '',
            'Defective Material': it.material_name || '',
            'Defect Description': it.description || '',
            'Rejection Reason': dn.reason || '',
            'Returned Quantity': qty,
            'Unit': it.unit || 'kg',
            'Unit Rate (Rs)': rate,
            'GST Rate %': Number(it.gst_rate) || 0,
            'GST Amount (Rs)': Math.round((Number(it.gst_amount) || 0) * 100) / 100,
            'Item Line Total (Rs)': Math.round(lineTotal * 100) / 100,
            'Debit Note Total (Rs)': Number(dn.grand_total) || lineTotal,
            'Stock Deducted': dn.deduct_stock !== false ? 'Yes' : 'No',
            'Remarks': dn.notes || ''
          });
        });
      });

      if (rows.length > 0) {
        rows.push({
          'Date': 'TOTAL',
          'Debit Note No': `${rows.length} Defective Items`,
          'Original Invoice Ref': '',
          'Vendor / Supplier': '',
          'Vendor GSTIN': '',
          'Defective Material': '',
          'Defect Description': '',
          'Rejection Reason': '',
          'Returned Quantity': Math.round(totalQty * 1000) / 1000,
          'Unit': '',
          'Unit Rate (Rs)': '',
          'GST Rate %': '',
          'GST Amount (Rs)': '',
          'Item Line Total (Rs)': Math.round(totalAmount * 100) / 100,
          'Debit Note Total (Rs)': '',
          'Stock Deducted': '',
          'Remarks': ''
        });
      }
    }

    return {
      rows: rows,
      sheetName: sheetName,
      filename: `${baseFilename}.xlsx`
    };
  }

  updateExportPreviewCount() {
    const badge = document.getElementById('export-preview-badge');
    if (!badge) return;

    try {
      const data = this.getFilteredExportData();
      const count = data && data.rows ? Math.max(0, data.rows.length - (data.rows.length > 0 && (data.rows[data.rows.length - 1].Date === 'TOTAL' || data.rows[data.rows.length - 1]['Material Code'] === 'TOTAL' || data.rows[data.rows.length - 1]['SKU'] === 'TOTAL') ? 1 : 0)) : 0;
      badge.textContent = `${count} record${count === 1 ? '' : 's'}`;
    } catch (e) {
      console.warn("Export preview count calculation:", e);
      badge.textContent = '0 records';
    }
  }

  executeExport(format = 'xlsx') {
    const result = this.getFilteredExportData();
    if (!result || !result.rows || result.rows.length === 0) {
      alert("No records match the selected date, product, and party filters to export.");
      return;
    }

    if (format === 'xlsx' && typeof XLSX !== 'undefined') {
      try {
        const ws = XLSX.utils.json_to_sheet(result.rows);

        const colWidths = [];
        if (result.rows.length > 0) {
          Object.keys(result.rows[0]).forEach(key => {
            let maxLen = key.length;
            result.rows.forEach(r => {
              const val = r[key];
              if (val !== undefined && val !== null) {
                maxLen = Math.max(maxLen, String(val).length);
              }
            });
            colWidths.push({ wch: Math.min(Math.max(maxLen + 2, 10), 45) });
          });
          ws['!cols'] = colWidths;
        }

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, result.sheetName || 'Sheet1');
        XLSX.writeFile(wb, result.filename.replace(/\.csv$/, '.xlsx'));
        this.closeModal('modal-export-excel');
        return;
      } catch (e) {
        console.error("XLSX export failed, falling back to CSV:", e);
      }
    }

    this.downloadCsv(result.rows, result.filename.replace(/\.xlsx$/, '.csv'));
    this.closeModal('modal-export-excel');
  }

  downloadCsv(rows, filename) {
    if (!rows || rows.length === 0) return;
    const headers = Object.keys(rows[0]);
    const csvContent = [
      headers.map(h => `"${String(h).replace(/"/g, '""')}"`).join(','),
      ...rows.map(row => 
        headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '""';
          return `"${String(val).replace(/"/g, '""')}"`;
        }).join(',')
      )
    ].join('\r\n');

    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

// Instantiate
window.app = new MFPMobilePortal();
