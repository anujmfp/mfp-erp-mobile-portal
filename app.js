/**
 * MFP ERP - Core Client-Side Logic Engine
 * Unified Finance & Operations System
 */

// Initialize pdf.js worker CDN
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

class MFPERP {
  constructor() {
    // Database schema merging inventory and cash ledgers
    this.db = {
      raw_materials: [],
      products: [],
      orders: [],               // Purchase orders (sync with cloud & mobile)
      inwards: [],              // Inward receipts
      productions: [],          // Daily manufacturing batches
      outwards: [],             // Dispatches
      transactions: [],         // Operational inventory logs (inward/outward/production)
      finance_transactions: [], // Cash book parsed from Excel monthly sheet
      employees: [],            // Employee summary records
      columnMapping: {
        date: 'Date',
        details: 'Transaction Details',
        debit: 'Debit',
        credit: 'Credit',
        balance: 'Balance',
        department: 'Is Expense Part of HO Growing Processing',
        expenseDetails: 'Details of the Expense',
        saleRevenue: 'Sale Revenue'
      },
      settings: {
        default_wastage: 1.5
      }
    };

    // UI & sorting state
    this.activeTab = 'finance-dashboard-view';
    this.historyFilter = 'all'; // Filter for activity logs
    this.activeLedgerMaterialId = null; // Currently viewed material in ledger modal
    this.bomTempList = []; // Temp recipe items when configuring products
    this.currentVerifyPurchaseItems = [];
    this.currentVerifySaleItems = [];
    
    // Sort configurations for ledger
    this.ledgerSort = {
      column: 'date',
      direction: 'desc'
    };

    // Global chart references
    this.financeChart = null;

    // Loaded Excel rows cache
    this.tempExcelRows = [];
    this.desktopDebitItems = [];

    // Cutover & Reconciliation Workspace State
    this.reconciliation = {
      cutoverDate: '2026-04-01',
      openingStockRM: {},
      openingStockFG: {},
      purchases: [],
      sales: [],
      physicalCountsRM: {},
      physicalCountsFG: {},
      finalOverridesRM: {},
      finalOverridesFG: {},
      activeSubtab: 'rm'
    };

    this.init();
  }

  init() {
    this.supabase = null;
    this.supabaseConfig = { supabaseUrl: '', supabaseKey: '', isOnline: false };

    // Load database from localStorage
    const savedDb = localStorage.getItem('erp_inventory_db');
    if (savedDb) {
      try {
        const parsed = JSON.parse(savedDb);
        // Merge structures
        this.db = {
          ...this.db,
          ...parsed,
          settings: { ...this.db.settings, ...(parsed.settings || {}) },
          columnMapping: { ...this.db.columnMapping, ...(parsed.columnMapping || {}) }
        };
        // Guarantee arrays exist
        if (!this.db.raw_materials) this.db.raw_materials = [];
        if (!this.db.products) this.db.products = [];
        if (!this.db.orders) this.db.orders = [];
        if (!this.db.inwards) this.db.inwards = [];
        if (!this.db.productions) this.db.productions = [];
        if (!this.db.outwards) this.db.outwards = [];
        if (!this.db.debit_notes) this.db.debit_notes = [];
        if (!this.db.transactions) this.db.transactions = [];
        if (!this.db.finance_transactions) this.db.finance_transactions = [];
        if (!this.db.employees) this.db.employees = [];

        // Auto-sanitize finance_transactions to guarantee Capital Infusions are never classified as expenses
        let sanitized = false;
        this.db.finance_transactions.forEach(t => {
          if (this.isCapitalInfusion(t.category, t.details)) {
            if (t.category !== 'Capital Infusion') {
              t.category = 'Capital Infusion';
              sanitized = true;
            }
          }
        });
        if (sanitized) this.saveDb();
      } catch (e) {
        console.error("Failed to parse local storage DB, resetting.", e);
        this.saveDb();
      }
    } else {
      this.saveDb();
    }

    // Auto-apply 7-Nov-2026 cutoff inventory starting dataset if version not applied
    const CUTOFF_VERSION = (typeof MFP_CUTOFF_DATA_7NOV !== 'undefined' && MFP_CUTOFF_DATA_7NOV.version) ? MFP_CUTOFF_DATA_7NOV.version : '2026-11-07-v1';
    const currentCutoff = localStorage.getItem('erp_cutoff_version');
    if (currentCutoff !== CUTOFF_VERSION && typeof MFP_CUTOFF_DATA_7NOV !== 'undefined') {
      console.log("Auto-applying 7-Nov-2026 Cutoff Starting Dataset in ERP...");
      this.applyCutoff7Nov();
    }

    this.historyFilter = 'all';

    // Set up navigation event listeners
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const viewId = e.currentTarget.getAttribute('data-view');
        this.switchView(viewId);
      });
    });

    // Mobile menu items click listeners
    const mobileMenuItems = document.querySelectorAll('.mobile-menu-item');
    mobileMenuItems.forEach(item => {
      item.addEventListener('click', (e) => {
        const paneId = e.currentTarget.getAttribute('data-pane');
        mobileMenuItems.forEach(mi => mi.classList.remove('active'));
        e.currentTarget.classList.add('active');
        
        document.querySelectorAll('.mobile-pane').forEach(p => p.classList.remove('active'));
        document.getElementById(paneId).classList.add('active');
      });
    });

    // PDF drag-and-drop setup for operations
    this.setupDropzone('purchase-dropzone', 'purchase-file-input', (file) => this.handlePurchaseUpload(file));
    this.setupDropzone('sale-dropzone', 'sale-file-input', (files) => {
      if (files instanceof FileList || Array.isArray(files)) {
        this.handleSaleUploadMultiple(files);
      } else {
        this.handleSaleUploadMultiple([files]);
      }
    }, true);

    this.loadSupabaseConfig();
    this.pullDataFromSupabase();

    // Default production run date configuration
    this.refreshAllViews();
    this.calibrateSettings();
  }

  // Save database to localStorage
  saveDb() {
    localStorage.setItem('erp_inventory_db', JSON.stringify(this.db));
  }

  // Calibrate Settings form values
  calibrateSettings() {
    const input = document.getElementById('default-wastage-input');
    if (input) {
      input.value = this.db.settings.default_wastage;
      input.addEventListener('change', (e) => {
        this.db.settings.default_wastage = parseFloat(e.target.value) || 1.5;
        this.saveDb();
      });
    }
  }

  // Navigation Panel SPA toggling
  switchView(viewId) {
    this.activeTab = viewId;
    document.querySelectorAll('.view-panel').forEach(panel => {
      panel.classList.remove('active');
    });
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.remove('active');
      if (item.getAttribute('data-view') === viewId) {
        item.classList.add('active');
      }
    });
    
    const targetPanel = document.getElementById(viewId);
    if (targetPanel) {
      targetPanel.classList.add('active');
    }

    // Tab-specific loading callbacks
    if (viewId === 'finance-dashboard-view') {
      this.renderFinanceDashboard();
    } else if (viewId === 'monthly-ledger-view') {
      this.populateMonthFilterDropdown();
      this.renderMonthlyLedger();
    } else if (viewId === 'employee-directory-view') {
      this.renderEmployeeDirectory();
    } else if (viewId === 'dashboard-view') {
      this.renderOperationalDashboard();
    } else if (viewId === 'raw-materials-view') {
      this.renderMaterials();
    } else if (viewId === 'finished-goods-view') {
      this.renderFinishedGoods();
    } else if (viewId === 'products-view') {
      this.renderProducts();
    } else if (viewId === 'mobile-console-view') {
      this.populateMobileDropdowns();
    } else if (viewId === 'debit-notes-view') {
      this.renderDebitNotesTable();
    } else if (viewId === 'history-view') {
      this.renderHistory();
    } else if (viewId === 'inventory-reconciliation-view') {
      this.initReconciliationView();
    }
  }

  refreshAllViews() {
    this.populateMonthFilterDropdown();
    this.renderFinanceDashboard();
    this.renderMonthlyLedger();
    this.renderEmployeeDirectory();
    this.renderOperationalDashboard();
    this.renderMaterials();
    this.renderFinishedGoods();
    this.renderProducts();
    this.renderDebitNotesTable();
    this.renderHistory();
  }

  // Format currencies in Indian Standard Format (Rupees, Lakhs, Crores)
  formatCurrency(val) {
    return 'Rs. ' + (val || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Helper to reliably identify Capital Infusion transactions (excluded from operating expenses & costs)
  isCapitalInfusion(category, details = '') {
    const cat = String(category || '').toLowerCase().trim();
    const det = String(details || '').toLowerCase().trim();
    if (cat === 'capital infusion' || 
        cat === 'capital-infusion' || 
        cat.includes('capital infusion') || 
        cat.includes('loan to mfp') || 
        cat === 'infusion') {
      return true;
    }
    if ((!cat || cat === 'uncategorized' || cat === 'other/misc' || cat === 'banking and finance expense') &&
        (det.includes('loan to mfp') || det.includes('capital infusion') || det.includes('partner infusion') || det.includes('promoter loan') || det.includes('partner loan'))) {
      return true;
    }
    return false;
  }

  // Parse Indian DD-MM-YYYY or general date strings to standard YYYY-MM-DD
  formatDateToISO(dateStr) {
    if (!dateStr) return new Date().toISOString().split('T')[0];
    const clean = String(dateStr).trim();
    const parts = clean.split(/[-\/.]/);
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        // YYYY-MM-DD
        return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
      } else if (parts[2].length === 4) {
        // DD-MM-YYYY
        return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }
    }
    const parsed = Date.parse(clean);
    if (!isNaN(parsed)) return new Date(parsed).toISOString().split('T')[0];
    return new Date().toISOString().split('T')[0];
  }

  // Close helper
  openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
  }

  closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  // Setup Dropzone Event Hooks
  setupDropzone(zoneId, inputId, onFileSelected, allowMultiple = false) {
    const zone = document.getElementById(zoneId);
    if (!zone) return;
    
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.style.borderColor = 'var(--color-primary)';
      zone.style.backgroundColor = 'rgba(16, 185, 129, 0.02)';
    });

    zone.addEventListener('dragleave', () => {
      zone.style.borderColor = 'var(--border-medium)';
      zone.style.backgroundColor = 'rgba(255, 255, 255, 0.01)';
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.style.borderColor = 'var(--border-medium)';
      zone.style.backgroundColor = 'rgba(255, 255, 255, 0.01)';
      
      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        onFileSelected(allowMultiple ? files : files[0]);
      }
    });

    if (inputId) {
      const input = document.getElementById(inputId);
      if (input) {
        input.addEventListener('change', (e) => {
          const files = e.target.files;
          if (files && files.length > 0) {
            onFileSelected(allowMultiple ? files : files[0]);
          }
          input.value = ''; // Reset
        });
      }
    }
  }


  /* ==========================================================================
     FINANCE PORTION: EXCEL READING & CASH BOOK
     ========================================================================== */
  
  importMonthlyExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rawJson = XLSX.utils.sheet_to_json(worksheet);

        if (rawJson.length === 0) {
          alert("The uploaded Excel workbook contains no transactions.");
          return;
        }

        this.tempExcelRows = rawJson;
        this.openMappingModal(rawJson[0]);
      } catch (err) {
        console.error("Failed to read Excel file", err);
        alert("Failed to parse the Excel workbook. Please check formatting.");
      }
    };
    reader.readAsArrayBuffer(file);
    event.target.value = ''; // Reset input element
  }

  // Open the Excel Column Mapping interface dynamically
  openMappingModal(firstRow) {
    const container = document.getElementById('excel-mapping-container');
    container.innerHTML = '';

    const excelHeaders = Object.keys(firstRow);
    const systemFields = [
      { id: 'date', label: 'Date', default: 'Date' },
      { id: 'details', label: 'Transaction Details (Remarks)', default: 'Transaction Details' },
      { id: 'debit', label: 'Debit (Outgoing Expense)', default: 'Debit' },
      { id: 'credit', label: 'Credit (Sales Revenue)', default: 'Credit' },
      { id: 'balance', label: 'Running Balance', default: 'Balance' },
      { id: 'expenseDetails', label: 'Details of the Expense', default: 'Details of the Expense' },
      { id: 'saleRevenue', label: 'Sale Revenue', default: 'Sale Revenue' }
    ];

    systemFields.forEach(field => {
      const item = document.createElement('div');
      item.className = 'mapping-item';
      
      item.innerHTML = `
        <div class="mapping-info">
          <h4>${field.label}</h4>
          <p>System target field mapping</p>
        </div>
        <select class="form-control" data-field="${field.id}">
          <option value="">-- Skip Column --</option>
          ${excelHeaders.map(h => {
            const selected = h.toLowerCase().replace(/[^a-z0-9]/g, '') === field.default.toLowerCase().replace(/[^a-z0-9]/g, '') ? 'selected' : '';
            return `<option value="${h}" ${selected}>${h}</option>`;
          }).join('')}
        </select>
      `;
      container.appendChild(item);
    });

    this.openModal('column-mapper-modal');
  }

  // Confirm Excel file headers mapping and ingest data
  commitFinanceImport() {
    const selects = document.querySelectorAll('#excel-mapping-container select');
    const mapping = {};
    selects.forEach(select => {
      const fieldId = select.getAttribute('data-field');
      mapping[fieldId] = select.value;
    });

    this.db.columnMapping = mapping;
    this.saveDb();

    // Map raw rows to database schema
    const newTransactions = [];
    this.tempExcelRows.forEach((row, index) => {
      const getVal = (field) => {
        const header = mapping[field];
        return header ? row[header] : undefined;
      };

      const dateVal = getVal('date');
      const detailsVal = String(getVal('details') || '').trim();
      const debitVal = parseFloat(getVal('debit')) || 0;
      const creditVal = parseFloat(getVal('credit')) || 0;
      const balanceVal = parseFloat(getVal('balance')) || 0;
      const expDetailsVal = String(getVal('expenseDetails') || '').trim();
      const saleRevVal = parseFloat(getVal('saleRevenue')) || 0;

      if (!dateVal && debitVal === 0 && creditVal === 0) return; // skip completely blank lines

      // Clean date value
      let formattedDate = '';
      if (typeof dateVal === 'number') {
        // Handle Excel Date Serial Number
        const d = new Date((dateVal - 25569) * 86400 * 1000);
        formattedDate = d.toISOString().split('T')[0];
      } else if (dateVal) {
        const parsed = Date.parse(dateVal);
        formattedDate = !isNaN(parsed) ? new Date(parsed).toISOString().split('T')[0] : String(dateVal);
      } else {
        formattedDate = new Date().toISOString().split('T')[0];
      }

      // Merge Credit and Sale Revenue
      const finalCredit = creditVal || saleRevVal;

      // 1. CAPITAL INFUSION VERIFICATION
      // Prioritize identifying capital infusions, partner loans, promoter infusions, or equity (STRICTLY non-operating)
      const deptVal = String(getVal('department') || '').trim();
      const searchTxt = (detailsVal + ' ' + expDetailsVal + ' ' + deptVal).toLowerCase();
      let tabCategory = 'Uncategorized';
      let subCategory = '';

      if (searchTxt.includes('loan to mfp') || 
          searchTxt.includes('capital infusion') || 
          searchTxt.includes('infusion') || 
          searchTxt.includes('partner loan') || 
          searchTxt.includes('promoter loan') || 
          searchTxt.includes('director loan') || 
          searchTxt.includes('equity capital') || 
          searchTxt.includes('share capital') ||
          (searchTxt.includes('capital') && !searchTxt.includes('working capital loan'))) {
        tabCategory = 'Capital Infusion';
      } else if (finalCredit > 0) {
        tabCategory = 'Sale Receipt';
      } else if (debitVal > 0) {
        // Run heuristic auto-categorizer matching expense heads
        if (searchTxt.includes('salary') || searchTxt.includes('wage') || searchTxt.includes('payroll') || searchTxt.includes('employee')) {
          tabCategory = 'salary and wages';
        } else if (searchTxt.includes('lease') || searchTxt.includes('rent')) {
          tabCategory = 'lease';
        } else if (searchTxt.includes('electric') || searchTxt.includes('power') || searchTxt.includes('utility')) {
          tabCategory = 'electricity';
        } else if (searchTxt.includes('interest') || searchTxt.includes('bank charge') || searchTxt.includes('bank fee') || searchTxt.includes('finance charge') || (searchTxt.includes('bank') && !searchTxt.includes('loan'))) {
          tabCategory = 'banking and finance expense';
        } else if (searchTxt.includes('nutrient') || searchTxt.includes('fertilizer') || searchTxt.includes('manure')) {
          tabCategory = 'growing expenses';
          subCategory = 'nutrients';
        } else if (searchTxt.includes('labor') || searchTxt.includes('labour') || searchTxt.includes('field wage')) {
          tabCategory = 'growing expenses';
          subCategory = 'labour';
        } else if (searchTxt.includes('seed')) {
          tabCategory = 'growing expenses';
          subCategory = 'seeds';
        } else if (searchTxt.includes('sapling')) {
          tabCategory = 'growing expenses';
          subCategory = 'saplings';
        } else if (searchTxt.includes('bottle')) {
          tabCategory = 'processing';
          subCategory = 'bottles';
        } else if (searchTxt.includes('box') || searchTxt.includes('carton')) {
          tabCategory = 'processing';
          subCategory = 'boxes - inner'; // Default outer/inner
        } else if (searchTxt.includes('pouch') || searchTxt.includes('bag') || searchTxt.includes('packaging') || searchTxt.includes('packing')) {
          tabCategory = 'processing';
          subCategory = 'packaging material';
        } else if (searchTxt.includes('chilli') || searchTxt.includes('peri') || searchTxt.includes('thyme') || searchTxt.includes('rosemary') || searchTxt.includes('herb') || searchTxt.includes('spice')) {
          tabCategory = 'processing';
          subCategory = 'raw material';
        } else {
          tabCategory = 'other/misc';
        }
      }

      newTransactions.push({
        id: 'fin_' + Date.now() + '_' + index + '_' + Math.floor(Math.random() * 1000),
        date: formattedDate,
        details: detailsVal || expDetailsVal || 'Excel transaction log',
        debit: debitVal,
        credit: finalCredit,
        balance: balanceVal,
        category: tabCategory,
        subCategory: subCategory,
        employee_id: '' // Can link to employee directory
      });
    });

    // Overwrite/Merge: Merge new excel rows, sorting chronologically
    this.db.finance_transactions = [...this.db.finance_transactions, ...newTransactions];
    this.db.finance_transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    this.saveDb();

    this.closeModal('column-mapper-modal');
    this.refreshAllViews();
    
    alert(`Successfully processed Excel. Imported ${newTransactions.length} transactions!`);
  }

  // Clear finance ledger database
  clearFinanceLedger() {
    if (!confirm("Are you sure you want to delete all cash book transactions? This resets your finance dashboards.")) return;
    this.db.finance_transactions = [];
    this.saveDb();
    this.refreshAllViews();
  }

  // Export ledger cash book to JSON backup
  exportFinanceLedgerJSON() {
    const dataStr = JSON.stringify(this.db.finance_transactions, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `AetherERP_FinanceLedger_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Update transaction category mapping on dropdown select changes
  updateTransactionCategory(txId, value) {
    const tx = this.db.finance_transactions.find(t => t.id === txId);
    if (!tx) return;

    tx.category = value;
    tx.subCategory = ''; // Reset subCategory to select new sub-head
    this.saveDb();
    this.renderMonthlyLedger();
    this.renderFinanceDashboard();
    this.renderEmployeeDirectory();
  }

  updateTransactionSubCategory(txId, value) {
    const tx = this.db.finance_transactions.find(t => t.id === txId);
    if (!tx) return;

    tx.subCategory = value;
    this.saveDb();
    this.renderMonthlyLedger();
    this.renderFinanceDashboard();
  }

  // Link a salary debit transaction row to a specific employee
  linkTransactionToEmployee(txId, empId) {
    const tx = this.db.finance_transactions.find(t => t.id === txId);
    if (tx) {
      tx.employee_id = empId;
      this.saveDb();
      this.renderEmployeeDirectory();
    }
  }

  // Calculate finance metrics
  getFinanceFinancials() {
    let sales = 0;
    let expenses = 0;
    let infusions = 0;

    const breakdown = {
      lease: 0,
      electricity: 0,
      'banking and finance expense': 0,
      'salary and wages': 0,
      'growing expenses': 0,
      'processing': 0,
      'other/misc': 0,
      'Uncategorized': 0
    };

    // Timeline array
    const monthlyData = {};

    this.db.finance_transactions.forEach(t => {
      const monthKey = (t.date || '').substring(0, 7); // YYYY-MM
      if (monthKey && !monthlyData[monthKey]) {
        monthlyData[monthKey] = { month: monthKey, sales: 0, expenses: 0 };
      }

      const isInfusion = this.isCapitalInfusion(t.category, t.details);
      const catLower = String(t.category || '').toLowerCase().trim();

      if (isInfusion) {
        // STRICT RULE: Capital Infusion is financing (equity/promoter loan).
        // It must NEVER be added to Operating Expenses, Cost, or Sales Revenue!
        const creditAmt = parseFloat(t.credit) || 0;
        const debitAmt = parseFloat(t.debit) || 0;
        const infusionVal = creditAmt > 0 ? creditAmt : debitAmt;
        infusions += infusionVal;
        // DO NOT add to expenses. DO NOT add to monthlyData expenses. DO NOT add to breakdown.
      } else if (catLower === 'sale receipt' || catLower === 'sale' || catLower === 'sales revenue' || catLower.includes('sale receipt') || (catLower.includes('sale') && !catLower.includes('wholesale expense'))) {
        const creditAmt = parseFloat(t.credit) || 0;
        sales += creditAmt;
        if (monthKey && monthlyData[monthKey]) {
          monthlyData[monthKey].sales += creditAmt;
        }
      } else {
        // Operating Expense debits ONLY (STRICTLY non-infusion)
        const debitAmt = parseFloat(t.debit) || 0;
        expenses += debitAmt;
        if (monthKey && monthlyData[monthKey]) {
          monthlyData[monthKey].expenses += debitAmt;
        }
        
        const cat = t.category || 'Uncategorized';
        if (breakdown[cat] !== undefined) {
          breakdown[cat] += debitAmt;
        } else {
          breakdown['Uncategorized'] += debitAmt;
        }
      }
    });

    const timeline = Object.keys(monthlyData).sort().map(key => monthlyData[key]);

    return {
      totalSales: sales,
      totalExpenses: expenses,
      netProfit: sales - expenses,
      totalInfusions: infusions,
      breakdown,
      timeline
    };
  }

  // Render Finance dashboard metrics and charts
  renderFinanceDashboard() {
    const fin = this.getFinanceFinancials();

    document.getElementById('fin-metric-sales').textContent = this.formatCurrency(fin.totalSales);
    document.getElementById('fin-metric-expenses').textContent = this.formatCurrency(fin.totalExpenses);
    
    const profitEl = document.getElementById('fin-metric-profit');
    profitEl.textContent = this.formatCurrency(fin.netProfit);
    if (fin.netProfit >= 0) {
      profitEl.style.color = 'var(--color-success)';
      document.getElementById('fin-metric-profit-trend').className = 'metric-trend trend-up';
      document.getElementById('fin-metric-profit-trend').innerHTML = `<i class="fa-solid fa-arrow-trend-up"></i> Net Surplus`;
    } else {
      profitEl.style.color = 'var(--color-danger)';
      document.getElementById('fin-metric-profit-trend').className = 'metric-trend trend-down';
      document.getElementById('fin-metric-profit-trend').innerHTML = `<i class="fa-solid fa-arrow-trend-down"></i> Operating Deficit`;
    }

    document.getElementById('fin-metric-infusions').textContent = this.formatCurrency(fin.totalInfusions);

    // Render Category Breakdown list
    const breakdownList = document.getElementById('finance-breakdown-list');
    breakdownList.innerHTML = '';

    const categories = [
      { id: 'lease', label: 'Lease & Rentals', color: 'ho' },
      { id: 'electricity', label: 'Electricity / Utilities', color: 'processing' },
      { id: 'banking and finance expense', label: 'Banking & Financial', color: 'fixed' },
      { id: 'salary and wages', label: 'Salary and Wages', color: 'salary' },
      { id: 'growing expenses', label: 'Growing Operations', color: 'growing' },
      { id: 'processing', label: 'Processing & Raw Materials', color: 'purchase' },
      { id: 'other/misc', label: 'Other Office & Misc', color: 'fixed' },
      { id: 'Uncategorized', label: 'Uncategorized Expenses', color: 'fixed' }
    ];

    const totalExp = fin.totalExpenses || 1; // avoid divide by zero

    categories.forEach(cat => {
      const val = fin.breakdown[cat.id] || 0;
      if (val === 0) return; // skip empty categories

      const pct = ((val / totalExp) * 100).toFixed(0);

      const div = document.createElement('div');
      div.className = 'stats-item';
      div.innerHTML = `
        <div class="stats-item-header" style="display:flex; justify-content:space-between; font-size: 0.85rem; margin-bottom:0.35rem;">
          <span class="stats-item-lbl" style="font-weight: 500;">${cat.label}</span>
          <span class="stats-item-val" style="font-weight:600;">${this.formatCurrency(val)} (${pct}%)</span>
        </div>
        <div class="progress-bar-bg" style="background:rgba(255,255,255,0.04); height: 8px; border-radius:4px; overflow:hidden; width:100%;">
          <div class="progress-bar-fill ${cat.color}" style="height: 100%; border-radius: 4px; background: ${this.getProgressBarColor(cat.id)}; width: ${pct}%;"></div>
        </div>
      `;
      breakdownList.appendChild(div);
    });

    if (breakdownList.innerHTML === '') {
      breakdownList.innerHTML = `<div class="empty-list-text">No expense records. Upload Excel to generate allocation breakdown.</div>`;
    }

    // Render Timeline Trend Chart (Chart.js)
    this.renderFinanceChart(fin.timeline);
  }

  getProgressBarColor(catId) {
    switch (catId) {
      case 'lease': return '#a78bfa';
      case 'electricity': return '#06b6d4';
      case 'banking and finance expense': return '#f43f5e';
      case 'salary and wages': return '#f59e0b';
      case 'growing expenses': return '#10b981';
      case 'processing': return '#3b82f6';
      default: return '#64748b';
    }
  }

  renderFinanceChart(timeline) {
    if (this.financeChart) {
      this.financeChart.destroy();
    }

    const ctx = document.getElementById('finance-trend-chart').getContext('2d');
    const months = timeline.map(t => t.month);
    const sales = timeline.map(t => t.sales);
    const expenses = timeline.map(t => t.expenses);

    if (months.length === 0) {
      ctx.clearRect(0, 0, 400, 320);
      return;
    }

    this.financeChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months,
        datasets: [
          {
            label: 'Sales Revenue (Rs.)',
            data: sales,
            backgroundColor: '#10b981',
            borderRadius: 6
          },
          {
            label: 'Operating Expenses (Rs.)',
            data: expenses,
            backgroundColor: '#ef4444',
            borderRadius: 6
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#94a3b8', font: { family: 'Inter', size: 11 } } },
          tooltip: {
            callbacks: {
              label: (context) => ` ${context.dataset.label.split(' ')[0]}: ${this.formatCurrency(context.parsed.y)}`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#64748b' } },
          y: {
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: {
              color: '#64748b',
              callback: (value) => 'Rs.' + value.toLocaleString('en-IN')
            }
          }
        }
      }
    });
  }

  // Ledger sorting controls
  sortLedger(col) {
    if (this.ledgerSort.column === col) {
      this.ledgerSort.direction = this.ledgerSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      this.ledgerSort.column = col;
      this.ledgerSort.direction = 'desc'; // Default new col to desc
    }
    this.renderMonthlyLedger();
  }

  // Helper to format YYYY-MM into readable month name (e.g. "2024-07" -> "July 2024")
  formatMonthLabel(monthKey) {
    if (!monthKey) return '';
    const parts = monthKey.split('-');
    if (parts.length >= 2) {
      const year = parts[0];
      const monthIdx = parseInt(parts[1], 10) - 1;
      const monthNames = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
      ];
      if (monthIdx >= 0 && monthIdx < 12) {
        return `${monthNames[monthIdx]} ${year}`;
      }
    }
    return monthKey;
  }

  // Populate Month Filter Dropdown in Monthly Ledger from recorded transactions
  populateMonthFilterDropdown() {
    const selectEl = document.getElementById('ledger-filter-month');
    if (!selectEl) return;

    const currentVal = selectEl.value;

    // Collect all unique YYYY-MM values from finance_transactions
    const monthsSet = new Set();
    this.db.finance_transactions.forEach(t => {
      if (t.date && typeof t.date === 'string') {
        const match = t.date.match(/^\d{4}-\d{2}/);
        if (match) {
          monthsSet.add(match[0]);
        } else {
          const d = new Date(t.date);
          if (!isNaN(d.getTime())) {
            monthsSet.add(d.toISOString().substring(0, 7));
          }
        }
      }
    });

    // Sort descending (latest month first)
    const sortedMonths = Array.from(monthsSet).sort().reverse();

    // Rebuild options while preserving selection
    let html = `<option value="">-- All Months --</option>`;
    sortedMonths.forEach(m => {
      const label = this.formatMonthLabel(m);
      const isSelected = (m === currentVal) ? 'selected' : '';
      html += `<option value="${m}" ${isSelected}>${label}</option>`;
    });

    selectEl.innerHTML = html;

    // Restore selected value if valid
    if (currentVal && monthsSet.has(currentVal)) {
      selectEl.value = currentVal;
    }
  }

  // Render the Monthly Ledger Table with Dynamic Selectors
  renderMonthlyLedger() {
    const tbody = document.getElementById('ledger-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    const searchInput = document.getElementById('ledger-search');
    const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const categorySelect = document.getElementById('ledger-filter-category');
    const categoryFilter = categorySelect ? categorySelect.value : '';
    const monthSelect = document.getElementById('ledger-filter-month');
    const monthFilter = monthSelect ? monthSelect.value : '';

    // Apply filters
    let filtered = this.db.finance_transactions.filter(t => {
      const matchSearch = (t.details || '').toLowerCase().includes(searchQuery) || 
                          (t.category || '').toLowerCase().includes(searchQuery) ||
                          (t.subCategory || '').toLowerCase().includes(searchQuery) ||
                          (t.date || '').includes(searchQuery);
      
      let matchCat = true;
      if (categoryFilter) {
        if (categoryFilter === 'Sale Receipt') {
          matchCat = t.category === 'Sale Receipt' || t.category === 'Sale' || (t.category && t.category.toLowerCase().includes('sale'));
        } else if (categoryFilter === 'Capital Infusion') {
          matchCat = this.isCapitalInfusion(t.category, t.details);
        } else {
          matchCat = t.category === categoryFilter;
        }
      }

      let matchMonth = true;
      if (monthFilter) {
        if ((t.date || '').startsWith(monthFilter)) {
          matchMonth = true;
        } else {
          const d = new Date(t.date);
          if (!isNaN(d.getTime())) {
            matchMonth = d.toISOString().substring(0, 7) === monthFilter;
          } else {
            matchMonth = false;
          }
        }
      }

      return matchSearch && matchCat && matchMonth;
    });

    // Apply sorting
    const col = this.ledgerSort.column;
    const dir = this.ledgerSort.direction === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      if (col === 'date') {
        return (new Date(a.date) - new Date(b.date)) * dir;
      } else if (col === 'debit') {
        return ((a.debit || 0) - (b.debit || 0)) * dir;
      } else if (col === 'credit') {
        return ((a.credit || 0) - (b.credit || 0)) * dir;
      }
      return 0;
    });

    // Update sort headers UI
    ['date', 'debit', 'credit'].forEach(c => {
      const el = document.getElementById(`sort-icon-${c}`);
      if (el) {
        if (this.ledgerSort.column === c) {
          el.className = this.ledgerSort.direction === 'asc' ? 'fa-solid fa-sort-up' : 'fa-solid fa-sort-down';
          el.style.color = 'var(--color-primary)';
        } else {
          el.className = 'fa-solid fa-sort';
          el.style.color = 'var(--text-dim)';
        }
      }
    });

    // Update Month Summary KPI Strip
    const summaryBar = document.getElementById('ledger-month-summary-bar');
    if (summaryBar) {
      if (filtered.length > 0) {
        summaryBar.style.display = 'flex';
        
        let opExpenses = 0;
        let salesRevenue = 0;
        let capitalInfusions = 0;

        filtered.forEach(t => {
          const isInf = this.isCapitalInfusion(t.category, t.details);
          if (isInf) {
            const amt = (parseFloat(t.credit) || 0) > 0 ? (parseFloat(t.credit) || 0) : (parseFloat(t.debit) || 0);
            capitalInfusions += amt;
          } else if (String(t.category || '').toLowerCase().includes('sale')) {
            salesRevenue += (parseFloat(t.credit) || 0);
          } else {
            opExpenses += (parseFloat(t.debit) || 0);
          }
        });

        const opNet = salesRevenue - opExpenses;
        const netClass = opNet >= 0 ? 'text-success' : 'text-danger';
        const netSign = opNet >= 0 ? '+' : '';
        const monthLabel = monthFilter ? `Month: <strong>${this.formatMonthLabel(monthFilter)}</strong>` : `<strong>All Recorded Months</strong>`;
        const catLabel = categoryFilter ? ` | Head: <strong>${categoryFilter}</strong>` : '';

        let infusionBadge = '';
        if (capitalInfusions > 0) {
          infusionBadge = `<span style="background: rgba(124, 58, 237, 0.12); color: var(--color-secondary); padding: 0.25rem 0.65rem; border-radius: 4px; border: 1px dashed var(--color-secondary); font-weight: 500;">Capital Infusion: <strong>${this.formatCurrency(capitalInfusions)}</strong> (Excluded from Cost/Expenses)</span>`;
        }

        if (categoryFilter === 'Capital Infusion') {
          summaryBar.innerHTML = `
            <div><i class="fa-solid fa-coins" style="color:var(--color-secondary); margin-right:0.35rem;"></i> Filtered Summary (${monthLabel}${catLabel}): <strong>${filtered.length}</strong> transactions</div>
            <div style="display:flex; gap:1.25rem; flex-wrap:wrap; align-items:center;">
              <span>Total Capital Infusion: <strong style="color:var(--color-secondary);">${this.formatCurrency(capitalInfusions)}</strong></span>
              <span class="td-muted font-sm" style="font-style: italic;"><i class="fa-solid fa-circle-check" style="color:var(--color-success);"></i> Strictly Excluded from Operating Expenses, Costs & P&L</span>
            </div>
          `;
        } else {
          summaryBar.innerHTML = `
            <div><i class="fa-solid fa-chart-pie" style="color:var(--color-primary); margin-right:0.35rem;"></i> Filtered Summary (${monthLabel}${catLabel}): <strong>${filtered.length}</strong> transactions</div>
            <div style="display:flex; gap:1.25rem; flex-wrap:wrap; align-items:center;">
              <span>Operating Expenses (Cost): <strong class="text-danger">${this.formatCurrency(opExpenses)}</strong></span>
              <span>Sales Revenue: <strong class="text-success">${this.formatCurrency(salesRevenue)}</strong></span>
              <span>Operating Margin: <strong class="${netClass}">${netSign}${this.formatCurrency(opNet)}</strong></span>
              ${infusionBadge}
            </div>
          `;
        }
      } else {
        summaryBar.style.display = 'none';
      }
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-list-text">No transaction lines found for the selected filters.</td></tr>`;
      return;
    }

    filtered.forEach(t => {
      const tr = document.createElement('tr');

      // Category selector
      const categories = [
        { value: 'Sale Receipt', label: 'Sale Receipt (Sales Revenue)' },
        { value: 'Uncategorized', label: 'Uncategorized' },
        { value: 'lease', label: 'Lease' },
        { value: 'electricity', label: 'Electricity' },
        { value: 'banking and finance expense', label: 'Banking & Finance' },
        { value: 'salary and wages', label: 'Salary & Wages' },
        { value: 'growing expenses', label: 'Growing Expenses' },
        { value: 'processing', label: 'Processing' },
        { value: 'Capital Infusion', label: 'Capital Infusion (MFP Loan)' },
        { value: 'other/misc', label: 'Other Office / Misc' }
      ];

      // Normalize current category value for dropdown selection
      let currentCategory = t.category;
      if (this.isCapitalInfusion(currentCategory, t.details)) {
        currentCategory = 'Capital Infusion';
      } else if (currentCategory === 'Sale' || (currentCategory && currentCategory.toLowerCase() === 'sales revenue')) {
        currentCategory = 'Sale Receipt';
      }

      const catSelectOptions = categories.map(cat => {
        const selected = currentCategory === cat.value ? 'selected' : '';
        return `<option value="${cat.value}" ${selected}>${cat.label}</option>`;
      }).join('');

      let subCategoryHtml = '';
      if (currentCategory === 'Sale Receipt' || currentCategory === 'Sale') {
        const saleSubHeads = ['Finished Goods Sale', 'Wholesale', 'Retail', 'Online / Ecommerce', 'Scrap / Byproducts', 'Other Sales Revenue'];
        subCategoryHtml = `
          <select class="table-select-category" style="font-size:0.75rem; padding:0.25rem;" onchange="app.updateTransactionSubCategory('${t.id}', this.value)">
            <option value="" disabled ${!t.subCategory ? 'selected' : ''}>-- Select sub-head --</option>
            ${saleSubHeads.map(sub => `<option value="${sub}" ${t.subCategory === sub ? 'selected' : ''}>${sub}</option>`).join('')}
          </select>
        `;
      } else if (currentCategory === 'growing-expenses' || currentCategory === 'growing expenses') {
        const growingSubHeads = ['nutrients', 'labour', 'saplings', 'seeds'];
        subCategoryHtml = `
          <select class="table-select-category" style="font-size:0.75rem; padding:0.25rem;" onchange="app.updateTransactionSubCategory('${t.id}', this.value)">
            <option value="" disabled ${!t.subCategory ? 'selected' : ''}>-- Select sub-head --</option>
            ${growingSubHeads.map(sub => `<option value="${sub}" ${t.subCategory === sub ? 'selected' : ''}>${sub.charAt(0).toUpperCase() + sub.slice(1)}</option>`).join('')}
          </select>
        `;
      } else if (currentCategory === 'processing') {
        const processingSubHeads = ['bottles', 'packaging material', 'boxes - inner', 'outter bottles', 'outer pouches', 'raw material'];
        
        // Render raw materials sub list options if raw material selected
        let rmListSelector = '';
        if (t.subCategory === 'raw material') {
          // List raw materials from DB
          const materialsList = this.db.raw_materials.map(m => m.name);
          // Add default raw materials if DB is empty
          if (materialsList.length === 0) {
            materialsList.push('Chilli', 'Peri Peri', 'Thyme', 'Rosemary');
          }
          
          rmListSelector = `
            <input type="text" class="form-control" style="font-size:0.7rem; padding: 0.2rem; margin-top:0.25rem; max-width:140px;" placeholder="Raw material item..." value="${t.rawMaterialItem || ''}" onchange="app.updateLedgerRawMaterialLink('${t.id}', this.value)">
          `;
        }

        subCategoryHtml = `
          <select class="table-select-category" style="font-size:0.75rem; padding:0.25rem;" onchange="app.updateTransactionSubCategory('${t.id}', this.value)">
            <option value="" disabled ${!t.subCategory ? 'selected' : ''}>-- Select sub-head --</option>
            ${processingSubHeads.map(sub => `<option value="${sub}" ${t.subCategory === sub ? 'selected' : ''}>${sub.charAt(0).toUpperCase() + sub.slice(1)}</option>`).join('')}
          </select>
          ${rmListSelector}
        `;
      } else {
        subCategoryHtml = `<span class="td-muted font-sm">-</span>`;
      }

      tr.innerHTML = `
        <td class="td-bold">${t.date}</td>
        <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${t.details}">${t.details}</td>
        <td class="text-right td-bold text-danger">${t.debit > 0 ? this.formatCurrency(t.debit) : '-'}</td>
        <td class="text-right td-bold text-success">${t.credit > 0 ? this.formatCurrency(t.credit) : '-'}</td>
        <td>
          <select class="table-select-category" onchange="app.updateTransactionCategory('${t.id}', this.value)">
            ${catSelectOptions}
          </select>
        </td>
        <td>
          ${subCategoryHtml}
        </td>
        <td style="text-align: right;">
          <button class="btn btn-danger btn-sm" onclick="app.deleteFinanceTransaction('${t.id}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  updateLedgerRawMaterialLink(txId, val) {
    const tx = this.db.finance_transactions.find(t => t.id === txId);
    if (tx) {
      tx.rawMaterialItem = val;
      this.saveDb();
    }
  }

  deleteFinanceTransaction(id) {
    if (!confirm("Are you sure you want to delete this cash book entry?")) return;
    this.db.finance_transactions = this.db.finance_transactions.filter(t => t.id !== id);
    this.saveDb();
    this.renderMonthlyLedger();
    this.renderFinanceDashboard();
    this.renderEmployeeDirectory();
  }


  /* ==========================================================================
     EMPLOYEE DIRECTORY & PAYROLL Sync
     ========================================================================== */

  renderEmployeeDirectory() {
    const tbody = document.getElementById('employees-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (this.db.employees.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-list-text">No employee profiles defined. Add staff to configure bank details and payroll rates.</td></tr>`;
    } else {
      this.db.employees.forEach(emp => {
        const activeBadge = emp.active 
          ? `<span class="badge badge-success"><i class="fa-solid fa-circle-check"></i> Active</span>`
          : `<span class="badge badge-danger"><i class="fa-solid fa-circle-xmark"></i> Inactive</span>`;
        
        const toggleBtn = emp.active 
          ? `<button class="btn btn-danger btn-sm" onclick="app.toggleEmployeeStatus('${emp.id}')"><i class="fa-solid fa-user-slash"></i> Deactivate</button>`
          : `<button class="btn btn-primary btn-sm" onclick="app.toggleEmployeeStatus('${emp.id}')"><i class="fa-solid fa-user-check"></i> Activate</button>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="td-bold">${emp.name}</td>
          <td>${emp.title}</td>
          <td class="td-muted">${emp.joined_date}</td>
          <td class="td-bold">${this.formatCurrency(emp.salary)}</td>
          <td>
            <div style="font-size:0.8rem;">
              <strong>A/C:</strong> ${emp.bank_account}<br>
              <strong>IFSC:</strong> ${emp.bank_ifsc}
            </div>
          </td>
          <td>${activeBadge}</td>
          <td class="td-actions" style="text-align: right;">
            ${toggleBtn}
            <button class="btn btn-secondary btn-sm" onclick="app.openEditEmployeeModal('${emp.id}')">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button class="btn btn-danger btn-sm" onclick="app.deleteEmployee('${emp.id}')">
              <i class="fa-solid fa-trash"></i>
            </button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    // 2. Render Linked Salary Payments
    const payBody = document.getElementById('salary-payments-table-body');
    payBody.innerHTML = '';

    const salaryTxs = this.db.finance_transactions.filter(t => t.category === 'salary and wages');
    
    if (salaryTxs.length === 0) {
      payBody.innerHTML = `<tr><td colspan="5" class="empty-list-text">No salary payments found. Categorize Excel debit rows under 'Salary & Wages' to route them here.</td></tr>`;
      return;
    }

    salaryTxs.forEach(t => {
      // Build drop-down menu of employees to link this cash outflow
      let empOptions = '<option value="">-- Unlinked Payment --</option>';
      this.db.employees.forEach(emp => {
        empOptions += `<option value="${emp.id}" ${t.employee_id === emp.id ? 'selected' : ''}>${emp.name} (${emp.title})</option>`;
      });

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${t.date}</td>
        <td class="td-bold" title="${t.details}">${t.details}</td>
        <td><span class="badge badge-primary">Salary / Wages</span></td>
        <td class="text-right td-bold text-danger">${this.formatCurrency(t.debit)}</td>
        <td>
          <select class="table-select-category" style="font-size:0.75rem;" onchange="app.linkTransactionToEmployee('${t.id}', this.value)">
            ${empOptions}
          </select>
        </td>
      `;
      payBody.appendChild(tr);
    });
  }

  openAddEmployeeModal() {
    document.getElementById('employee-modal-title').textContent = "Configure Employee Profile";
    document.getElementById('employee-form-id').value = '';
    document.getElementById('employee-form').reset();
    document.getElementById('employee-joined').value = new Date().toISOString().split('T')[0];
    this.openModal('employee-modal');
  }

  openEditEmployeeModal(id) {
    const emp = this.db.employees.find(e => e.id === id);
    if (!emp) return;

    document.getElementById('employee-modal-title').textContent = "Edit Employee Profile";
    document.getElementById('employee-form-id').value = emp.id;
    document.getElementById('employee-name').value = emp.name;
    document.getElementById('employee-title').value = emp.title;
    document.getElementById('employee-joined').value = emp.joined_date;
    document.getElementById('employee-salary').value = emp.salary;
    document.getElementById('employee-bank-account').value = emp.bank_account;
    document.getElementById('employee-bank-ifsc').value = emp.bank_ifsc;

    this.openModal('employee-modal');
  }

  saveEmployee() {
    const id = document.getElementById('employee-form-id').value;
    const name = document.getElementById('employee-name').value.trim();
    const title = document.getElementById('employee-title').value.trim();
    const joined = document.getElementById('employee-joined').value;
    const salary = parseFloat(document.getElementById('employee-salary').value) || 0;
    const account = document.getElementById('employee-bank-account').value.trim();
    const ifsc = document.getElementById('employee-bank-ifsc').value.toUpperCase().trim();

    if (!name || !title || !joined) {
      alert("Please fill in name, designation and joined date.");
      return;
    }

    if (id) {
      // Edit
      const index = this.db.employees.findIndex(e => e.id === id);
      if (index !== -1) {
        this.db.employees[index].name = name;
        this.db.employees[index].title = title;
        this.db.employees[index].joined_date = joined;
        this.db.employees[index].salary = salary;
        this.db.employees[index].bank_account = account;
        this.db.employees[index].bank_ifsc = ifsc;
      }
    } else {
      // Create
      this.db.employees.push({
        id: 'emp_' + Date.now(),
        name,
        title,
        joined_date: joined,
        salary,
        bank_account: account,
        bank_ifsc: ifsc,
        active: true
      });
    }

    this.saveDb();
    this.closeModal('employee-modal');
    this.renderEmployeeDirectory();
  }

  toggleEmployeeStatus(id) {
    const emp = this.db.employees.find(e => e.id === id);
    if (emp) {
      emp.active = !emp.active;
      this.saveDb();
      this.renderEmployeeDirectory();
    }
  }

  deleteEmployee(id) {
    if (!confirm("Are you sure you want to delete this employee profile?")) return;
    this.db.employees = this.db.employees.filter(e => e.id !== id);
    this.saveDb();
    this.renderEmployeeDirectory();
  }

  // Pre-load Sandbox demo financials
  generateFinanceDemoData() {
    if (!confirm("This will append mock transactions into the monthly ledger for testing (including lease, utilities, salaries, and capital infusions). Proceed?")) return;

    const mockRows = [
      // Credits (Sales)
      { 'Date': '2026-08-01', 'Transaction Details': 'Credit Sales FreshMart Supermarkets', 'Debit': 0, 'Credit': 450000, 'Balance': 450000, 'Is Expense Part of HO Growing Processing': '', 'Details of the Expense': '', 'Sale Revenue': 450000 },
      { 'Date': '2026-08-10', 'Transaction Details': 'Credit Sales City Distributors', 'Debit': 0, 'Credit': 280000, 'Balance': 730000, 'Is Expense Part of HO Growing Processing': '', 'Details of the Expense': '', 'Sale Revenue': 280000 },
      { 'Date': '2026-08-25', 'Transaction Details': 'Retail Counter Cash Receipts', 'Debit': 0, 'Credit': 125000, 'Balance': 855000, 'Is Expense Part of HO Growing Processing': '', 'Details of the Expense': '', 'Sale Revenue': 125000 },
      
      // Capital Infusions
      { 'Date': '2026-08-03', 'Transaction Details': 'Loan to MFP received from partners', 'Debit': 0, 'Credit': 600000, 'Balance': 1455000, 'Is Expense Part of HO Growing Processing': '', 'Details of the Expense': 'loan to mfp partner infusion', 'Sale Revenue': 0 },
      
      // Expenses Debits
      { 'Date': '2026-08-01', 'Transaction Details': 'Plot B Land lease PMT', 'Debit': 85000, 'Credit': 0, 'Balance': 1370000, 'Is Expense Part of HO Growing Processing': 'Growing', 'Details of the Expense': 'lease rental Plot B', 'Sale Revenue': 0 },
      { 'Date': '2026-08-04', 'Transaction Details': 'Electricity Utility Cold Storage', 'Debit': 42000, 'Credit': 0, 'Balance': 1328000, 'Is Expense Part of HO Growing Processing': 'Processing', 'Details of the Expense': 'State grid utility cold room bill', 'Sale Revenue': 0 },
      { 'Date': '2026-08-05', 'Transaction Details': 'Staff salaries wages August Part 1', 'Debit': 180000, 'Credit': 0, 'Balance': 1148000, 'Is Expense Part of HO Growing Processing': 'HO', 'Details of the Expense': 'Monthly payroll office admin staff', 'Sale Revenue': 0 },
      { 'Date': '2026-08-08', 'Transaction Details': 'SBI Bank loan Interest payment', 'Debit': 15000, 'Credit': 0, 'Balance': 1133000, 'Is Expense Part of HO Growing Processing': 'HO', 'Details of the Expense': 'finance charge bank interest', 'Sale Revenue': 0 },
      { 'Date': '2026-08-12', 'Transaction Details': 'Inward nutrients delivery supplier', 'Debit': 65000, 'Credit': 0, 'Balance': 1068000, 'Is Expense Part of HO Growing Processing': 'Growing', 'Details of the Expense': 'growing expenses nutrients liquid fertilizers', 'Sale Revenue': 0 },
      { 'Date': '2026-08-15', 'Transaction Details': 'Harvesting field labour wages', 'Debit': 45000, 'Credit': 0, 'Balance': 1023000, 'Is Expense Part of HO Growing Processing': 'Growing', 'Details of the Expense': 'Temporary labour wages green house plucking', 'Sale Revenue': 0 },
      { 'Date': '2026-08-20', 'Transaction Details': 'Glass bottles purchase restock', 'Debit': 110000, 'Credit': 0, 'Balance': 913000, 'Is Expense Part of HO Growing Processing': 'Processing', 'Details of the Expense': 'empty bottles packing order INV-9034', 'Sale Revenue': 0 },
      { 'Date': '2026-08-22', 'Transaction Details': 'Cartons inner box and Pouches restock', 'Debit': 55000, 'Credit': 0, 'Balance': 858000, 'Is Expense Part of HO Growing Processing': 'Processing', 'Details of the Expense': 'packaging material pouches supplier PMT', 'Sale Revenue': 0 },
      { 'Date': '2026-08-24', 'Transaction Details': 'Raw spice ingredients chilli peri peri', 'Debit': 95000, 'Credit': 0, 'Balance': 763000, 'Is Expense Part of HO Growing Processing': 'Processing', 'Details of the Expense': 'raw material spice crop purchase', 'Sale Revenue': 0 }
    ];

    // Load mock employees
    if (this.db.employees.length === 0) {
      this.db.employees = [
        { id: 'emp_1', name: 'John Doe', title: 'Processing Supervisor', joined_date: '2026-01-15', salary: 45000, bank_account: 'HDFC A/C 9834102', bank_ifsc: 'HDFC0001024', active: true },
        { id: 'emp_2', name: 'Alice Smith', title: 'Growing Lab Scientist', joined_date: '2026-02-10', salary: 65000, bank_account: 'ICICI A/C 4531024', bank_ifsc: 'ICIC0002013', active: true },
        { id: 'emp_3', name: 'Rohan Sharma', title: 'Field Labor Supervisor', joined_date: '2026-04-01', salary: 30000, bank_account: 'SBI A/C 912450124', bank_ifsc: 'SBIN0001204', active: true }
      ];
    }

    this.tempExcelRows = mockRows;
    this.commitFinanceImport();
  }


  /* ==========================================================================
     OPERATIONS & INVENTORY MANAGEMENT ENGINE
     ========================================================================== */

  // Render metrics on Operational Dashboard
  renderOperationalDashboard() {
    // 1. Raw Materials Asset Value
    const totalRMVal = this.db.raw_materials.reduce((sum, item) => {
      return sum + (parseFloat(item.current_stock) * parseFloat(item.average_price || 0));
    }, 0);
    document.getElementById('metric-inventory-value').textContent = this.formatCurrency(totalRMVal);

    // 2. Finished Goods Asset Value (MRP * Stock or Selling Price * Stock)
    const totalFGVal = this.db.products.reduce((sum, item) => {
      const stock = parseFloat(item.current_stock || 0);
      const price = parseFloat(item.selling_price || item.price || 0);
      return sum + (stock * price);
    }, 0);
    document.getElementById('metric-fg-value').textContent = this.formatCurrency(totalFGVal);

    // 3. Counts
    document.getElementById('metric-materials-count').textContent = this.db.raw_materials.length;
    document.getElementById('metric-products-count').textContent = this.db.products.length;

    // 4. Alerts Warnings list
    this.renderDashboardAlerts();

    // 5. Recent Activity lists
    this.renderDashboardActivities();
  }

  // Render dashboard alerts
  renderDashboardAlerts() {
    // RM Alerts
    const rmContainer = document.getElementById('dashboard-rm-alerts-list');
    const rmBadge = document.getElementById('rm-alert-summary-badge');
    
    rmContainer.innerHTML = '';
    const alertRM = this.db.raw_materials.filter(m => parseFloat(m.current_stock) <= parseFloat(m.min_stock || 0));

    if (alertRM.length === 0) {
      rmContainer.innerHTML = `<tr><td colspan="4" class="empty-list-text" style="color: var(--color-success); padding: 1rem 0;">No stock shortages. Well stocked!</td></tr>`;
      if (rmBadge) {
        rmBadge.className = "badge badge-success";
        rmBadge.textContent = "Healthy";
      }
    } else {
      alertRM.forEach(item => {
        const stock = parseFloat(item.current_stock);
        const minStock = parseFloat(item.min_stock || 0);
        const statusBadge = stock === 0 
          ? `<span class="badge badge-danger">Out</span>` 
          : `<span class="badge badge-warning">Low</span>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="td-bold">${item.code}</td>
          <td>${item.name}</td>
          <td class="td-bold" style="color: ${stock === 0 ? 'var(--color-danger)' : 'var(--color-warning)'}">${stock.toFixed(3)} ${item.unit}</td>
          <td>${statusBadge}</td>
        `;
        rmContainer.appendChild(tr);
      });
      if (rmBadge) {
        rmBadge.className = "badge badge-danger";
        rmBadge.textContent = `${alertRM.length} Alert`;
      }
    }

    // FG Alerts
    const fgContainer = document.getElementById('dashboard-fg-alerts-list');
    const fgBadge = document.getElementById('fg-alert-summary-badge');
    
    fgContainer.innerHTML = '';
    const alertFG = this.db.products.filter(p => parseFloat(p.current_stock || 0) <= parseFloat(p.min_stock || 0));

    if (alertFG.length === 0) {
      fgContainer.innerHTML = `<tr><td colspan="4" class="empty-list-text" style="color: var(--color-success); padding: 1rem 0;">Warehouse levels optimal!</td></tr>`;
      if (fgBadge) {
        fgBadge.className = "badge badge-success";
        fgBadge.textContent = "Healthy";
      }
    } else {
      alertFG.forEach(item => {
        const stock = parseFloat(item.current_stock || 0);
        const statusBadge = stock === 0 
          ? `<span class="badge badge-danger">Out</span>` 
          : `<span class="badge badge-warning">Low</span>`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="td-bold">${item.code}</td>
          <td>${item.name}</td>
          <td class="td-bold" style="color: ${stock === 0 ? 'var(--color-danger)' : 'var(--color-warning)'}">${stock.toFixed(0)} pcs</td>
          <td>${statusBadge}</td>
        `;
        fgContainer.appendChild(tr);
      });
      if (fgBadge) {
        fgBadge.className = "badge badge-danger";
        fgBadge.textContent = `${alertFG.length} Alert`;
      }
    }
  }

  // Get all unified operational activities (Orders, Inwards, Production, Dispatches)
  getAllActivities() {
    const list = [];
    const seenTxKeys = new Set();

    // 1. Orders (Purchase orders)
    (this.db.orders || []).forEach(ord => {
      const dateStr = ord.date || (ord.created_at ? ord.created_at.split('T')[0] : '');
      const ts = ord.created_at ? new Date(ord.created_at).getTime() : (dateStr ? new Date(dateStr).getTime() : 0);
      
      let itemSummary = '';
      if (Array.isArray(ord.items) && ord.items.length > 0) {
        itemSummary = ord.items.map(it => `${it.material_name || 'Item'} (${it.quantity_requested || it.quantity} ${it.unit || 'pcs'})`).join(', ');
      } else if (ord.material_name) {
        itemSummary = `${ord.material_name} (${ord.quantity_requested || ord.quantity || 0} ${ord.unit || 'pcs'})`;
      } else {
        itemSummary = 'Purchase Order';
      }

      const status = ord.status || 'Pending';
      const isPending = status.toLowerCase() === 'pending';

      list.push({
        id: ord.id,
        type: 'order',
        typeLabel: 'Order Placed',
        badgeClass: 'badge-warning',
        icon: 'fa-cart-shopping',
        date: dateStr || 'N/A',
        timestamp: ts,
        ref: ord.order_group_id || ord.order_no || ord.id,
        title: `PO: ${itemSummary}`,
        description: `Supplier: ${ord.supplier || ord.supplier_name || ord.vendor || 'Vendor'} • Status: ${status}`,
        quantities: itemSummary,
        status: status,
        isPendingOrder: isPending,
        rawItem: ord
      });
    });

    // 2. Inwards (Material Inward receipts)
    (this.db.inwards || []).forEach(inw => {
      const dateStr = inw.date || (inw.created_at ? inw.created_at.split('T')[0] : '');
      const ts = inw.created_at ? new Date(inw.created_at).getTime() : (dateStr ? new Date(dateStr).getTime() : 0);
      
      let itemSummary = '';
      if (Array.isArray(inw.items) && inw.items.length > 0) {
        itemSummary = inw.items.map(it => `${it.material_name || 'Item'} (+${it.quantity_received || it.quantity} ${it.unit || 'kg'})`).join(', ');
      } else if (inw.material_name) {
        itemSummary = `${inw.material_name} (+${inw.quantity_received || inw.quantity || 0} ${inw.unit || 'kg'})`;
      } else {
        itemSummary = 'Stock Inward';
      }

      const ref = inw.invoice_no || inw.bill_no || inw.id;
      seenTxKeys.add(`inward_${ref}_${dateStr}`);
      if (inw.id) seenTxKeys.add(inw.id);

      list.push({
        id: inw.id,
        type: 'inward',
        typeLabel: 'Stock Inward',
        badgeClass: 'badge-success',
        icon: 'fa-truck-ramp-box',
        date: dateStr || 'N/A',
        timestamp: ts,
        ref: ref,
        title: `Inward: ${itemSummary}`,
        description: `Supplier: ${inw.supplier || inw.supplier_name || inw.vendor || 'Supplier'}`,
        quantities: itemSummary,
        status: 'Received',
        material_id: inw.material_id,
        rawItem: inw
      });
    });

    // 3. Productions (Batch manufacturing runs)
    (this.db.productions || []).forEach(prd => {
      const dateStr = prd.date || (prd.created_at ? prd.created_at.split('T')[0] : '');
      const ts = prd.created_at ? new Date(prd.created_at).getTime() : (dateStr ? new Date(dateStr).getTime() : 0);
      
      let itemSummary = '';
      if (Array.isArray(prd.items) && prd.items.length > 0) {
        itemSummary = prd.items.map(it => `${it.product_name || 'Product'} (+${it.quantity_produced || it.quantity} pcs)`).join(', ');
      } else if (prd.product_name) {
        itemSummary = `${prd.product_name} (+${prd.quantity_produced || prd.quantity || 0} pcs)`;
      } else {
        itemSummary = 'Production Run';
      }

      const ref = prd.batch_ref || prd.batch_no || prd.id;
      seenTxKeys.add(`production_${ref}_${dateStr}`);
      if (prd.id) seenTxKeys.add(prd.id);

      list.push({
        id: prd.id,
        type: 'production',
        typeLabel: 'Production Run',
        badgeClass: 'badge-info',
        icon: 'fa-industry',
        date: dateStr || 'N/A',
        timestamp: ts,
        ref: ref,
        title: `Production: ${itemSummary}`,
        description: `Pack: ${prd.packaging_type || 'Standard'} • Yield: ${prd.quantity_produced || prd.quantity || 0} pcs`,
        quantities: itemSummary,
        status: 'Manufactured',
        product_id: prd.product_id,
        rawItem: prd
      });
    });

    // 4. Outwards (Dispatches & Sales)
    (this.db.outwards || []).forEach(out => {
      const dateStr = out.date || (out.created_at ? out.created_at.split('T')[0] : '');
      const ts = out.created_at ? new Date(out.created_at).getTime() : (dateStr ? new Date(dateStr).getTime() : 0);
      
      let itemSummary = '';
      if (Array.isArray(out.items) && out.items.length > 0) {
        itemSummary = out.items.map(it => `${it.product_name || 'Product'} (-${it.quantity_dispatched || it.quantity} pcs)`).join(', ');
      } else if (out.product_name) {
        itemSummary = `${out.product_name} (-${out.quantity_dispatched || out.quantity || 0} pcs)`;
      } else {
        itemSummary = 'Sales Dispatch';
      }

      const ref = out.invoice_no || out.dispatch_no || out.id;
      seenTxKeys.add(`dispatch_${ref}_${dateStr}`);
      if (out.id) seenTxKeys.add(out.id);

      const isSample = (out.customer && out.customer.toLowerCase().includes('sample')) || 
                       (ref && typeof ref === 'string' && ref.toLowerCase().startsWith('sample')) ||
                       parseFloat(out.price_billed) === 0;

      list.push({
        id: out.id,
        type: 'dispatch',
        typeLabel: isSample ? 'Sample Dispatch' : 'Stock Dispatch',
        badgeClass: isSample ? 'badge-warning' : 'badge-primary',
        icon: isSample ? 'fa-gift' : 'fa-truck-fast',
        date: dateStr || 'N/A',
        timestamp: ts,
        ref: ref,
        title: isSample ? `Sample: ${itemSummary}` : `Dispatch: ${itemSummary}`,
        description: isSample ? `Recipient: ${out.customer || 'Sample Recipient'} (Non-commercial)` : `Customer: ${out.customer || out.customer_name || 'Customer'}`,
        quantities: itemSummary,
        status: isSample ? 'Sample Sent' : 'Dispatched',
        product_id: out.product_id,
        rawItem: out
      });
    });

    // 5. Debit Notes (Vendor Returns for Defective Goods)
    (this.db.debit_notes || []).forEach(dn => {
      const dateStr = dn.date || (dn.created_at ? dn.created_at.split('T')[0] : '');
      const ts = dn.created_at ? new Date(dn.created_at).getTime() : (dateStr ? new Date(dateStr).getTime() : 0);

      let itemSummary = '';
      if (Array.isArray(dn.items) && dn.items.length > 0) {
        itemSummary = dn.items.map(it => `${it.material_name || it.item_name || 'Item'} (-${it.quantity} ${it.unit || 'units'})`).join(', ');
      } else {
        itemSummary = 'Defective Goods Return';
      }

      const ref = dn.debit_note_no || dn.ref_no || dn.id;
      seenTxKeys.add(`debit_${ref}_${dateStr}`);
      if (dn.id) seenTxKeys.add(dn.id);
      if (dn.id) seenTxKeys.add('tx_dn_' + dn.id);

      list.push({
        id: dn.id,
        type: 'debit_note',
        typeLabel: 'Debit Note',
        badgeClass: 'badge-danger',
        icon: 'fa-file-circle-minus',
        date: dateStr || 'N/A',
        timestamp: ts,
        ref: ref,
        title: `Debit Note: ${itemSummary}`,
        description: `Vendor: ${dn.vendor_name || 'Vendor'} • Reason: ${dn.reason || 'Defective Material'} • Rs. ${parseFloat(dn.grand_total || dn.total_amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}`,
        quantities: itemSummary,
        status: 'Issued',
        rawItem: dn
      });
    });

    // 6. Unified transactions from this.db.transactions
    (this.db.transactions || []).forEach(tx => {
      if (seenTxKeys.has(tx.id)) return;
      const ref = tx.invoice_no || tx.id;
      const dateStr = tx.date || '';
      if (seenTxKeys.has(`inward_${ref}_${dateStr}`) || 
          seenTxKeys.has(`production_${ref}_${dateStr}`) || 
          seenTxKeys.has(`dispatch_${ref}_${dateStr}`)) {
        return;
      }

      let actType = 'inward';
      let actLabel = 'Stock Inward';
      let badge = 'badge-success';
      let icon = 'fa-truck-ramp-box';

      if (tx.type === 'production') {
        actType = 'production';
        actLabel = 'Production Run';
        badge = 'badge-info';
        icon = 'fa-industry';
      } else if (tx.type === 'sale') {
        actType = 'dispatch';
        actLabel = 'Stock Dispatch';
        badge = 'badge-primary';
        icon = 'fa-truck-fast';
      }

      let qDetails = '';
      if (tx.raw_material_changes && tx.raw_material_changes.length > 0) {
        qDetails += tx.raw_material_changes.map(c => {
          const sign = c.qty_change > 0 ? '+' : '';
          return `${c.material_name}: ${sign}${c.qty_change.toFixed(2)}`;
        }).join(', ');
      }
      if (tx.product_changes && tx.product_changes.length > 0) {
        if (qDetails) qDetails += ' | ';
        qDetails += tx.product_changes.map(c => {
          const sign = c.qty_change > 0 ? '+' : '';
          return `[FG] ${c.product_name}: ${sign}${c.qty_change.toFixed(0)} pcs`;
        }).join(', ');
      }
      if (!qDetails && tx.items && tx.items.length > 0) {
        qDetails = tx.items.map(i => `${i.name} (${i.qty})`).join(', ');
      }

      list.push({
        id: tx.id,
        type: actType,
        typeLabel: actLabel,
        badgeClass: badge,
        icon: icon,
        date: dateStr || 'N/A',
        timestamp: dateStr ? new Date(dateStr).getTime() : 0,
        ref: ref,
        title: tx.description || `${actLabel} (${ref})`,
        description: tx.description || '',
        quantities: qDetails || '-',
        status: 'Completed',
        material_id: tx.raw_material_changes && tx.raw_material_changes[0] ? tx.raw_material_changes[0].material_id : null,
        rawItem: tx
      });
    });

    list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return list;
  }

  // Render recent activities on Dashboard
  renderDashboardActivities() {
    const container = document.getElementById('dashboard-activity-list');
    if (!container) return;
    container.innerHTML = '';

    const all = this.getAllActivities();
    const recents = all.slice(0, 6);

    if (recents.length === 0) {
      container.innerHTML = `<div class="empty-list-text" style="padding:1rem; text-align:center;">No recent operational activities recorded. Log orders, inwards, production or dispatches.</div>`;
      return;
    }

    recents.forEach(act => {
      const div = document.createElement('div');
      div.className = 'activity-item';
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';
      div.style.padding = '0.75rem';
      div.style.borderBottom = '1px solid var(--border-light)';
      div.style.gap = '0.75rem';

      let deleteBtn = '';
      if (act.isPendingOrder) {
        deleteBtn = `
          <button type="button" class="btn btn-secondary btn-sm" onclick="app.deleteOrder('${act.id}')" title="Delete order created by mistake" style="padding:0.2rem 0.45rem; font-size:0.75rem; color:var(--color-danger); border:1px solid rgba(239, 68, 68, 0.35); background:rgba(239, 68, 68, 0.08); border-radius:4px; margin-left:0.5rem;">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        `;
      }

      div.innerHTML = `
        <div style="flex:1; min-width:0;">
          <div class="td-bold" style="font-size:0.88rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            <i class="fa-solid ${act.icon}" style="margin-right:0.35rem; font-size:0.85rem;"></i>
            ${act.title}
          </div>
          <div class="td-muted" style="font-size:0.75rem; margin-top:0.18rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            Ref: <span class="td-bold">${act.ref}</span> • ${act.date} • ${act.description}
          </div>
        </div>
        <div style="display:flex; align-items:center; flex-shrink:0;">
          <span class="badge ${act.badgeClass}" style="font-size:0.72rem;">${act.typeLabel}</span>
          ${deleteBtn}
        </div>
      `;
      container.appendChild(div);
    });
  }

  // 7-Nov-2026 Cutoff Starting Stock Engine
  applyCutoff7Nov() {
    if (typeof MFP_CUTOFF_DATA_7NOV === 'undefined') return;

    // 1. Overwrite raw materials & products with exact 7-Nov cutoff stock
    this.db.raw_materials = JSON.parse(JSON.stringify(MFP_CUTOFF_DATA_7NOV.raw_materials || []));
    this.db.products = JSON.parse(JSON.stringify(MFP_CUTOFF_DATA_7NOV.products || []));

    // 2. Wipe historical operational records prior to 7-Nov-2026 cutoff
    const cutoffDate = (MFP_CUTOFF_DATA_7NOV.cutoffDate || '2026-11-07');
    this.db.orders = (this.db.orders || []).filter(o => {
      const d = (o.date || o.created_at || '').slice(0, 10);
      return d && d >= cutoffDate;
    });
    this.db.inwards = (this.db.inwards || []).filter(i => {
      const d = (i.date || '').slice(0, 10);
      return d && d >= cutoffDate;
    });
    this.db.productions = (this.db.productions || []).filter(p => {
      const d = (p.date || '').slice(0, 10);
      return d && d >= cutoffDate;
    });
    this.db.outwards = (this.db.outwards || []).filter(o => {
      const d = (o.dispatch_date || o.date || '').slice(0, 10);
      return d && d >= cutoffDate;
    });
    this.db.debit_notes = (this.db.debit_notes || []).filter(d => {
      const dt = (d.date || '').slice(0, 10);
      return dt && dt >= cutoffDate;
    });

    this.saveDb();
    localStorage.setItem('erp_cutoff_version', MFP_CUTOFF_DATA_7NOV.version || '2026-11-07-v1');
  }

  load7NovCutoffData() {
    if (!confirm("Are you sure you want to reset your inventory to the 7th November 2026 Cutoff Dataset? All older operational inventory transactions will be purged.")) {
      return;
    }
    this.applyCutoff7Nov();
    this.refreshAllViews();
    alert("✓ Successfully loaded 7-Nov-2026 Cutoff Starting Stock (100 items: 78 Raw Materials/Packaging + 22 Finished Goods)!");
  }

  toggleMaterialDeficitFilter() {
    this.materialDeficitOnly = !this.materialDeficitOnly;
    const btn = document.getElementById('btn-mat-filter-deficit');
    if (btn) {
      if (this.materialDeficitOnly) {
        btn.className = 'btn btn-danger btn-sm';
      } else {
        btn.className = 'btn btn-secondary btn-sm';
      }
    }
    this.renderMaterials();
  }

  toggleFinishedGoodsDeficitFilter() {
    this.fgDeficitOnly = !this.fgDeficitOnly;
    const btn = document.getElementById('btn-fg-filter-deficit');
    if (btn) {
      if (this.fgDeficitOnly) {
        btn.className = 'btn btn-danger btn-sm';
      } else {
        btn.className = 'btn btn-secondary btn-sm';
      }
    }
    this.renderFinishedGoods();
  }

  // Render Raw Materials view table
  renderMaterials() {
    const tbody = document.getElementById('materials-table-body');
    tbody.innerHTML = '';

    const search = document.getElementById('material-search').value.toLowerCase().trim();

    // Update deficit counter badge
    const totalDeficits = this.db.raw_materials.filter(m => {
      const s = parseFloat(m.current_stock || 0);
      const b = parseFloat(m.buffer !== undefined ? m.buffer : (m.min_stock || 0));
      return s < b;
    }).length;
    const countBadge = document.getElementById('count-mat-deficit');
    if (countBadge) countBadge.textContent = totalDeficits;

    let filtered = this.db.raw_materials.filter(m => {
      return m.name.toLowerCase().includes(search) || 
             m.code.toLowerCase().includes(search) || 
             (m.description || '').toLowerCase().includes(search);
    });

    if (this.materialDeficitOnly) {
      filtered = filtered.filter(m => {
        const s = parseFloat(m.current_stock || 0);
        const b = parseFloat(m.buffer !== undefined ? m.buffer : (m.min_stock || 0));
        return s < b;
      });
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-list-text">${this.materialDeficitOnly ? 'All raw materials & packaging items are currently at or above buffer stock!' : 'No raw materials found. Define materials or load demo data.'}</td></tr>`;
      return;
    }

    filtered.forEach(item => {
      const stock = parseFloat(item.current_stock || 0);
      const buffer = parseFloat(item.buffer !== undefined ? item.buffer : (item.min_stock || 0));
      const rate = parseFloat(item.average_price || 0);
      const asset = stock * rate;
      const isBelowBuffer = stock < buffer;

      const tr = document.createElement('tr');
      if (isBelowBuffer) {
        tr.className = 'row-below-buffer';
      }

      tr.innerHTML = `
        <td class="td-bold">
          <a href="javascript:void(0)" onclick="app.openMaterialLedgerModal('${item.id}')" title="Click to view detailed stock ledger" style="color:var(--color-primary); text-decoration:underline; cursor:pointer;">
            ${item.code}
          </a>
        </td>
        <td>
          <a href="javascript:void(0)" onclick="app.openMaterialLedgerModal('${item.id}')" title="Click to view detailed stock ledger" style="color:inherit; text-decoration:none; font-weight:600; cursor:pointer;">
            ${item.name}
          </a>
        </td>
        <td class="td-muted" style="max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.description || '-'}</td>
        <td class="td-bold ${isBelowBuffer ? 'stock-below-buffer' : ''}" style="${isBelowBuffer ? '' : 'color:inherit;'}">
          ${stock.toFixed(3)}
          ${isBelowBuffer ? `<span class="badge-deficit" title="Required buffer: ${buffer.toFixed(1)}">Deficit: -${(buffer - stock).toFixed(1)}</span>` : ''}
        </td>
        <td class="td-bold" style="${isBelowBuffer ? 'color:#ef4444; font-weight:700;' : 'color:var(--text-muted);'}">
          ${buffer.toFixed(1)}
        </td>
        <td class="td-muted">${item.unit}</td>
        <td>${this.formatCurrency(rate)}</td>
        <td class="td-bold">${this.formatCurrency(asset)}</td>
        <td class="td-actions" style="text-align: right; white-space:nowrap;">
          <button class="btn btn-secondary btn-sm" onclick="app.openMaterialLedgerModal('${item.id}')" title="View Detailed Stock Ledger & Entries" style="margin-right:4px;">
            <i class="fa-solid fa-list-check"></i> Ledger
          </button>
          <button class="btn btn-secondary btn-sm" onclick="app.openEditMaterialModal('${item.id}')" title="Edit Material Config">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="btn btn-danger btn-sm" onclick="app.deleteMaterial('${item.id}')" title="Delete Material">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // ==========================================
  // RAW MATERIAL DETAILED LEDGER & EDITING
  // ==========================================

  openMaterialLedgerModal(materialId) {
    const mat = this.db.raw_materials.find(m => m.id === materialId);
    if (!mat) {
      alert("Selected raw material could not be found.");
      return;
    }
    this.renderMaterialLedger(materialId);
    this.openModal('modal-material-ledger');
  }

  renderMaterialLedger(materialId) {
    const mat = this.db.raw_materials.find(m => m.id === materialId);
    if (!mat) return;

    // Ensure an initial opening balance transaction exists if stock > 0 and no tx found
    const hasTx = (this.db.transactions || []).some(t => 
      (t.raw_material_changes || []).some(c => c.material_id === materialId)
    );
    if (!hasTx && parseFloat(mat.current_stock || 0) > 0) {
      this.db.transactions.unshift({
        id: 'tx_opening_' + mat.id,
        type: 'purchase',
        date: new Date().toISOString().split('T')[0],
        invoice_no: 'OPENING-BAL',
        description: `Initial opening balance for ${mat.name}`,
        items: [{ 
          name: mat.name, 
          qty: parseFloat(mat.current_stock), 
          rate: parseFloat(mat.average_price || 0), 
          total: parseFloat(mat.current_stock) * parseFloat(mat.average_price || 0) 
        }],
        raw_material_changes: [{
          material_id: mat.id,
          material_name: mat.name,
          qty_change: parseFloat(mat.current_stock),
          direction: 'in',
          wastage_qty: 0
        }]
      });
      this.saveDb();
    }

    // Sync any cloud inwards into transactions if missing
    (this.db.inwards || []).forEach(inw => {
      const isThisMat = inw.material_id === materialId || 
        (Array.isArray(inw.items) && inw.items.some(it => it.material_id === materialId));
      if (isThisMat) {
        const alreadyInTx = (this.db.transactions || []).some(t => t.id === inw.id || (t.invoice_no && t.invoice_no === inw.invoice_no && t.date === inw.date));
        if (!alreadyInTx) {
          const qty = parseFloat(inw.quantity_received || inw.quantity || 0);
          const rate = parseFloat(inw.rate_per_unit || inw.rate || 0);
          this.db.transactions.push({
            id: inw.id || 'tx_' + Date.now(),
            type: 'purchase',
            date: inw.date || (inw.created_at ? inw.created_at.split('T')[0] : new Date().toISOString().split('T')[0]),
            invoice_no: inw.invoice_no || inw.bill_no || 'INW-CLOUD',
            description: `Inward from ${inw.supplier || inw.supplier_name || 'Supplier'}`,
            items: [{ name: mat.name, qty, rate, total: qty * rate }],
            raw_material_changes: [{
              material_id: mat.id,
              material_name: mat.name,
              qty_change: qty,
              direction: 'in',
              wastage_qty: 0
            }]
          });
          this.saveDb();
        }
      }
    });

    // Sync any debit notes affecting this raw material into transactions if missing
    (this.db.debit_notes || []).forEach(dn => {
      if (Array.isArray(dn.items)) {
        dn.items.forEach(it => {
          if (it.material_id === materialId) {
            const alreadyInTx = (this.db.transactions || []).some(t => t.id === 'tx_dn_' + dn.id || (t.invoice_no && t.invoice_no === dn.debit_note_no));
            if (!alreadyInTx) {
              const qty = parseFloat(it.quantity || 0);
              const rate = parseFloat(it.rate || 0);
              this.db.transactions.push({
                id: 'tx_dn_' + dn.id,
                type: 'debit_note',
                date: dn.date || new Date().toISOString().split('T')[0],
                invoice_no: dn.debit_note_no || 'DN-OUT',
                description: `Debit Note to ${dn.vendor_name || 'Vendor'} (Defective: ${dn.reason || 'Rejected'})`,
                items: [{ name: it.material_name, qty, rate, total: qty * rate }],
                raw_material_changes: [{
                  material_id: materialId,
                  material_name: it.material_name,
                  qty_change: qty,
                  direction: 'out',
                  wastage_qty: 0
                }]
              });
              this.saveDb();
            }
          }
        });
      }
    });

    // Collect all transactions affecting this raw material
    const relevantTxs = (this.db.transactions || []).filter(t => 
      (t.raw_material_changes || []).some(c => c.material_id === materialId)
    );

    // Sort chronologically ascending to calculate running balances
    relevantTxs.sort((a, b) => (new Date(a.date).getTime() || 0) - (new Date(b.date).getTime() || 0));

    let runningBal = 0;
    let totalInward = 0;
    let totalConsumed = 0;
    const computedRows = [];

    relevantTxs.forEach(tx => {
      const chg = (tx.raw_material_changes || []).find(c => c.material_id === materialId);
      if (!chg) return;

      const isIn = chg.direction === 'in' || chg.qty_change > 0;
      const isOut = chg.direction === 'out' || chg.qty_change < 0;
      const absQty = Math.abs(chg.qty_change);

      let inQty = 0;
      let outQty = 0;
      let entryRate = 0;

      if (isIn) {
        inQty = absQty;
        runningBal += inQty;
        totalInward += inQty;

        const itm = (tx.items || []).find(i => i.material_id === materialId || i.name === chg.material_name || i.name === mat.name);
        entryRate = itm && itm.rate ? parseFloat(itm.rate) : (tx.rate ? parseFloat(tx.rate) : parseFloat(mat.average_price || 0));
      } else if (isOut) {
        outQty = absQty;
        runningBal = Math.max(0, runningBal - outQty);
        totalConsumed += outQty;
      }

      let typeBadge = '<span class="badge badge-warning">Adjustment</span>';
      if (tx.invoice_no === 'OPENING' || tx.invoice_no === 'OPENING-BAL' || (tx.description || '').toLowerCase().includes('opening')) {
        typeBadge = '<span class="badge badge-primary">Opening Stock</span>';
      } else if (isIn) {
        typeBadge = '<span class="badge badge-success">Inward Purchase</span>';
      } else if (tx.type === 'production' || isOut) {
        typeBadge = '<span class="badge badge-info">Production Run</span>';
      }

      computedRows.push({
        txId: tx.id,
        date: tx.date || 'N/A',
        typeBadge,
        ref: tx.invoice_no || tx.id,
        description: tx.description || '-',
        inQty,
        outQty,
        entryRate,
        runningBal,
        isIn
      });
    });

    // Update KPI strip
    const titleEl = document.getElementById('ledger-material-title');
    const subEl = document.getElementById('ledger-material-subtitle');
    const stockEl = document.getElementById('ledger-kpi-stock');
    const rateEl = document.getElementById('ledger-kpi-rate');
    const inEl = document.getElementById('ledger-kpi-inward');
    const outEl = document.getElementById('ledger-kpi-consumed');

    if (titleEl) titleEl.innerHTML = `<i class="fa-solid fa-boxes-stacked" style="color:var(--color-primary);"></i> ${mat.code} — ${mat.name}`;
    if (subEl) subEl.textContent = `Unit: ${mat.unit} • Current Moving Avg Rate: ${this.formatCurrency(mat.average_price)} • Reorder Level: ${mat.min_stock || 5} ${mat.unit}`;
    if (stockEl) stockEl.textContent = `${runningBal.toFixed(3)} ${mat.unit}`;
    if (rateEl) rateEl.textContent = this.formatCurrency(mat.average_price);
    if (inEl) inEl.textContent = `+${totalInward.toFixed(3)} ${mat.unit}`;
    if (outEl) outEl.textContent = `-${totalConsumed.toFixed(3)} ${mat.unit}`;

    // Update current_stock if it was out of sync
    if (Math.abs(runningBal - parseFloat(mat.current_stock || 0)) > 0.0001) {
      mat.current_stock = runningBal;
      this.saveDb();
    }

    // Populate Table Body (render newest first for user convenience)
    const tbody = document.getElementById('material-ledger-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (computedRows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-list-text" style="padding:2rem; text-align:center;">No ledger transactions recorded for this material.</td></tr>`;
      return;
    }

    // Display newest first
    const displayRows = [...computedRows].reverse();
    displayRows.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="white-space:nowrap;">${row.date}</td>
        <td>${row.typeBadge}</td>
        <td class="td-bold" style="white-space:nowrap;">${row.ref}</td>
        <td style="max-width:240px; font-size:0.8rem;" class="td-muted">${row.description}</td>
        <td style="text-align:right; font-weight:600; color:${row.inQty > 0 ? 'var(--color-success)' : 'inherit'};">
          ${row.inQty > 0 ? '+' + row.inQty.toFixed(3) : '-'}
        </td>
        <td style="text-align:right; font-weight:600; color:${row.outQty > 0 ? 'var(--color-danger)' : 'inherit'};">
          ${row.outQty > 0 ? '-' + row.outQty.toFixed(3) : '-'}
        </td>
        <td style="text-align:right;">
          ${row.entryRate > 0 ? this.formatCurrency(row.entryRate) : '-'}
        </td>
        <td class="td-bold" style="text-align:right; color:var(--color-primary);">
          ${row.runningBal.toFixed(3)}
        </td>
        <td style="text-align:center; white-space:nowrap;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="app.openEditLedgerEntryModal('${row.txId}', '${mat.id}')" title="Edit entry" style="padding:0.2rem 0.45rem; font-size:0.75rem; margin-right:3px;">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button type="button" class="btn btn-danger btn-sm" onclick="app.deleteLedgerEntry('${row.txId}', '${mat.id}')" title="Delete entry" style="padding:0.2rem 0.45rem; font-size:0.75rem;">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Open modal to edit individual ledger entry
  openEditLedgerEntryModal(txId, materialId) {
    const mat = this.db.raw_materials.find(m => m.id === materialId);
    const tx = (this.db.transactions || []).find(t => t.id === txId);
    if (!mat || !tx) {
      alert("Transaction or Raw Material record not found.");
      return;
    }

    const chg = (tx.raw_material_changes || []).find(c => c.material_id === materialId);
    if (!chg) {
      alert("Material adjustment record not found in this transaction.");
      return;
    }

    const direction = chg.direction || (chg.qty_change >= 0 ? 'in' : 'out');
    const absQty = Math.abs(chg.qty_change);

    document.getElementById('edit-entry-tx-id').value = tx.id;
    document.getElementById('edit-entry-mat-id').value = materialId;
    document.getElementById('edit-entry-direction').value = direction;
    document.getElementById('edit-entry-date').value = tx.date || '';
    document.getElementById('edit-entry-ref').value = tx.invoice_no || '';
    document.getElementById('edit-entry-desc').value = tx.description || '';
    document.getElementById('edit-entry-unit').textContent = mat.unit || 'kg';
    document.getElementById('edit-entry-qty').value = absQty;

    const rateGroup = document.getElementById('edit-entry-rate-group');
    const rateInput = document.getElementById('edit-entry-rate');

    if (direction === 'in') {
      rateGroup.style.display = 'block';
      const itm = (tx.items || []).find(i => i.material_id === materialId || i.name === chg.material_name || i.name === mat.name);
      rateInput.value = itm && itm.rate ? parseFloat(itm.rate) : (tx.rate || mat.average_price || 0);
    } else {
      rateGroup.style.display = 'none';
      rateInput.value = '0';
    }

    this.openModal('modal-edit-ledger-entry');
  }

  // Save changes to individual ledger entry and recalculate stock & moving average rate
  async saveEditedLedgerEntry(e) {
    e.preventDefault();

    const txId = document.getElementById('edit-entry-tx-id').value;
    const matId = document.getElementById('edit-entry-mat-id').value;
    const direction = document.getElementById('edit-entry-direction').value;
    const newDate = document.getElementById('edit-entry-date').value;
    const newRef = document.getElementById('edit-entry-ref').value.trim();
    const newDesc = document.getElementById('edit-entry-desc').value.trim();
    const newQty = parseFloat(document.getElementById('edit-entry-qty').value) || 0;
    const newRate = parseFloat(document.getElementById('edit-entry-rate').value) || 0;

    if (newQty <= 0) {
      alert("Quantity must be greater than zero.");
      return;
    }

    const tx = (this.db.transactions || []).find(t => t.id === txId);
    const mat = this.db.raw_materials.find(m => m.id === matId);
    if (!tx || !mat) {
      alert("Transaction or material not found.");
      return;
    }

    const chg = (tx.raw_material_changes || []).find(c => c.material_id === matId);
    if (!chg) {
      alert("Material record not found in transaction.");
      return;
    }

    // Update transaction attributes
    tx.date = newDate;
    tx.invoice_no = newRef;
    tx.description = newDesc;

    if (direction === 'in') {
      chg.qty_change = newQty;
      chg.direction = 'in';

      if (!tx.items) tx.items = [];
      let itm = tx.items.find(i => i.material_id === matId || i.name === chg.material_name || i.name === mat.name);
      if (itm) {
        itm.qty = newQty;
        itm.rate = newRate;
        itm.total = newQty * newRate;
      } else {
        tx.items.push({
          material_id: matId,
          name: mat.name,
          qty: newQty,
          rate: newRate,
          total: newQty * newRate
        });
      }

      // If this corresponds to an inward receipt in this.db.inwards, update that too
      const inw = (this.db.inwards || []).find(i => i.id === txId || (i.invoice_no === tx.invoice_no && i.date === tx.date));
      if (inw) {
        inw.date = newDate;
        inw.invoice_no = newRef;
        inw.quantity_received = newQty;
        inw.rate_per_unit = newRate;
        if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
          try {
            await this.supabase.from('inwards').update({
              date: newDate,
              invoice_no: newRef,
              quantity_received: newQty,
              rate_per_unit: newRate
            }).eq('id', inw.id);
          } catch (err) {
            console.error("Error updating inward in Supabase:", err);
          }
        }
      }
    } else {
      chg.qty_change = -newQty;
      chg.direction = 'out';
    }

    // Recalculate stock and moving weighted average rate for this material
    await this.recalculateMaterialStock(matId);

    this.closeModal('modal-edit-ledger-entry');
    this.renderMaterialLedger(matId);
    this.refreshAllViews();
    alert(`Success! Ledger entry updated for ${mat.name}. Stock balance and average rates recalculated.`);
  }

  // Delete an individual ledger entry and recalculate stock
  async deleteLedgerEntry(txId, materialId) {
    const mat = this.db.raw_materials.find(m => m.id === materialId);
    const matName = mat ? mat.name : 'material';

    if (!confirm(`Are you sure you want to delete this ledger entry for ${matName}? Running balance and moving average rate will be automatically recalculated.`)) {
      return;
    }

    const tx = (this.db.transactions || []).find(t => t.id === txId);
    if (!tx) return;

    if (tx.raw_material_changes && tx.raw_material_changes.length > 1) {
      tx.raw_material_changes = tx.raw_material_changes.filter(c => c.material_id !== materialId);
    } else {
      this.db.transactions = this.db.transactions.filter(t => t.id !== txId);
    }

    // Also remove from inwards if present
    this.db.inwards = (this.db.inwards || []).filter(i => i.id !== txId);
    if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
      try {
        await this.supabase.from('inwards').delete().eq('id', txId);
      } catch (err) {
        console.error("Error deleting inward from Supabase:", err);
      }
    }

    await this.recalculateMaterialStock(materialId);
    this.renderMaterialLedger(materialId);
    this.refreshAllViews();
    alert(`Ledger entry removed. Stock balance for ${matName} has been recalculated.`);
  }

  // Engine: Chronologically replay all transactions for a material to recalculate current_stock and moving weighted average price
  async recalculateMaterialStock(materialId) {
    const mat = this.db.raw_materials.find(m => m.id === materialId);
    if (!mat) return;

    const relevantTxs = (this.db.transactions || []).filter(t => 
      (t.raw_material_changes || []).some(c => c.material_id === materialId)
    );

    // Sort ascending by date
    relevantTxs.sort((a, b) => (new Date(a.date).getTime() || 0) - (new Date(b.date).getTime() || 0));

    let runningStock = 0;
    let movingAvgPrice = 0;
    let totalInwardVal = 0;
    let totalInwardQty = 0;

    relevantTxs.forEach(tx => {
      const chg = (tx.raw_material_changes || []).find(c => c.material_id === materialId);
      if (!chg) return;

      const isIn = chg.direction === 'in' || chg.qty_change > 0;
      const isOut = chg.direction === 'out' || chg.qty_change < 0;
      const absQty = Math.abs(chg.qty_change);

      if (isIn) {
        const inQty = absQty;
        const itm = (tx.items || []).find(i => i.material_id === materialId || i.name === chg.material_name || i.name === mat.name);
        const rate = itm && itm.rate ? parseFloat(itm.rate) : (tx.rate ? parseFloat(tx.rate) : parseFloat(mat.average_price || 0));

        if (runningStock + inQty > 0) {
          movingAvgPrice = ((runningStock * movingAvgPrice) + (inQty * rate)) / (runningStock + inQty);
        }
        runningStock += inQty;
        totalInwardVal += inQty * rate;
        totalInwardQty += inQty;
      } else if (isOut) {
        const outQty = absQty;
        runningStock = Math.max(0, runningStock - outQty);
      }
    });

    mat.current_stock = runningStock;
    if (movingAvgPrice > 0) {
      mat.average_price = movingAvgPrice;
    } else if (totalInwardQty > 0) {
      mat.average_price = totalInwardVal / totalInwardQty;
    }

    this.saveDb();

    // Sync updated stock & rate to Supabase
    if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
      try {
        await this.supabase.from('raw_materials').upsert([{
          id: mat.id,
          code: mat.code,
          name: mat.name,
          current_stock: mat.current_stock,
          unit: mat.unit,
          average_price: mat.average_price,
          min_stock: mat.min_stock || 5,
          description: mat.description || ''
        }]);
      } catch (err) {
        console.error("Error updating raw material in Supabase:", err);
      }
    }
  }

  // Delete purchase orders created by mistake (Desktop System)
  async deleteOrder(orderId) {
    const orders = this.db.orders || [];
    const ord = orders.find(o => o.id === orderId);
    const label = ord ? (ord.material_name || (ord.items && ord.items[0] ? ord.items[0].material_name : 'order')) : 'this order';

    if (!confirm(`Delete purchase order for "${label}" created by mistake? This action cannot be undone.`)) {
      return;
    }

    try {
      if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
        const { error } = await this.supabase.from('orders').delete().eq('id', orderId);
        if (error) console.error("Error deleting order from Supabase:", error);
      }

      this.db.orders = (this.db.orders || []).filter(o => o.id !== orderId);
      this.saveDb();
      this.renderDashboardActivities();
      this.renderHistory();
      alert("Order deleted successfully.");
    } catch (err) {
      console.error("Failed to delete order:", err);
      alert("Failed to delete order: " + err.message);
    }
  }

  // Set filter for activity history logs
  setHistoryFilter(filter) {
    this.historyFilter = filter || 'all';

    const filterTypes = ['all', 'order', 'inward', 'production', 'dispatch', 'debit_note'];
    filterTypes.forEach(f => {
      const btnId = f === 'debit_note' ? 'hist-filter-debit' : `hist-filter-${f}`;
      const btn = document.getElementById(btnId);
      if (btn) {
        if (f === this.historyFilter) {
          btn.className = 'btn btn-primary btn-sm';
          btn.style.fontWeight = '700';
        } else {
          btn.className = 'btn btn-secondary btn-sm';
          btn.style.fontWeight = '400';
        }
      }
    });

    this.renderHistory();
  }

  openAddMaterialModal() {
    document.getElementById('material-modal-title').textContent = "Configure Raw Material";
    document.getElementById('material-form-id').value = '';
    document.getElementById('material-form').reset();
    document.getElementById('material-stock').disabled = false;
    document.getElementById('material-rate').disabled = false;
    this.openModal('material-modal');
  }

  openEditMaterialModal(id) {
    const item = this.db.raw_materials.find(m => m.id === id);
    if (!item) return;

    document.getElementById('material-modal-title').textContent = "Modify Raw Material Config";
    document.getElementById('material-form-id').value = item.id;
    document.getElementById('material-code').value = item.code;
    document.getElementById('material-name').value = item.name;
    document.getElementById('material-stock').value = item.current_stock;
    document.getElementById('material-unit').value = item.unit;
    document.getElementById('material-rate').value = item.average_price;
    document.getElementById('material-min-stock').value = item.min_stock || 5;
    document.getElementById('material-desc').value = item.description || '';

    // Disable stock adjustments directly to enforce ledger tracking rules
    document.getElementById('material-stock').disabled = true;
    document.getElementById('material-rate').disabled = true;

    this.openModal('material-modal');
  }

  saveMaterial() {
    const id = document.getElementById('material-form-id').value;
    const code = document.getElementById('material-code').value.toUpperCase().trim();
    const name = document.getElementById('material-name').value.trim();
    const stock = parseFloat(document.getElementById('material-stock').value) || 0;
    const unit = document.getElementById('material-unit').value;
    const rate = parseFloat(document.getElementById('material-rate').value) || 0;
    const minStock = parseFloat(document.getElementById('material-min-stock').value) || 0;
    const desc = document.getElementById('material-desc').value.trim();

    if (!code || !name) {
      alert("Material Code and Name are required.");
      return;
    }

    if (id) {
      // Edit
      const index = this.db.raw_materials.findIndex(m => m.id === id);
      if (index !== -1) {
        this.db.raw_materials[index].code = code;
        this.db.raw_materials[index].name = name;
        this.db.raw_materials[index].unit = unit;
        this.db.raw_materials[index].min_stock = minStock;
        this.db.raw_materials[index].description = desc;
      }
    } else {
      // Create
      if (this.db.raw_materials.some(m => m.code === code)) {
        alert("A raw material with this code already exists.");
        return;
      }

      const newMat = {
        id: 'rm_' + Date.now(),
        code,
        name,
        current_stock: stock,
        unit,
        average_price: rate,
        min_stock: minStock,
        description: desc
      };
      
      this.db.raw_materials.push(newMat);

      // Save a ledger transaction if opening stock > 0
      if (stock > 0) {
        this.db.transactions.push({
          id: 'tx_' + Date.now(),
          type: 'purchase',
          date: new Date().toISOString().split('T')[0],
          invoice_no: 'OPENING',
          description: `Opening stock allocation for ${name}`,
          items: [{ name: name, qty: stock, rate: rate, total: stock * rate }],
          raw_material_changes: [{
            material_id: newMat.id,
            material_name: name,
            qty_change: stock,
            direction: 'in',
            wastage_qty: 0
          }]
        });
      }
    }

    this.saveDb();

    // Auto-sync to Supabase Cloud if connected
    if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
      const matToSync = id ? this.db.raw_materials.find(m => m.id === id) : this.db.raw_materials[this.db.raw_materials.length - 1];
      if (matToSync) {
        this.supabase.from('raw_materials').upsert([{
          id: matToSync.id,
          code: matToSync.code,
          name: matToSync.name,
          current_stock: parseFloat(matToSync.current_stock) || 0,
          unit: matToSync.unit || 'kg',
          average_price: parseFloat(matToSync.average_price) || 0,
          min_stock: parseFloat(matToSync.min_stock) || 5.0,
          description: matToSync.description || ''
        }]).then(({ error }) => {
          if (error) console.error("Error auto-syncing raw material to Supabase:", error);
          else console.log("Auto-synced raw material to Supabase:", matToSync.name);
        }).catch(err => console.error("Auto-sync error:", err));
      }
    }

    this.closeModal('material-modal');
    this.refreshAllViews();
  }

  deleteMaterial(id) {
    if (!confirm("Are you sure you want to delete this raw material? Linkages in BOMs will break.")) return;
    this.db.raw_materials = this.db.raw_materials.filter(m => m.id !== id);
    this.saveDb();

    // Auto-delete from Supabase Cloud if connected
    if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
      this.supabase.from('raw_materials').delete().eq('id', id).then(({ error }) => {
        if (error) console.error("Error deleting material from Supabase:", error);
      }).catch(err => console.error("Delete sync error:", err));
    }

    this.refreshAllViews();
  }

  // Render Finished Goods view table
  renderFinishedGoods() {
    const tbody = document.getElementById('finished-goods-table-body');
    tbody.innerHTML = '';

    const search = document.getElementById('fg-search').value.toLowerCase().trim();

    // Update deficit counter badge
    const totalDeficits = this.db.products.filter(p => {
      const s = parseFloat(p.current_stock || 0);
      const b = parseFloat(p.buffer !== undefined ? p.buffer : (p.min_stock || 0));
      return s < b;
    }).length;
    const countBadge = document.getElementById('count-fg-deficit');
    if (countBadge) countBadge.textContent = totalDeficits;

    let filtered = this.db.products.filter(p => {
      return p.name.toLowerCase().includes(search) || 
             p.code.toLowerCase().includes(search) || 
             (p.description || '').toLowerCase().includes(search);
    });

    if (this.fgDeficitOnly) {
      filtered = filtered.filter(p => {
        const s = parseFloat(p.current_stock || 0);
        const b = parseFloat(p.buffer !== undefined ? p.buffer : (p.min_stock || 0));
        return s < b;
      });
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-list-text">${this.fgDeficitOnly ? 'All finished goods are currently at or above buffer stock!' : 'No products in Finished Goods warehouse. Configure products under \'Products & BOM\' first.'}</td></tr>`;
      return;
    }

    filtered.forEach(p => {
      const stock = parseFloat(p.current_stock || 0);
      const buffer = parseFloat(p.buffer !== undefined ? p.buffer : (p.min_stock || 0));
      const mrp = parseFloat(p.price || 0);
      const sellingPrice = parseFloat(p.selling_price || mrp);
      const asset = stock * sellingPrice;
      const isBelowBuffer = stock < buffer;

      let status = `<span class="badge badge-success">Sufficient</span>`;
      if (isBelowBuffer) {
        status = `<span class="badge badge-danger" style="font-weight:750;">⚠️ Below Buffer</span>`;
      } else if (stock <= buffer * 1.25) {
        status = `<span class="badge badge-warning">Near Buffer</span>`;
      }

      const tr = document.createElement('tr');
      if (isBelowBuffer) {
        tr.className = 'row-below-buffer';
      }

      tr.innerHTML = `
        <td class="td-bold">${p.code}</td>
        <td><strong>${p.name}</strong></td>
        <td><span class="badge badge-primary">${p.packaging_type || 'General'}</span></td>
        <td class="td-muted" style="max-width: 180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.description || '-'}</td>
        <td class="td-bold ${isBelowBuffer ? 'stock-below-buffer' : ''}" style="${isBelowBuffer ? '' : 'color:inherit;'}">
          ${stock.toFixed(0)} pcs
          ${isBelowBuffer ? `<span class="badge-deficit" title="Required buffer: ${buffer.toFixed(0)} pcs">Deficit: -${(buffer - stock).toFixed(0)}</span>` : ''}
        </td>
        <td class="td-bold" style="${isBelowBuffer ? 'color:#ef4444; font-weight:700;' : 'color:var(--text-muted);'}">
          ${buffer.toFixed(0)} pcs
        </td>
        <td>${this.formatCurrency(mrp)}</td>
        <td class="td-bold text-success">${this.formatCurrency(sellingPrice)}</td>
        <td class="td-bold">${this.formatCurrency(asset)}</td>
        <td>${status}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // Render Products list cards
  renderProducts() {
    const grid = document.getElementById('products-grid-container');
    if (!grid) return;

    grid.innerHTML = '';

    if (this.db.products.length === 0) {
      grid.innerHTML = `
        <div class="empty-list-text" style="grid-column: 1 / -1; padding: 4rem;">
          <i class="fa-solid fa-compass-drafting" style="font-size: 2.5rem; color: var(--text-dim); margin-bottom: 1rem; display:block;"></i>
          No products defined yet. Add a finished product and build its BOM recipe to start!
        </div>
      `;
      return;
    }

    this.db.products.forEach(p => {
      let bomCost = 0;
      let hasMissingRate = false;

      const bomSummary = p.bom.map(item => {
        const mat = this.db.raw_materials.find(m => m.id === item.material_id);
        const name = mat ? mat.name : 'Unknown';
        const unit = mat ? mat.unit : 'pcs';
        const rate = mat ? parseFloat(mat.average_price || 0) : 0;
        
        const wasteFactor = 1 + (parseFloat(item.wastage_percentage) / 100);
        const totalQty = parseFloat(item.quantity) * wasteFactor;
        bomCost += totalQty * rate;

        if (rate === 0) hasMissingRate = true;

        return `
          <div class="product-bom-item-row">
            <span>• ${name} (${item.quantity} ${unit})</span>
            <span class="td-muted">+${item.wastage_percentage}% wastage</span>
          </div>
        `;
      }).join('');

      const card = document.createElement('div');
      card.className = 'product-card';
      card.innerHTML = `
        <div class="product-card-header">
          <div class="product-card-title">
            <h3>${p.name}</h3>
            <div class="product-card-code">${p.code}</div>
          </div>
          <span class="badge badge-primary">${p.packaging_type || 'General'}</span>
        </div>
        <div class="product-card-body" style="display:flex; flex-direction:column; flex-grow:1;">
          <p class="product-description">${p.description || 'No description.'}</p>
          <div class="product-bom-summary" style="flex-grow:1;">
            <div class="product-bom-summary-title">Ingredients Recipe (BOM)</div>
            ${bomSummary || '<div class="td-muted">No materials linked.</div>'}
          </div>
          <div style="margin-top: 0.75rem; font-size: 0.85rem; color: var(--text-muted); display:flex; justify-content:space-between;">
            <span>Estimated BOM Cost:</span>
            <strong style="color: var(--text-main);">${this.formatCurrency(bomCost)}${hasMissingRate ? ' *' : ''}</strong>
          </div>
        </div>
        <div class="product-card-footer" style="margin-top: 1rem; border-top: 1px solid var(--border-light); padding-top: 0.75rem; width:100%;">
          <div style="font-size:0.8rem; color:var(--text-muted); display:flex; justify-content:space-between; width:100%; margin-bottom:0.25rem;">
            <span>MRP Retail:</span>
            <span style="text-decoration: line-through;">${this.formatCurrency(p.price)}</span>
          </div>
          <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
            <div style="font-size:1.15rem; font-weight:700; color:var(--color-primary);">${this.formatCurrency(p.selling_price || p.price)}</div>
            <div class="td-actions">
              <button class="btn btn-secondary btn-sm" onclick="app.openEditProductModal('${p.id}')">
                <i class="fa-solid fa-pen"></i>
              </button>
              <button class="btn btn-danger btn-sm" onclick="app.deleteProduct('${p.id}')">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  }

  // BOM configuration dynamic row additions
  populateBOMMaterialDropdown() {
    const select = document.getElementById('bom-add-material');
    if (!select) return;

    select.innerHTML = '<option value="" disabled selected>-- Select Ingredient Material --</option>';
    this.db.raw_materials.forEach(m => {
      select.innerHTML += `<option value="${m.id}">${m.name} (${m.code}) [${m.unit}]</option>`;
    });
  }

  openAddProductModal() {
    document.getElementById('product-modal-title').textContent = "Configure Product & BOM";
    document.getElementById('product-form-id').value = '';
    document.getElementById('product-form').reset();
    this.bomTempList = [];
    this.renderBOMBuilderList();
    this.populateBOMMaterialDropdown();
    this.openModal('product-modal');
  }

  openEditProductModal(id) {
    const prod = this.db.products.find(p => p.id === id);
    if (!prod) return;

    document.getElementById('product-modal-title').textContent = "Modify Product BOM";
    document.getElementById('product-form-id').value = prod.id;
    document.getElementById('product-code').value = prod.code;
    document.getElementById('product-name').value = prod.name;
    document.getElementById('product-price').value = prod.price || 0;
    document.getElementById('product-selling-price').value = prod.selling_price || prod.price;
    document.getElementById('product-desc').value = prod.description || '';

    this.bomTempList = JSON.parse(JSON.stringify(prod.bom || [])); // clone recipe
    this.renderBOMBuilderList();
    this.populateBOMMaterialDropdown();
    this.openModal('product-modal');
  }

  addBOMRowItem() {
    const matSelect = document.getElementById('bom-add-material');
    const qtyInput = document.getElementById('bom-add-qty');
    const wasteInput = document.getElementById('bom-add-wastage');

    const material_id = matSelect.value;
    const quantity = parseFloat(qtyInput.value) || 0;
    const wastage_percentage = parseFloat(wasteInput.value) || 0;

    if (!material_id || quantity <= 0) {
      alert("Please select a raw material and input quantity.");
      return;
    }

    // Check duplicate
    if (this.bomTempList.some(item => item.material_id === material_id)) {
      alert("This ingredient is already in the recipe. Modify or delete the existing line.");
      return;
    }

    this.bomTempList.push({ material_id, quantity, wastage_percentage });
    qtyInput.value = '';
    
    this.renderBOMBuilderList();
  }

  removeBOMRowItem(index) {
    this.bomTempList.splice(index, 1);
    this.renderBOMBuilderList();
  }

  renderBOMBuilderList() {
    const list = document.getElementById('bom-builder-items-list');
    list.innerHTML = '';

    if (this.bomTempList.length === 0) {
      list.innerHTML = `<div class="empty-list-text" style="padding:1.5rem;">No ingredients linked. Select ingredients above.</div>`;
      return;
    }

    this.bomTempList.forEach((item, index) => {
      const mat = this.db.raw_materials.find(m => m.id === item.material_id);
      const name = mat ? mat.name : 'Unknown';
      const unit = mat ? mat.unit : 'pcs';

      const div = document.createElement('div');
      div.className = 'bom-builder-item';
      div.innerHTML = `
        <div><strong>${name}</strong>: ${item.quantity} ${unit} (+${item.wastage_percentage}% waste multiplier)</div>
        <button type="button" class="btn btn-danger btn-sm" onclick="app.removeBOMRowItem(${index})">
          <i class="fa-solid fa-xmark"></i>
        </button>
      `;
      list.appendChild(div);
    });
  }

  saveProduct() {
    const id = document.getElementById('product-form-id').value;
    const code = document.getElementById('product-code').value.toUpperCase().trim();
    const name = document.getElementById('product-name').value.trim();
    const price = parseFloat(document.getElementById('product-price').value) || 0;
    const sellingPrice = parseFloat(document.getElementById('product-selling-price').value) || price;
    const desc = document.getElementById('product-desc').value.trim();

    if (!code || !name || this.bomTempList.length === 0) {
      alert("Product Code, Name, and BOM Recipe ingredients are required.");
      return;
    }

    // Guess packaging type based on name
    let packagingType = 'Bottles';
    const cleanName = name.toLowerCase();
    if (cleanName.includes('pouch') || cleanName.includes('bag')) {
      packagingType = 'Pouches';
    } else if (cleanName.includes('box') || cleanName.includes('carton')) {
      packagingType = 'Boxes';
    } else if (cleanName.includes('sachet')) {
      packagingType = 'Sachets';
    }

    if (id) {
      // Edit
      const index = this.db.products.findIndex(p => p.id === id);
      if (index !== -1) {
        this.db.products[index].code = code;
        this.db.products[index].name = name;
        this.db.products[index].price = price;
        this.db.products[index].selling_price = sellingPrice;
        this.db.products[index].description = desc;
        this.db.products[index].bom = this.bomTempList;
      }
    } else {
      // Create
      if (this.db.products.some(p => p.code === code)) {
        alert("A product with this code already exists.");
        return;
      }

      this.db.products.push({
        id: 'prod_' + Date.now(),
        code,
        name,
        price,
        selling_price: sellingPrice,
        current_stock: 0, // start 0, increase through daily production runs
        min_stock: 20,
        packaging_type: packagingType,
        description: desc,
        bom: this.bomTempList
      });
    }

    this.saveDb();

    // Auto-sync product to Supabase Cloud if connected
    if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
      const prodToSync = id ? this.db.products.find(p => p.id === id) : this.db.products[this.db.products.length - 1];
      if (prodToSync) {
        this.supabase.from('products').upsert([{
          id: prodToSync.id,
          code: prodToSync.code,
          name: prodToSync.name,
          price: parseFloat(prodToSync.price) || 0,
          selling_price: parseFloat(prodToSync.selling_price) || parseFloat(prodToSync.price) || 0,
          current_stock: parseFloat(prodToSync.current_stock) || 0,
          min_stock: parseFloat(prodToSync.min_stock) || 20.0,
          packaging_type: prodToSync.packaging_type || 'Bottles',
          description: prodToSync.description || '',
          bom: prodToSync.bom || []
        }]).then(({ error }) => {
          if (error) console.error("Error auto-syncing product to Supabase:", error);
          else console.log("Auto-synced product to Supabase:", prodToSync.name);
        }).catch(err => console.error("Auto-sync error:", err));
      }
    }

    this.closeModal('product-modal');
    this.refreshAllViews();
  }

  deleteProduct(id) {
    if (!confirm("Are you sure you want to delete this product catalog?")) return;
    this.db.products = this.db.products.filter(p => p.id !== id);
    this.saveDb();

    // Auto-delete product from Supabase Cloud if connected
    if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
      this.supabase.from('products').delete().eq('id', id).then(({ error }) => {
        if (error) console.error("Error deleting product from Supabase:", error);
      }).catch(err => console.error("Delete sync error:", err));
    }

    this.refreshAllViews();
  }


  /* ==========================================================================
     INVENTORY UPLOADS: PDF PURCHASE / SALE EXTRACTORS (FROM ERP)
     ========================================================================== */

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

  async handlePurchaseUpload(file) {
    if (!file || file.type !== 'application/pdf') {
      alert("Please upload a PDF purchase invoice.");
      return;
    }

    try {
      const rawText = await this.parsePDFText(file);
      const extracted = this.heuristicsExtractPurchase(rawText);

      this.currentVerifyPurchaseItems = extracted.items;
      
      document.getElementById('verify-purchase-invoice').value = extracted.invoice_no;
      document.getElementById('verify-purchase-date').value = extracted.date;

      this.renderVerifyPurchaseTable();
      this.openModal('purchase-verify-modal');
    } catch (e) {
      console.error(e);
      alert("Error parsing PDF invoice: " + e.message);
    }
  }

  // Parse purchase text heuristics
  heuristicsExtractPurchase(text) {
    const result = {
      invoice_no: 'PUR-' + Math.floor(1000 + Math.random() * 9000),
      date: new Date().toISOString().split('T')[0],
      items: []
    };

    // Date & invoice regexes
    const dateMatch = text.match(/(?:date|dated)\s*[:\-]?\s*(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/i) ||
                      text.match(/(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/);
    if (dateMatch) {
      result.date = new Date(Date.parse(dateMatch[1])).toISOString().split('T')[0];
    }

    const invMatch = text.match(/(?:invoice|inv|bill)\s*(?:no|number)?\s*[:\-#]?\s*([A-Za-z0-9\-]+)/i);
    if (invMatch) result.invoice_no = invMatch[1];

    // Simple line matcher split
    const lines = text.split('\n');
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || /total|tax|subtotal|gst/i.test(trimmed)) return;

      const numMatches = trimmed.match(/\b\d+(?:\.\d+)?\b/g);
      if (numMatches && numMatches.length >= 3) {
        const numbers = numMatches.map(parseFloat);
        let qty = 0;
        let rate = 0;
        let matched = false;

        for (let i = 0; i < numbers.length; i++) {
          for (let j = 0; j < numbers.length; j++) {
            if (i === j) continue;
            for (let k = 0; k < numbers.length; k++) {
              if (k === i || k === j) continue;
              if (k < i || k < j) continue;
              
              if (Math.abs(numbers[i] * numbers[j] - numbers[k]) < (numbers[k] * 0.03)) {
                qty = i < j ? numbers[i] : numbers[j];
                rate = i < j ? numbers[j] : numbers[i];
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
          if (matched) break;
        }

        if (matched && qty > 0 && rate > 0) {
          const desc = trimmed.substring(0, trimmed.indexOf(numMatches[0])).trim().replace(/^\d+\s+/, '');
          const mappedId = this.autoMapMaterial(desc);
          result.items.push({
            raw_text_name: desc,
            mapped_material_id: mappedId,
            quantity: qty,
            rate: rate
          });
        }
      }
    });

    if (result.items.length === 0) {
      result.items.push({ raw_text_name: 'Manual Restock Line', mapped_material_id: '', quantity: 1, rate: 0 });
    }

    return result;
  }

  autoMapMaterial(name) {
    const clean = name.toLowerCase();
    const match = this.db.raw_materials.find(m => {
      return clean.includes(m.name.toLowerCase()) || 
             m.name.toLowerCase().includes(clean) ||
             clean.includes(m.code.toLowerCase());
    });
    return match ? match.id : '';
  }

  renderVerifyPurchaseTable() {
    const tbody = document.getElementById('verify-purchase-table-body');
    tbody.innerHTML = '';

    this.currentVerifyPurchaseItems.forEach((item, index) => {
      const tr = document.createElement('tr');
      
      let options = '<option value="" disabled selected>-- Map to Raw Material --</option>';
      this.db.raw_materials.forEach(m => {
        options += `<option value="${m.id}" ${item.mapped_material_id === m.id ? 'selected' : ''}>${m.name} (${m.code}) [${m.unit}]</option>`;
      });

      tr.innerHTML = `
        <td>
          <div class="td-bold" style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.25rem;">Extracted: "${item.raw_text_name}"</div>
          <select class="form-control" style="padding:0.4rem;" onchange="app.updateVerifyPurchaseItem(${index}, 'mapped_material_id', this.value)">
            ${options}
          </select>
        </td>
        <td>
          <input type="number" step="0.001" class="form-control" style="padding:0.4rem;" value="${item.quantity}" oninput="app.updateVerifyPurchaseItem(${index}, 'quantity', this.value)">
        </td>
        <td>
          <input type="number" step="0.01" class="form-control" style="padding:0.4rem;" value="${item.rate}" oninput="app.updateVerifyPurchaseItem(${index}, 'rate', this.value)">
        </td>
        <td class="text-center">
          <button type="button" class="btn btn-danger btn-sm" onclick="app.removeVerifyPurchaseRow(${index})">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  updateVerifyPurchaseItem(index, key, val) {
    if (this.currentVerifyPurchaseItems[index]) {
      if (key === 'mapped_material_id') {
        this.currentVerifyPurchaseItems[index].mapped_material_id = val;
      } else {
        this.currentVerifyPurchaseItems[index][key] = parseFloat(val) || 0;
      }
    }
  }

  addVerifyPurchaseRow() {
    this.currentVerifyPurchaseItems.push({ raw_text_name: 'Manual ledger addition', mapped_material_id: '', quantity: 1, rate: 0 });
    this.renderVerifyPurchaseTable();
  }

  removeVerifyPurchaseRow(index) {
    this.currentVerifyPurchaseItems.splice(index, 1);
    this.renderVerifyPurchaseTable();
  }

  postVerifyPurchase() {
    const invNo = document.getElementById('verify-purchase-invoice').value.trim();
    const dateStr = document.getElementById('verify-purchase-date').value;

    if (!invNo || !dateStr) {
      alert("Invoice Number and Date are required.");
      return;
    }

    if (this.currentVerifyPurchaseItems.some(i => !i.mapped_material_id)) {
      alert("Please map all parsed lines to Raw Materials.");
      return;
    }

    const txItems = [];
    const rawMaterialChanges = [];

    this.currentVerifyPurchaseItems.forEach(item => {
      const mat = this.db.raw_materials.find(m => m.id === item.mapped_material_id);
      if (!mat) return;

      const qty = item.quantity;
      const rate = item.rate;
      const total = qty * rate;

      const oldStock = parseFloat(mat.current_stock || 0);
      const oldRate = parseFloat(mat.average_price || 0);

      // Re-evaluate moving weighted average cost: (Old Val + New Val) / (Old Stock + New Stock)
      let newRate = oldRate;
      const newStock = oldStock + qty;
      if (newStock > 0) {
        newRate = ((oldStock * oldRate) + total) / newStock;
      }

      mat.current_stock = newStock;
      mat.average_price = newRate;

      txItems.push({ name: mat.name, qty, rate, total });
      rawMaterialChanges.push({
        material_id: mat.id,
        material_name: mat.name,
        qty_change: qty,
        direction: 'in',
        wastage_qty: 0
      });
    });

    this.db.transactions.push({
      id: 'tx_' + Date.now(),
      type: 'purchase',
      date: dateStr,
      invoice_no: invNo,
      description: `Stock Inward purchase: restocked ${txItems.length} materials.`,
      items: txItems,
      raw_material_changes: rawMaterialChanges
    });

    this.saveDb();
    this.closeModal('purchase-verify-modal');
    this.refreshAllViews();
    
    alert("Inward committed! Inventory stock and average pricing adjusted.");
  }


  async parseImageText(file) {
    if (typeof Tesseract !== 'undefined' && Tesseract.recognize) {
      try {
        const { data: { text } } = await Tesseract.recognize(file, 'eng');
        return text || '';
      } catch (err) {
        console.warn("Tesseract OCR warning:", err);
      }
    }
    return '';
  }

  // --- SALE PDF/IMAGE INWARD DEDUCTIONS & MULTI-INVOICE BATCH DISPATCH ---
  
  async handleSaleUpload(file) {
    if (file) {
      await this.handleSaleUploadMultiple([file]);
    }
  }

  async handleSaleUploadMultiple(fileList) {
    if (!fileList || fileList.length === 0) return;

    const files = Array.from(fileList).filter(f => 
      f.type === 'application/pdf' || 
      f.name.toLowerCase().endsWith('.pdf') ||
      f.type.startsWith('image/') ||
      /\.(jpe?g|png|gif|bmp|webp)$/i.test(f.name)
    );
    if (files.length === 0) {
      alert("Please select one or more PDF sales invoices or bill images.");
      return;
    }

    this.batchSalesInvoices = [];
    this.activeBatchInvoiceIndex = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      try {
        const rawText = isPdf ? await this.parsePDFText(file) : await this.parseImageText(file);
        const extracted = this.heuristicsExtractSale(rawText, file.name);
        this.batchSalesInvoices.push({
          fileName: file.name,
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

    if (this.batchSalesInvoices.length === 0) {
      alert("Could not extract sales invoice details from the selected file(s). Please verify the format.");
      return;
    }

    this.renderBatchSaleModal();
  }

  openManualSaleModal() {
    this.batchSalesInvoices = [{
      fileName: 'Manual Sale Entry',
      invoice_no: 'MNS-' + Math.floor(1000 + Math.random() * 9000),
      date: new Date().toISOString().split('T')[0],
      customer: '',
      gstin: '',
      net_amount: 0,
      products: [{ raw_text_name: 'Manual Product Entry', hsn: '', product_id: '', quantity_sold: 1, rate: 0, discount: 0, amount: 0 }]
    }];
    this.activeBatchInvoiceIndex = 0;
    this.renderBatchSaleModal();
  }

  renderBatchSaleModal() {
    if (!this.batchSalesInvoices || this.batchSalesInvoices.length === 0) {
      this.closeModal('sale-verify-modal');
      return;
    }

    if (this.activeBatchInvoiceIndex >= this.batchSalesInvoices.length) {
      this.activeBatchInvoiceIndex = this.batchSalesInvoices.length - 1;
    }
    if (this.activeBatchInvoiceIndex < 0) {
      this.activeBatchInvoiceIndex = 0;
    }

    const cur = this.batchSalesInvoices[this.activeBatchInvoiceIndex];
    const isBatch = this.batchSalesInvoices.length > 1;

    // Configure title and batch nav bar
    const titleEl = document.getElementById('sale-verify-modal-title');
    if (titleEl) {
      titleEl.textContent = isBatch 
        ? `Verify Sales Invoices (Batch Upload: ${this.batchSalesInvoices.length} Invoices)` 
        : `Verify Sales Invoice Dispatch`;
    }

    const batchNav = document.getElementById('sale-batch-nav');
    const batchTabs = document.getElementById('sale-batch-tabs');
    const batchBadge = document.getElementById('sale-batch-count-badge');
    const commitAllBtn = document.getElementById('sale-commit-all-btn');

    if (batchNav) {
      if (isBatch) {
        batchNav.style.display = 'flex';
        if (batchBadge) batchBadge.textContent = `Batch: ${this.batchSalesInvoices.length} Invoices`;
        if (commitAllBtn) {
          commitAllBtn.innerHTML = `<i class="fa-solid fa-check-double"></i> Commit All (${this.batchSalesInvoices.length}) Invoices`;
        }
        if (batchTabs) {
          batchTabs.innerHTML = '';
          this.batchSalesInvoices.forEach((inv, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `btn btn-sm ${idx === this.activeBatchInvoiceIndex ? 'btn-primary' : 'btn-secondary'}`;
            btn.style.fontSize = '0.75rem';
            btn.style.padding = '0.25rem 0.5rem';
            const invLabel = inv.invoice_no || `Inv ${idx + 1}`;
            btn.innerHTML = `${idx + 1}. <strong>${invLabel}</strong> (${inv.products.length})`;
            btn.onclick = () => this.switchBatchSaleIndex(idx);
            batchTabs.appendChild(btn);
          });
        }
      } else {
        batchNav.style.display = 'none';
      }
    }

    // Populate header inputs
    const invInput = document.getElementById('verify-sale-invoice');
    if (invInput) invInput.value = cur.invoice_no || '';
    
    const dateInput = document.getElementById('verify-sale-date');
    if (dateInput) dateInput.value = cur.date || new Date().toISOString().split('T')[0];

    const custInput = document.getElementById('verify-sale-customer');
    if (custInput) custInput.value = cur.customer || '';

    // Active line items
    this.currentVerifySaleItems = cur.products;
    this.renderVerifySaleTable();
    this.calculateBOMDeductions();

    this.openModal('sale-verify-modal');
  }

  switchBatchSaleIndex(index) {
    // Save current header edits
    if (this.batchSalesInvoices[this.activeBatchInvoiceIndex]) {
      const invInput = document.getElementById('verify-sale-invoice');
      if (invInput) this.batchSalesInvoices[this.activeBatchInvoiceIndex].invoice_no = invInput.value.trim();
      const dateInput = document.getElementById('verify-sale-date');
      if (dateInput) this.batchSalesInvoices[this.activeBatchInvoiceIndex].date = dateInput.value;
      const custInput = document.getElementById('verify-sale-customer');
      if (custInput) this.batchSalesInvoices[this.activeBatchInvoiceIndex].customer = custInput.value.trim();
    }
    this.activeBatchInvoiceIndex = index;
    this.renderBatchSaleModal();
  }

  discardActiveSaleInvoice() {
    if (!this.batchSalesInvoices || this.batchSalesInvoices.length === 0) return;
    const discarded = this.batchSalesInvoices[this.activeBatchInvoiceIndex];
    if (!confirm(`Discard invoice ${discarded.invoice_no || ''} from current queue?`)) return;

    this.batchSalesInvoices.splice(this.activeBatchInvoiceIndex, 1);
    if (this.batchSalesInvoices.length === 0) {
      this.closeModal('sale-verify-modal');
    } else {
      if (this.activeBatchInvoiceIndex >= this.batchSalesInvoices.length) {
        this.activeBatchInvoiceIndex = this.batchSalesInvoices.length - 1;
      }
      this.renderBatchSaleModal();
    }
  }

  updateActiveInvoiceHeader(field, val) {
    if (this.batchSalesInvoices && this.batchSalesInvoices[this.activeBatchInvoiceIndex]) {
      this.batchSalesInvoices[this.activeBatchInvoiceIndex][field] = val.trim();
    }
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
      result.date = new Date().toISOString().split('T')[0];
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
      result.products.push({
        raw_text_name: 'Manual Dispatch Line',
        hsn: '',
        product_id: '',
        quantity_sold: 1,
        rate: 0,
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

    // 1. Direct match with existing products
    let match = this.db.products.find(p => p.name.toLowerCase() === clean);
    if (match) return match.id;

    match = this.db.products.find(p => {
      const pClean = p.name.toLowerCase();
      return clean.includes(pClean) || pClean.includes(clean) || (p.code && clean.includes(p.code.toLowerCase()));
    });
    if (match) return match.id;

    // 2. Keyword matching with core product words
    const noise = ['truflavr', 'gms', 'gm', 'pouch', 'pouches', 'bottle', 'bottles', 'sachet', 'sachets', 'pcs', 'box', 'boxes'];
    const keywords = clean.split(/\s+/).filter(w => w.length > 2 && !noise.includes(w));
    
    let bestScore = 0;
    let bestProduct = null;

    this.db.products.forEach(p => {
      const pWords = p.name.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !noise.includes(w));
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
      { id: 'fg_or_pz_10g', name: 'truFLAVR Oregano Pizza Seasoning 10 gms Pouch', code: 'FG-OR-PZ-10G', price: 5.79 },
      { id: 'fg_cf_10g', name: 'truFLAVR Chilli Flakes 10 gms Pouch', code: 'FG-CF-10G', price: 5.79 },
      { id: 'fg_cf_45g', name: 'truFLAVR Chilli Flakes 45 gms Bottle', code: 'FG-CF-45G', price: 63.64 },
      { id: 'fg_or_25g', name: 'truFLAVR Oregano 25 gms Bottle', code: 'FG-OR-25G', price: 57.28 },
      { id: 'fg_is_40g', name: 'truFLAVR Italian Seasoning 40 gms Bottle', code: 'FG-IS-40G', price: 63.64 },
      { id: 'fg_pp_50g', name: 'truFLAVR Peri Peri 50 gms Bottle', code: 'FG-PP-50G', price: 57.28 },
      { id: 'fg_cpp_50g', name: 'truFLAVR Cheese Peri Peri 50 gms Bottle', code: 'FG-CPP-50G', price: 57.28 },
      { id: 'fg_bs_10g', name: 'truFLAVR Bombay Sandwich 10 gms Pouch', code: 'FG-BS-10G', price: 5.79 },
      { id: 'fg_im_10g', name: 'truFLAVR Italian Mix 10 gms Pouch', code: 'FG-IM-10G', price: 5.79 },
      { id: 'fg_pp_10g', name: 'truFLAVR Peri Peri 10 gms Pouch', code: 'FG-PP-10G', price: 5.79 }
    ];

    for (const catProd of catalogue) {
      const catKeywords = catProd.name.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !noise.includes(w));
      let matchCount = 0;
      keywords.forEach(kw => {
        if (catKeywords.some(cw => cw.includes(kw) || kw.includes(cw))) matchCount++;
      });
      if (matchCount >= 2 || (keywords.length > 0 && matchCount / keywords.length >= 0.5)) {
        let existing = this.db.products.find(p => p.id === catProd.id);
        if (!existing) {
          existing = {
            id: catProd.id,
            code: catProd.code,
            name: catProd.name,
            price: catProd.price,
            selling_price: catProd.price,
            current_stock: 0,
            min_stock: 50,
            packaging_type: catProd.name.includes('Pouch') ? 'Pouches' : (catProd.name.includes('Bottle') ? 'Bottles' : 'Boxes'),
            bom: []
          };
          this.db.products.push(existing);
          this.saveDb();
        }
        return existing.id;
      }
    }

    return '';
  }

  renderVerifySaleTable() {
    const tbody = document.getElementById('verify-sale-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    let grandTotal = 0;

    this.currentVerifySaleItems.forEach((item, index) => {
      const tr = document.createElement('tr');
      
      let options = '<option value="" disabled selected>-- Select Product --</option>';
      this.db.products.forEach(p => {
        options += `<option value="${p.id}" ${item.product_id === p.id ? 'selected' : ''}>${p.name} (${p.code})</option>`;
      });

      const qty = parseFloat(item.quantity_sold) || 0;
      const rate = parseFloat(item.rate) || 0;
      const disc = parseFloat(item.discount) || 0;
      const lineTotal = item.amount || (qty * Math.max(0, rate - disc));
      grandTotal += lineTotal;

      tr.innerHTML = `
        <td>
          <div class="td-bold" style="font-size:0.75rem; color:var(--text-muted); margin-bottom:0.25rem;">
            Extracted: "${item.raw_text_name || 'Manual Item'}" ${item.hsn ? `(HSN: ${item.hsn})` : ''}
          </div>
          <select class="form-control" style="padding:0.35rem; font-size:0.8rem;" onchange="app.updateVerifySaleItem(${index}, 'product_id', this.value)">
            ${options}
          </select>
        </td>
        <td style="width:90px;">
          <input type="number" min="1" class="form-control" style="padding:0.35rem; font-size:0.8rem;" value="${item.quantity_sold}" oninput="app.updateVerifySaleItem(${index}, 'quantity_sold', this.value)">
        </td>
        <td style="width:100px;">
          <input type="number" min="0" step="0.01" class="form-control" style="padding:0.35rem; font-size:0.8rem;" value="${item.rate || 0}" oninput="app.updateVerifySaleItem(${index}, 'rate', this.value)">
        </td>
        <td style="width:80px;">
          <input type="number" min="0" step="0.01" class="form-control" style="padding:0.35rem; font-size:0.8rem;" value="${item.discount || 0}" oninput="app.updateVerifySaleItem(${index}, 'discount', this.value)">
        </td>
        <td style="width:110px; font-weight:600; text-align:right; vertical-align:middle;">
          ${this.formatCurrency(lineTotal)}
        </td>
        <td class="text-center" style="width:45px; vertical-align:middle;">
          <button type="button" class="btn btn-danger btn-sm" style="padding:0.25rem 0.45rem;" onclick="app.removeVerifySaleRow(${index})">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    const totalEl = document.getElementById('verify-sale-total-amount');
    if (totalEl) totalEl.textContent = this.formatCurrency(grandTotal);
  }

  updateVerifySaleItem(index, key, val) {
    if (this.currentVerifySaleItems[index]) {
      if (key === 'product_id') {
        this.currentVerifySaleItems[index].product_id = val;
        const p = this.db.products.find(prod => prod.id === val);
        if (p && !this.currentVerifySaleItems[index].rate) {
          this.currentVerifySaleItems[index].rate = p.selling_price || p.price;
        }
      } else if (key === 'rate' || key === 'discount') {
        this.currentVerifySaleItems[index][key] = parseFloat(val) || 0;
      } else if (key === 'quantity_sold') {
        this.currentVerifySaleItems[index].quantity_sold = parseInt(val, 10) || 0;
      }
      
      const q = this.currentVerifySaleItems[index].quantity_sold || 0;
      const r = this.currentVerifySaleItems[index].rate || 0;
      const d = this.currentVerifySaleItems[index].discount || 0;
      this.currentVerifySaleItems[index].amount = q * Math.max(0, r - d);

      this.renderVerifySaleTable();
      this.calculateBOMDeductions();
    }
  }

  addVerifySaleRow() {
    this.currentVerifySaleItems.push({ raw_text_name: 'Manual Product Item', hsn: '', product_id: '', quantity_sold: 1, rate: 0, discount: 0, amount: 0 });
    this.renderVerifySaleTable();
    this.calculateBOMDeductions();
  }

  removeVerifySaleRow(index) {
    this.currentVerifySaleItems.splice(index, 1);
    this.renderVerifySaleTable();
    this.calculateBOMDeductions();
  }

  calculateBOMDeductions() {
    const list = document.getElementById('deduction-forecast-list');
    const warning = document.getElementById('sale-stock-warning-container');
    const commitBtn = document.getElementById('confirm-sale-btn');

    if (!list || !warning) return;

    list.innerHTML = '';
    warning.innerHTML = '';
    if (commitBtn) commitBtn.disabled = false;

    const requirements = {};
    let productsLoaded = 0;

    this.currentVerifySaleItems.forEach(item => {
      if (!item.product_id) return;
      productsLoaded++;

      const prod = this.db.products.find(p => p.id === item.product_id);
      if (!prod) return;

      if (!requirements[item.product_id]) {
        requirements[item.product_id] = {
          name: prod.name,
          code: prod.code,
          needed: 0,
          stock: parseFloat(prod.current_stock || 0)
        };
      }
      requirements[item.product_id].needed += item.quantity_sold;
    });

    if (productsLoaded === 0) {
      list.innerHTML = `<div class="empty-list-text" style="padding:1rem;">Select product SKU to view warehouse stock coverage.</div>`;
      return;
    }

    let deficit = false;
    Object.values(requirements).forEach(req => {
      const diff = req.needed - req.stock;
      const isShort = diff > 0;
      if (isShort) deficit = true;

      const div = document.createElement('div');
      div.className = 'deduction-list-item';
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';
      div.style.padding = '0.4rem 0';
      div.style.borderBottom = '1px solid var(--border-light)';

      div.innerHTML = `
        <div>
          <div class="td-bold" style="font-size:0.85rem;">${req.name} <span class="td-muted" style="font-size:0.75rem;">(${req.code})</span></div>
          <div class="td-muted" style="font-size:0.75rem;">Current Warehouse Stock: ${req.stock.toFixed(0)} pcs</div>
        </div>
        <div style="text-align:right;">
          <div class="td-bold" style="font-size:0.85rem; color:${isShort ? 'var(--color-danger)' : 'var(--color-success)'};">${req.needed} pcs</div>
          <span class="badge badge-${isShort ? 'danger' : 'success'}" style="font-size:0.7rem;">${isShort ? 'Shortage: -' + diff : 'In Stock'}</span>
        </div>
      `;
      list.appendChild(div);
    });

    if (deficit) {
      warning.innerHTML = `
        <div class="alert-banner danger" style="padding: 0.45rem 0.65rem; font-size:0.75rem; margin-bottom: 0.5rem;">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <div><strong>Stock Outward Shortage Warning!</strong> Dispatched quantity exceeds available warehouse finished goods stock.</div>
        </div>
      `;
    }
  }

  postVerifySale() {
    const invNo = document.getElementById('verify-sale-invoice').value.trim();
    const dateStr = document.getElementById('verify-sale-date').value;
    const customer = (document.getElementById('verify-sale-customer') && document.getElementById('verify-sale-customer').value.trim()) || 'Direct Customer';
    const recordInLedger = document.getElementById('verify-sale-record-ledger') ? document.getElementById('verify-sale-record-ledger').checked : true;

    if (!invNo || !dateStr) {
      alert("Invoice No and Date are required.");
      return;
    }

    if (this.currentVerifySaleItems.some(i => !i.product_id)) {
      alert("Please map all products on this invoice before committing.");
      return;
    }

    const txItems = [];
    const productChanges = [];
    let invoiceTotalVal = 0;

    this.currentVerifySaleItems.forEach(item => {
      const prod = this.db.products.find(p => p.id === item.product_id);
      if (!prod) return;

      const qty = item.quantity_sold;
      const rate = item.rate || prod.selling_price;
      const disc = item.discount || 0;
      const total = item.amount || (qty * Math.max(0, rate - disc));
      invoiceTotalVal += total;

      prod.current_stock = parseFloat(prod.current_stock || 0) - qty;

      txItems.push({ name: prod.name, qty, rate, discount: disc, total });
      productChanges.push({
        product_id: prod.id,
        product_name: prod.name,
        qty_change: -qty,
        direction: 'out'
      });
    });

    // Record operational outward transaction
    this.db.transactions.push({
      id: 'tx_' + Date.now(),
      type: 'sale',
      date: dateStr,
      invoice_no: invNo,
      customer: customer,
      description: `Sales Dispatch Outward: ${customer} (${txItems.length} SKUs)`,
      items: txItems,
      raw_material_changes: [],
      product_changes: productChanges
    });

    // Optionally record in monthly financial cashbook ledger as Sale Receipt
    if (recordInLedger && invoiceTotalVal > 0) {
      this.db.finance_transactions.push({
        id: 'fin_sale_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        date: dateStr,
        details: `Sales Invoice ${invNo} - ${customer}`,
        debit: 0,
        credit: invoiceTotalVal,
        balance: 0,
        category: 'Sale Receipt',
        subCategory: 'Finished Goods Sale',
        employee_id: ''
      });
    }

    this.saveDb();

    // Advance batch if multiple invoices exist
    if (this.batchSalesInvoices && this.batchSalesInvoices.length > 1) {
      this.batchSalesInvoices.splice(this.activeBatchInvoiceIndex, 1);
      if (this.activeBatchInvoiceIndex >= this.batchSalesInvoices.length) {
        this.activeBatchInvoiceIndex = 0;
      }
      this.refreshAllViews();
      this.renderBatchSaleModal();
      alert(`Invoice ${invNo} committed! ${this.batchSalesInvoices.length} remaining in batch queue.`);
    } else {
      this.batchSalesInvoices = [];
      this.closeModal('sale-verify-modal');
      this.refreshAllViews();
      alert(`Sales invoice ${invNo} successfully committed! Finished goods warehouse balances updated.`);
    }
  }

  commitAllBatchSales() {
    if (!this.batchSalesInvoices || this.batchSalesInvoices.length === 0) return;

    // First validate all invoices
    for (let idx = 0; idx < this.batchSalesInvoices.length; idx++) {
      const inv = this.batchSalesInvoices[idx];
      if (!inv.invoice_no || !inv.date) {
        alert(`Invoice #${idx + 1} has missing invoice number or date. Please review.`);
        this.switchBatchSaleIndex(idx);
        return;
      }
      const unmapped = inv.products.find(p => !p.product_id);
      if (unmapped) {
        alert(`Invoice "${inv.invoice_no}" contains unmapped product: "${unmapped.raw_text_name}". Please map all products before batch committing.`);
        this.switchBatchSaleIndex(idx);
        return;
      }
    }

    const recordInLedger = document.getElementById('verify-sale-record-ledger') ? document.getElementById('verify-sale-record-ledger').checked : true;
    let totalCommittedCount = 0;

    this.batchSalesInvoices.forEach(inv => {
      const txItems = [];
      const productChanges = [];
      let invTotal = 0;

      inv.products.forEach(item => {
        const prod = this.db.products.find(p => p.id === item.product_id);
        if (!prod) return;

        const qty = item.quantity_sold;
        const rate = item.rate || prod.selling_price;
        const disc = item.discount || 0;
        const total = item.amount || (qty * Math.max(0, rate - disc));
        invTotal += total;

        prod.current_stock = parseFloat(prod.current_stock || 0) - qty;

        txItems.push({ name: prod.name, qty, rate, discount: disc, total });
        productChanges.push({
          product_id: prod.id,
          product_name: prod.name,
          qty_change: -qty,
          direction: 'out'
        });
      });

      this.db.transactions.push({
        id: 'tx_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        type: 'sale',
        date: inv.date,
        invoice_no: inv.invoice_no,
        customer: inv.customer || 'Direct Customer',
        description: `Sales Dispatch Outward: ${inv.customer || 'Customer'} (${txItems.length} SKUs)`,
        items: txItems,
        raw_material_changes: [],
        product_changes: productChanges
      });

      if (recordInLedger && invTotal > 0) {
        this.db.finance_transactions.push({
          id: 'fin_sale_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
          date: inv.date,
          details: `Sales Invoice ${inv.invoice_no} - ${inv.customer || 'Customer'}`,
          debit: 0,
          credit: invTotal,
          balance: 0,
          category: 'Sale Receipt',
          subCategory: 'Finished Goods Sale',
          employee_id: ''
        });
      }

      totalCommittedCount++;
    });

    this.batchSalesInvoices = [];
    this.saveDb();
    this.closeModal('sale-verify-modal');
    this.refreshAllViews();

    alert(`Batch commit complete! Successfully processed ${totalCommittedCount} sales invoices. Finished goods warehouse balances and financial ledger updated.`);
  }


  /* ==========================================================================
     PROCESSING HEAD PORTALS: DAILY MOBILE CONSOLE FORMS
     ========================================================================== */

  // Load dropdown lists for mobile consoles
  populateMobileDropdowns() {
    const inMaterialSelect = document.getElementById('mobile-in-material');
    const prProductSelect = document.getElementById('mobile-pr-product');
    const outProductSelect = document.getElementById('mobile-out-product');

    if (inMaterialSelect) {
      inMaterialSelect.innerHTML = '<option value="" disabled selected>-- Choose Material --</option>';
      this.db.raw_materials.forEach(m => {
        inMaterialSelect.innerHTML += `<option value="${m.id}">${m.name} (${m.code}) [${m.unit}]</option>`;
      });
    }

    if (prProductSelect) {
      prProductSelect.innerHTML = '<option value="" disabled selected>-- Choose Product to Make --</option>';
      this.db.products.forEach(p => {
        prProductSelect.innerHTML += `<option value="${p.id}">${p.name} (${p.code})</option>`;
      });
    }

    if (outProductSelect) {
      outProductSelect.innerHTML = '<option value="" disabled selected>-- Choose Product to Ship --</option>';
      this.db.products.forEach(p => {
        outProductSelect.innerHTML += `<option value="${p.id}">${p.name} (${p.code})</option>`;
      });
    }

    // Default dates
    document.getElementById('mobile-in-bill').value = 'INW-' + Math.floor(1000 + Math.random() * 9000);
    document.getElementById('mobile-out-invoice').value = 'OTW-' + Math.floor(1000 + Math.random() * 9000);
  }

  // 1. INWARD RAW MATERIALS (MOBILE LOG)
  handleMobileInward(e) {
    e.preventDefault();

    const matId = document.getElementById('mobile-in-material').value;
    const qty = parseFloat(document.getElementById('mobile-in-qty').value) || 0;
    const rate = parseFloat(document.getElementById('mobile-in-rate').value) || 0;
    const supplier = document.getElementById('mobile-in-supplier').value.trim();
    const billRef = document.getElementById('mobile-in-bill').value.trim();

    if (!matId || qty <= 0 || rate <= 0 || !supplier) {
      alert("Please fill in all inward fields.");
      return;
    }

    const mat = this.db.raw_materials.find(m => m.id === matId);
    if (!mat) return;

    // Recalculate moving average rate:
    const oldStock = parseFloat(mat.current_stock || 0);
    const oldRate = parseFloat(mat.average_price || 0);
    const totalCost = qty * rate;

    let newRate = oldRate;
    const newStock = oldStock + qty;
    if (newStock > 0) {
      newRate = ((oldStock * oldRate) + totalCost) / newStock;
    }

    // Commit changes to database
    mat.current_stock = newStock;
    mat.average_price = newRate;

    // Log Activity
    this.db.transactions.push({
      id: 'tx_' + Date.now(),
      type: 'purchase',
      date: new Date().toISOString().split('T')[0],
      invoice_no: billRef,
      description: `Mobile Inward: Restocked ${qty} ${mat.unit} of ${mat.name} from ${supplier}`,
      items: [{ name: mat.name, qty, rate, total: totalCost }],
      raw_material_changes: [{
        material_id: mat.id,
        material_name: mat.name,
        qty_change: qty,
        direction: 'in',
        wastage_qty: 0
      }]
    });

    this.saveDb();
    this.refreshAllViews();
    this.populateMobileDropdowns();
    
    // Clear form inputs
    document.getElementById('mobile-inward-form').reset();
    alert(`Success! Stock for ${mat.name} has been incremented to ${newStock.toFixed(3)}.`);
  }

  // 2. RECIPE FORECAST CHECK (MOBILE DETECTS DEFICIT)
  updateMobileRecipeForecast() {
    const prId = document.getElementById('mobile-pr-product').value;
    const prQty = parseFloat(document.getElementById('mobile-pr-qty').value) || 0;
    const listContainer = document.getElementById('mobile-recipe-list');

    listContainer.innerHTML = '';

    if (!prId || prQty <= 0) {
      listContainer.innerHTML = `<span class="td-muted italic">Select a product and batch size to cover checklist.</span>`;
      return;
    }

    const prod = this.db.products.find(p => p.id === prId);
    if (!prod) return;

    let hasDeficit = false;

    prod.bom.forEach(recipe => {
      const mat = this.db.raw_materials.find(m => m.id === recipe.material_id);
      const name = mat ? mat.name : 'Unknown';
      const unit = mat ? mat.unit : 'pcs';
      const available = mat ? parseFloat(mat.current_stock || 0) : 0;
      
      const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage) / 100);
      const needed = recipe.quantity * prQty * wasteFactor;
      const isShort = needed > available;

      if (isShort) hasDeficit = true;

      const itemDiv = document.createElement('div');
      itemDiv.style.display = 'flex';
      itemDiv.style.justifyContent = 'space-between';
      itemDiv.style.color = isShort ? 'var(--color-danger)' : 'var(--color-success)';
      itemDiv.innerHTML = `
        <span>• ${name}: ${needed.toFixed(3)} ${unit} needed</span>
        <strong>(Avail: ${available.toFixed(3)} ${unit}) ${isShort ? '⚠️ Deficit' : '✓'}</strong>
      `;
      listContainer.appendChild(itemDiv);
    });
  }

  // 3. RUN BATCH PRODUCTION RUN (MOBILE WORKFLOW)
  handleMobileProcess(e) {
    e.preventDefault();

    const prId = document.getElementById('mobile-pr-product').value;
    const batchQty = parseFloat(document.getElementById('mobile-pr-qty').value) || 0;

    if (!prId || batchQty <= 0) {
      alert("Select a valid product and batch manufacture quantity.");
      return;
    }

    const prod = this.db.products.find(p => p.id === prId);
    if (!prod) return;

    // Verify raw materials covers
    let deficitMessage = '';
    const rawMaterialChanges = [];

    prod.bom.forEach(recipe => {
      const mat = this.db.raw_materials.find(m => m.id === recipe.material_id);
      const name = mat ? mat.name : 'Unknown';
      const available = mat ? parseFloat(mat.current_stock || 0) : 0;
      
      const wasteFactor = 1 + (parseFloat(recipe.wastage_percentage) / 100);
      const needed = recipe.quantity * batchQty * wasteFactor;
      const wastePortion = needed - (recipe.quantity * batchQty);

      if (needed > available) {
        deficitMessage += `Ingredient "${name}" stock is ${available.toFixed(3)}, but this batch requires ${needed.toFixed(3)}.\n`;
      }

      rawMaterialChanges.push({
        material_id: recipe.material_id,
        material_name: name,
        qty_change: -needed, // deduct
        direction: 'out',
        wastage_qty: wastePortion
      });
    });

    if (deficitMessage) {
      const proceed = confirm(`Warning: Raw materials stock deficit detected!\n\n${deficitMessage}\nDo you still wish to execute the production run?`);
      if (!proceed) return;
    }

    // Deduct Raw Materials from Ledger
    rawMaterialChanges.forEach(change => {
      const mat = this.db.raw_materials.find(m => m.id === change.material_id);
      if (mat) {
        mat.current_stock = parseFloat(mat.current_stock || 0) + change.qty_change; // adjust stock (negative)
      }
    });

    // Increment Finished Goods Stock counts
    prod.current_stock = parseFloat(prod.current_stock || 0) + batchQty;

    // Log Activity log
    this.db.transactions.push({
      id: 'tx_' + Date.now(),
      type: 'production',
      date: new Date().toISOString().split('T')[0],
      invoice_no: 'BATCH-' + Math.floor(100 + Math.random() * 900),
      description: `Daily Processing: Manufactured ${batchQty} units of ${prod.name}`,
      items: [{ name: prod.name, qty: batchQty, rate: 0, total: 0 }],
      raw_material_changes: rawMaterialChanges,
      product_changes: [{
        product_id: prod.id,
        product_name: prod.name,
        qty_change: batchQty,
        direction: 'in'
      }]
    });

    this.saveDb();
    this.refreshAllViews();
    this.populateMobileDropdowns();
    
    document.getElementById('mobile-process-form').reset();
    document.getElementById('mobile-recipe-list').innerHTML = `<span class="td-muted italic">Select a product to view ingredients cover.</span>`;
    
    alert(`Success! Manufactured ${batchQty} pieces. Warehouse restocked.`);
  }

  // 4. OUTWARD SALES SHIPMENT (MOBILE WORKFLOW)
  handleMobileOutward(e) {
    e.preventDefault();

    const prodId = document.getElementById('mobile-out-product').value;
    const qty = parseFloat(document.getElementById('mobile-out-qty').value) || 0;
    const price = parseFloat(document.getElementById('mobile-out-price').value) || 0;
    const customer = document.getElementById('mobile-out-customer').value.trim();
    const invoiceNo = document.getElementById('mobile-out-invoice').value.trim();

    if (!prodId || qty <= 0 || price <= 0 || !customer || !invoiceNo) {
      alert("Please fill in all sales dispatch details.");
      return;
    }

    const prod = this.db.products.find(p => p.id === prodId);
    if (!prod) return;

    const currentStock = parseFloat(prod.current_stock || 0);
    if (qty > currentStock) {
      const proceed = confirm(`Warning: Finished Goods warehouse cover is ${currentStock} units, but dispatch request is ${qty} units. Allow negative balance?`);
      if (!proceed) return;
    }

    // Deduct stock from Finished Goods warehouse
    prod.current_stock = currentStock - qty;

    // Log Activity log
    this.db.transactions.push({
      id: 'tx_' + Date.now(),
      type: 'sale',
      date: new Date().toISOString().split('T')[0],
      invoice_no: invoiceNo,
      description: `Mobile Outward: Dispatched ${qty} pieces of ${prod.name} to ${customer}`,
      items: [{ name: prod.name, qty, rate: price, total: qty * price }],
      raw_material_changes: [],
      product_changes: [{
        product_id: prod.id,
        product_name: prod.name,
        qty_change: -qty,
        direction: 'out'
      }]
    });

    this.saveDb();
    this.refreshAllViews();
    this.populateMobileDropdowns();
    
    document.getElementById('mobile-outward-form').reset();
    alert(`Success! Dispatched ${qty} units. Warehouse balance updated.`);
  }


  /* ==========================================================================
     ACTIVITY LOGGER Trail rendering
     ========================================================================== */
  renderHistory() {
    const tbody = document.getElementById('history-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    const filter = this.historyFilter || 'all';
    const all = this.getAllActivities();
    const filtered = filter === 'all' ? all : all.filter(a => a.type === filter);

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-list-text" style="padding:2.5rem; text-align:center;">No operational activities recorded for category "${filter}". Use mobile portal or simulator to log events.</td></tr>`;
      return;
    }

    filtered.forEach(act => {
      let actionHtml = '<span class="td-muted">-</span>';
      if (act.type === 'order') {
        actionHtml = `
          <button type="button" class="btn btn-danger btn-sm" onclick="app.deleteOrder('${act.id}')" title="Delete purchase order created by mistake" style="padding:0.22rem 0.55rem; font-size:0.75rem;">
            <i class="fa-solid fa-trash-can"></i> Delete
          </button>
        `;
      } else if (act.material_id) {
        actionHtml = `
          <button type="button" class="btn btn-secondary btn-sm" onclick="app.openMaterialLedgerModal('${act.material_id}')" title="View Detailed Stock Ledger" style="padding:0.22rem 0.55rem; font-size:0.75rem;">
            <i class="fa-solid fa-list-check"></i> Ledger
          </button>
        `;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="white-space:nowrap;">${act.date}</td>
        <td>
          <span class="badge ${act.badgeClass}">
            <i class="fa-solid ${act.icon}" style="margin-right:0.25rem;"></i>
            ${act.typeLabel}
          </span>
        </td>
        <td class="td-bold" style="white-space:nowrap;">${act.ref}</td>
        <td style="max-width:280px;">
          <div class="td-bold" style="font-size:0.85rem;">${act.title}</div>
          <div class="td-muted" style="font-size:0.75rem; margin-top:0.15rem;">${act.description}</div>
        </td>
        <td style="font-size:0.85rem;">${act.quantities}</td>
        <td style="text-align: right; white-space:nowrap;">${actionHtml}</td>
      `;
      tbody.appendChild(tr);
    });
  }


  /* ==========================================================================
     CORE DATA RESETS & BACKUP HANDLERS
     ========================================================================== */
  exportDatabase() {
    const dataStr = JSON.stringify(this.db, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `AetherERP_CompleteBackup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  importDatabase(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target.result);
        if (imported.raw_materials && imported.products && imported.transactions) {
          this.db = {
            ...this.db,
            ...imported
          };
          this.saveDb();
          this.refreshAllViews();
          alert("Database successfully restored!");
        } else {
          alert("Invalid database structure. Could not restore backup.");
        }
      } catch (err) {
        alert("Failed to parse JSON backup file: " + err.message);
      }
    };
    reader.readAsText(file);
  }

  resetDatabase() {
    if (!confirm("Are you sure you want to restore database settings? All raw materials, BOM recipes and transaction logs will be permanently deleted.")) return;

    localStorage.removeItem('erp_inventory_db');
    this.db = {
      raw_materials: [],
      products: [],
      transactions: [],
      finance_transactions: [],
      employees: [],
      columnMapping: {
        date: 'Date',
        details: 'Transaction Details',
        debit: 'Debit',
        credit: 'Credit',
        balance: 'Balance',
        department: 'Is Expense Part of HO Growing Processing',
        expenseDetails: 'Details of the Expense',
        saleRevenue: 'Sale Revenue'
      },
      settings: {
        default_wastage: 1.5
      }
    };
    this.saveDb();
    this.refreshAllViews();
    alert("Database successfully reset to blank state.");
  }

  // Pre-populates comprehensive realistic database records (ingredients, products, recipes)
  generateDemoData() {
    if (typeof MFP_CUTOFF_DATA_7NOV !== 'undefined') {
      this.load7NovCutoffData();
      return;
    }
    if (!confirm("This will overwrite your operational inventory database. Financial ledger cash books will not be affected. Proceed?")) return;

    this.db.raw_materials = [
      // Spices and Raw Crops
      { id: 'rm_chilli', code: 'RM-CHILLI-RED', name: 'Raw Dried Red Chilli', current_stock: 120.00, unit: 'kg', average_price: 180.00, min_stock: 20.00, description: 'Sun-dried high heat red chillies.' },
      { id: 'rm_peri', code: 'RM-PERI-PERI', name: 'African Peri Peri Spice', current_stock: 45.00, unit: 'kg', average_price: 320.00, min_stock: 10.00, description: 'Genuine whole African Bird Eye pepper pods.' },
      { id: 'rm_thyme', code: 'RM-THYME-DRY', name: 'Dried Thyme Leaves', current_stock: 35.00, unit: 'kg', average_price: 450.00, min_stock: 8.00, description: 'Aromatic dried herb leaves.' },
      { id: 'rm_rose', code: 'RM-ROSEMARY', name: 'Whole Dried Rosemary', current_stock: 25.00, unit: 'kg', average_price: 520.00, min_stock: 8.00, description: 'Hand-picked culinary rosemary needles.' },
      
      // Packaging materials
      { id: 'rm_btl_glass', code: 'RM-BTL-150ML', name: 'Glass Bottles 150ml', current_stock: 1200.00, unit: 'Pieces', average_price: 8.50, min_stock: 300.00, description: 'Clear sauce shaker bottles with caps.' },
      { id: 'rm_carton_box', code: 'RM-BOX-INNER', name: 'Inner Carton Boxes', current_stock: 850.00, unit: 'Pieces', average_price: 3.20, min_stock: 200.00, description: 'Single product packaging cardboard box.' },
      { id: 'rm_pouch_out', code: 'RM-PCH-OUTER', name: 'Outer Pouches Foil', current_stock: 2400.00, unit: 'Pieces', average_price: 0.65, min_stock: 500.00, description: 'Aluminum protective packaging pouches.' }
    ];

    this.db.products = [
      {
        id: 'prod_peri_sauce',
        code: 'FG-PERI-150ML',
        name: 'Signature Peri Peri Sauce 150ml',
        price: 180.00,
        selling_price: 160.00,
        current_stock: 120.00,
        min_stock: 30.00,
        description: 'Vibrant hot sauce packed in glass bottles with protective pouches.',
        packaging_type: 'Bottles',
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
        description: 'Perfect kitchen herbs mix packed in carton boxes.',
        packaging_type: 'Boxes',
        bom: [
          { material_id: 'rm_thyme', quantity: 0.035, wastage_percentage: 1.0 },
          { material_id: 'rm_rose', quantity: 0.015, wastage_percentage: 1.0 },
          { material_id: 'rm_carton_box', quantity: 1.0, wastage_percentage: 0.0 }
        ]
      }
    ];

    // Seed mock operational transaction history
    this.db.transactions = [
      {
        id: 'tx_seed_1',
        type: 'purchase',
        date: new Date().toISOString().split('T')[0],
        invoice_no: 'INW-OPEN',
        description: 'Opening allocation: initialized raw material levels',
        items: [{ name: 'Spices & Packaging', qty: 1, rate: 0, total: 0 }],
        raw_material_changes: [
          { material_id: 'rm_chilli', material_name: 'Raw Dried Red Chilli', qty_change: 120.00, direction: 'in', wastage_qty: 0 },
          { material_id: 'rm_peri', material_name: 'African Peri Peri Spice', qty_change: 45.00, direction: 'in', wastage_qty: 0 },
          { material_id: 'rm_btl_glass', material_name: 'Glass Bottles 150ml', qty_change: 1200.00, direction: 'in', wastage_qty: 0 }
        ]
      }
    ];

    this.saveDb();
    this.refreshAllViews();
    alert("Operational inventory mock database loaded successfully!");
  }

  loadSupabaseConfig() {
    const config = localStorage.getItem('mfp_supabase_config') || localStorage.getItem('erp_supabase_config');
    if (config) {
      try {
        this.supabaseConfig = JSON.parse(config);
        if (this.supabaseConfig.supabaseUrl && this.supabaseConfig.supabaseKey) {
          let cleanUrl = this.supabaseConfig.supabaseUrl.trim();
          cleanUrl = cleanUrl.replace(/\/rest\/v1\/?$/, '');
          cleanUrl = cleanUrl.replace(/\/$/, '');
          this.supabase = supabase.createClient(cleanUrl, this.supabaseConfig.supabaseKey);
          this.supabaseConfig.isOnline = true;
          
          // Populate the fields on the settings page
          setTimeout(() => {
            const urlInput = document.getElementById('settings-supabase-url');
            const keyInput = document.getElementById('settings-supabase-key');
            if (urlInput) urlInput.value = this.supabaseConfig.supabaseUrl;
            if (keyInput) keyInput.value = this.supabaseConfig.supabaseKey;
          }, 200);
        }
      } catch (e) {
        console.error("Failed to init Supabase in desktop app", e);
      }
    }
  }

  saveSupabaseConfig() {
    const url = document.getElementById('settings-supabase-url').value.trim();
    const key = document.getElementById('settings-supabase-key').value.trim();
    
    if (!url || !key) {
      alert("Please fill in both Supabase URL and Anon Key.");
      return;
    }

    this.supabaseConfig = {
      supabaseUrl: url,
      supabaseKey: key,
      isOnline: true
    };
    
    localStorage.setItem('mfp_supabase_config', JSON.stringify(this.supabaseConfig));
    localStorage.setItem('erp_supabase_config', JSON.stringify(this.supabaseConfig)); // key fallback
    
    this.loadSupabaseConfig();
    this.pullDataFromSupabase(); // Automatically try to sync and pull from cloud
    alert("Supabase cloud database configuration saved successfully!");
  }

  async pullDataFromSupabase() {
    if (!this.supabase || !this.supabaseConfig.isOnline) return;

    try {
      // 1. Pull Raw Materials
      const { data: materials, error: mErr } = await this.supabase.from('raw_materials').select('*').order('name');
      if (mErr) console.error("Error pulling raw materials from cloud", mErr);
      else if (materials && materials.length > 0) {
        this.db.raw_materials = materials;
      }

      // 2. Pull Products
      const { data: products, error: pErr } = await this.supabase.from('products').select('*').order('name');
      if (pErr) console.error("Error pulling products from cloud", pErr);
      else if (products && products.length > 0) {
        this.db.products = products;
      }

      // 3. Pull Orders
      const { data: orders, error: oErr } = await this.supabase.from('orders').select('*').order('created_at', { ascending: false });
      if (oErr) console.error("Error pulling orders from cloud", oErr);
      else if (orders) {
        this.db.orders = orders;
      }

      // 4. Pull Inwards
      const { data: inwards, error: inwErr } = await this.supabase.from('inwards').select('*').order('created_at', { ascending: false });
      if (inwErr) console.error("Error pulling inwards from cloud", inwErr);
      else if (inwards) {
        this.db.inwards = inwards;
      }

      // 5. Pull Productions
      const { data: productions, error: prodErr } = await this.supabase.from('productions').select('*').order('created_at', { ascending: false });
      if (prodErr) console.error("Error pulling productions from cloud", prodErr);
      else if (productions) {
        this.db.productions = productions;
      }

      // 6. Pull Outwards
      const { data: outwards, error: outwErr } = await this.supabase.from('outwards').select('*').order('created_at', { ascending: false });
      if (outwErr) console.error("Error pulling outwards from cloud", outwErr);
      else if (outwards) {
        this.db.outwards = outwards;
      }

      this.saveDb();
      this.refreshAllViews();
    } catch (e) {
      console.error("Exception pulling cloud data:", e);
    }
  }

  async syncLocalDataToSupabase() {
    if (!this.supabase || !this.supabaseConfig.isOnline) {
      alert("Please save and connect your Supabase cloud configuration first!");
      return;
    }

    const btn = document.getElementById('sync-cloud-btn');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Syncing in progress...`;

    try {
      console.log("Syncing raw materials...");
      const materialsToUpload = this.db.raw_materials.map(m => ({
        id: m.id || 'rm_' + Math.random().toString(36).substring(2, 9),
        code: m.code,
        name: m.name,
        current_stock: parseFloat(m.current_stock) || 0,
        unit: m.unit || 'kg',
        average_price: parseFloat(m.average_price) || 0,
        min_stock: parseFloat(m.min_stock) || 5.0,
        description: m.description || ''
      }));

      const { error: mErr } = await this.supabase.from('raw_materials').upsert(materialsToUpload);
      if (mErr) throw mErr;

      console.log("Syncing products...");
      const productsToUpload = this.db.products.map(p => ({
        id: p.id || 'prod_' + Math.random().toString(36).substring(2, 9),
        code: p.code,
        name: p.name,
        price: parseFloat(p.price) || 0,
        selling_price: parseFloat(p.selling_price) || parseFloat(p.price) || 0,
        current_stock: parseFloat(p.current_stock) || 0,
        min_stock: parseFloat(p.min_stock) || 20.0,
        packaging_type: p.packaging_type || 'Bottles',
        description: p.description || '',
        bom: p.bom || []
      }));

      const { error: pErr } = await this.supabase.from('products').upsert(productsToUpload);
      if (pErr) throw pErr;

      alert("Success! All local raw materials, products, and BOM recipes have been pushed to Supabase. They are now available on the mobile portal!");
    } catch (err) {
      console.error("Sync to cloud failed:", err);
      alert("Sync failed: " + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Push Laptop Data to Cloud Database`;
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==========================================
  // VENDOR DEBIT NOTES (DEFECTIVE GOODS RETURNS)
  // ==========================================

  openCreateDebitNoteModal() {
    const existingDns = this.db.debit_notes || [];
    const nextNo = existingDns.length + 1;
    const noInput = document.getElementById('dn-create-no');
    if (noInput) {
      noInput.value = `MFP-DN-26-${String(nextNo).padStart(3, '0')}`;
    }

    const dateInput = document.getElementById('dn-create-date');
    if (dateInput) {
      dateInput.value = new Date().toISOString().split('T')[0];
    }

    const invRefInput = document.getElementById('dn-create-invoice-ref');
    if (invRefInput) invRefInput.value = '';

    const vendorInput = document.getElementById('dn-create-vendor');
    if (vendorInput) vendorInput.value = '';

    const gstinInput = document.getElementById('dn-create-gstin');
    if (gstinInput) gstinInput.value = '';

    const addrInput = document.getElementById('dn-create-address');
    if (addrInput) addrInput.value = '';

    const reasonInput = document.getElementById('dn-create-reason');
    if (reasonInput) reasonInput.value = '';

    const notesInput = document.getElementById('dn-create-notes');
    if (notesInput) notesInput.value = '';

    // Populate datalist with known vendors/suppliers
    const datalist = document.getElementById('dn-create-vendor-datalist');
    if (datalist) {
      const vendorSet = new Set();
      (this.db.inwards || []).forEach(inw => { if (inw.supplier) vendorSet.add(inw.supplier); });
      (this.db.orders || []).forEach(ord => { if (ord.supplier) vendorSet.add(ord.supplier); });
      (this.db.debit_notes || []).forEach(dn => { if (dn.vendor_name) vendorSet.add(dn.vendor_name); });
      datalist.innerHTML = Array.from(vendorSet).map(v => `<option value="${this.escapeHtml(v)}"></option>`).join('');
    }

    // Initialize items array with first raw material
    const rawMaterials = this.db.raw_materials || [];
    const firstMat = rawMaterials[0] || null;
    this.desktopDebitItems = [{
      material_id: firstMat ? firstMat.id : '',
      material_name: firstMat ? firstMat.name : '',
      description: '',
      quantity: 1,
      unit: firstMat ? (firstMat.unit || 'pcs') : 'pcs',
      rate: firstMat ? (parseFloat(firstMat.average_price || 0) || 0) : 0,
      gst_rate: 18
    }];

    this.renderDesktopDebitItems();
    this.openModal('modal-create-debit-note');
  }

  onDesktopDebitVendorChange(val) {
    if (!val) return;
    const existing = (this.db.debit_notes || []).find(d => (d.vendor_name || '').toLowerCase() === val.toLowerCase());
    if (existing) {
      const gstinInput = document.getElementById('dn-create-gstin');
      const addrInput = document.getElementById('dn-create-address');
      if (gstinInput && !gstinInput.value && existing.vendor_gstin) {
        gstinInput.value = existing.vendor_gstin;
      }
      if (addrInput && !addrInput.value && existing.vendor_address) {
        addrInput.value = existing.vendor_address;
      }
    }
  }

  addDesktopDebitItemRow() {
    if (!Array.isArray(this.desktopDebitItems)) {
      this.desktopDebitItems = [];
    }
    const rawMaterials = this.db.raw_materials || [];
    const firstMat = rawMaterials[0] || null;
    this.desktopDebitItems.push({
      material_id: firstMat ? firstMat.id : '',
      material_name: firstMat ? firstMat.name : '',
      description: '',
      quantity: 1,
      unit: firstMat ? (firstMat.unit || 'pcs') : 'pcs',
      rate: firstMat ? (parseFloat(firstMat.average_price || 0) || 0) : 0,
      gst_rate: 18
    });
    this.renderDesktopDebitItems();
  }

  removeDesktopDebitItemRow(index) {
    if (this.desktopDebitItems.length > 1) {
      this.desktopDebitItems.splice(index, 1);
      this.renderDesktopDebitItems();
    } else {
      alert("At least one defective material row is required.");
    }
  }

  updateDesktopDebitItem(index, field, val) {
    if (!this.desktopDebitItems || !this.desktopDebitItems[index]) return;
    const item = this.desktopDebitItems[index];

    if (field === 'material_id') {
      item.material_id = val;
      const rawMaterials = this.db.raw_materials || [];
      const m = rawMaterials.find(x => x.id === val);
      if (m) {
        item.material_name = m.name;
        item.unit = m.unit || 'pcs';
        if (!item.rate || item.rate === 0) {
          item.rate = parseFloat(m.average_price || 0) || 0;
        }
      }
      this.renderDesktopDebitItems();
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

    const lineTotal = (item.quantity * item.rate) * (1 + (item.gst_rate || 0) / 100);
    const lineEl = document.getElementById(`dn-desktop-item-total-${index}`);
    if (lineEl) {
      lineEl.textContent = `₹ ${lineTotal.toFixed(2)}`;
    }

    let grandTotal = 0;
    this.desktopDebitItems.forEach(it => {
      const base = (it.quantity || 0) * (it.rate || 0);
      const tax = base * ((it.gst_rate || 0) / 100);
      grandTotal += (base + tax);
    });
    const totalBadge = document.getElementById('dn-create-grand-total-badge');
    if (totalBadge) {
      totalBadge.textContent = `Total: Rs. ${grandTotal.toFixed(2)}`;
    }
  }

  renderDesktopDebitItems() {
    const container = document.getElementById('dn-create-items-container');
    if (!container) return;
    container.innerHTML = '';

    const rawMaterials = this.db.raw_materials || [];
    let overallTotal = 0;

    this.desktopDebitItems.forEach((item, idx) => {
      const selectedMat = rawMaterials.find(m => m.id === item.material_id);
      const currentStock = selectedMat ? (parseFloat(selectedMat.current_stock || 0)) : 0;
      const matUnit = selectedMat ? (selectedMat.unit || 'pcs') : (item.unit || 'pcs');
      const baseAmt = (item.quantity || 0) * (item.rate || 0);
      const taxAmt = baseAmt * ((item.gst_rate || 0) / 100);
      const lineTotal = baseAmt + taxAmt;
      overallTotal += lineTotal;

      const row = document.createElement('div');
      row.className = 'custom-table-card';
      row.style.cssText = 'background:var(--bg-card); border:1px solid rgba(239,68,68,0.3); border-radius:6px; padding:0.75rem;';
      row.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem; padding-bottom:0.35rem; border-bottom:1px dashed var(--border-color);">
          <strong style="font-size:0.8rem; color:var(--color-danger);">
            <i class="fa-solid fa-circle-minus"></i> Defective Item #${idx + 1}
          </strong>
          <div style="display:flex; align-items:center; gap:0.75rem;">
            <span style="font-size:0.75rem; color:var(--text-dim);">Warehouse Stock: <strong style="color:var(--color-primary);">${currentStock} ${matUnit}</strong></span>
            ${this.desktopDebitItems.length > 1 ? `
              <button type="button" class="btn btn-secondary btn-sm" onclick="app.removeDesktopDebitItemRow(${idx})" style="padding:0.15rem 0.45rem; font-size:0.72rem; color:var(--color-danger);">
                <i class="fa-solid fa-trash-can"></i> Remove
              </button>
            ` : ''}
          </div>
        </div>

        <div class="form-row" style="margin-bottom:0.4rem;">
          <div class="form-group" style="flex:1.5;">
            <label style="font-size:0.75rem;">Raw Material (from Inventory) *</label>
            <select class="form-control" style="font-size:0.8rem;" onchange="app.updateDesktopDebitItem(${idx}, 'material_id', this.value)" required>
              <option value="">-- Select Raw Material --</option>
              ${rawMaterials.map(m => `
                <option value="${m.id}" ${m.id === item.material_id ? 'selected' : ''}>
                  ${this.escapeHtml(m.name)} (${m.code || 'RM'}) [${m.current_stock || 0} ${m.unit || 'pcs'}]
                </option>
              `).join('')}
            </select>
          </div>
          <div class="form-group" style="flex:1.5;">
            <label style="font-size:0.75rem;">Defect Details / Description</label>
            <input type="text" class="form-control" style="font-size:0.8rem;" placeholder="e.g. 28mm caps damaged / defective seal" value="${this.escapeHtml(item.description || '')}" oninput="app.updateDesktopDebitItem(${idx}, 'description', this.value)">
          </div>
        </div>

        <div class="form-row" style="margin-bottom:0.3rem;">
          <div class="form-group" style="flex:1;">
            <label style="font-size:0.75rem;">Defective Qty *</label>
            <input type="number" step="0.01" min="0.01" class="form-control" style="font-size:0.8rem;" value="${item.quantity || 1}" oninput="app.updateDesktopDebitItem(${idx}, 'quantity', this.value)" required>
          </div>
          <div class="form-group" style="flex:0.8;">
            <label style="font-size:0.75rem;">Unit</label>
            <input type="text" class="form-control" style="font-size:0.8rem;" value="${this.escapeHtml(item.unit || 'pcs')}" oninput="app.updateDesktopDebitItem(${idx}, 'unit', this.value)">
          </div>
          <div class="form-group" style="flex:1;">
            <label style="font-size:0.75rem;">Rate (Rs.) *</label>
            <input type="number" step="0.01" min="0" class="form-control" style="font-size:0.8rem;" value="${item.rate || 0}" oninput="app.updateDesktopDebitItem(${idx}, 'rate', this.value)" required>
          </div>
          <div class="form-group" style="flex:0.9;">
            <label style="font-size:0.75rem;">GST %</label>
            <select class="form-control" style="font-size:0.8rem;" onchange="app.updateDesktopDebitItem(${idx}, 'gst_rate', this.value)">
              <option value="0" ${item.gst_rate === 0 ? 'selected' : ''}>0%</option>
              <option value="5" ${item.gst_rate === 5 ? 'selected' : ''}>5%</option>
              <option value="12" ${item.gst_rate === 12 ? 'selected' : ''}>12%</option>
              <option value="18" ${item.gst_rate === 18 ? 'selected' : ''}>18%</option>
              <option value="28" ${item.gst_rate === 28 ? 'selected' : ''}>28%</option>
            </select>
          </div>
          <div class="form-group" style="flex:1.2; display:flex; flex-direction:column; justify-content:center; align-items:flex-end;">
            <label style="font-size:0.72rem; color:var(--text-dim); margin-bottom:2px;">Row Total (incl. GST)</label>
            <strong id="dn-desktop-item-total-${idx}" style="font-size:0.9rem; color:var(--color-danger);">₹ ${lineTotal.toFixed(2)}</strong>
          </div>
        </div>
      `;
      container.appendChild(row);
    });

    const totalBadge = document.getElementById('dn-create-grand-total-badge');
    if (totalBadge) {
      totalBadge.textContent = `Total: Rs. ${overallTotal.toFixed(2)}`;
    }
  }

  async handleDesktopDebitSubmit(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-submit-create-dn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Issuing Debit Note...`;
    }

    try {
      const dnNo = document.getElementById('dn-create-no').value.trim();
      const date = document.getElementById('dn-create-date').value || new Date().toISOString().split('T')[0];
      const invRef = document.getElementById('dn-create-invoice-ref').value.trim();
      const vendorName = document.getElementById('dn-create-vendor').value.trim();
      const vendorGstin = document.getElementById('dn-create-gstin').value.trim();
      const vendorAddress = document.getElementById('dn-create-address').value.trim();
      const reason = document.getElementById('dn-create-reason').value.trim();
      const deductStock = document.getElementById('dn-create-deduct-stock').checked;
      const notes = document.getElementById('dn-create-notes').value.trim();

      if (!dnNo) {
        alert("Please provide a Debit Note Number.");
        return;
      }
      if (!vendorName) {
        alert("Please provide the Vendor / Supplier name.");
        return;
      }
      if (!this.desktopDebitItems || this.desktopDebitItems.length === 0) {
        alert("Please add at least one defective item.");
        return;
      }

      let subtotal = 0;
      let taxAmount = 0;
      const formattedItems = [];

      for (const it of this.desktopDebitItems) {
        const qty = parseFloat(it.quantity) || 0;
        const rate = parseFloat(it.rate) || 0;
        const gstRate = parseFloat(it.gst_rate) || 0;
        if (qty <= 0) {
          alert(`Please enter a valid defective quantity for ${it.material_name || 'item'}.`);
          return;
        }

        const base = qty * rate;
        const tax = base * (gstRate / 100);
        const lineTot = base + tax;
        subtotal += base;
        taxAmount += tax;

        formattedItems.push({
          material_id: it.material_id,
          material_name: it.material_name || 'Defective Item',
          description: it.description || '',
          quantity: qty,
          unit: it.unit || 'pcs',
          rate: rate,
          gst_rate: gstRate,
          taxable_amount: base,
          tax_amount: tax,
          line_total: lineTot
        });

        // Deduct raw material stock if checked
        if (deductStock && it.material_id) {
          const mat = (this.db.raw_materials || []).find(m => m.id === it.material_id);
          if (mat) {
            mat.current_stock = Math.max(0, (parseFloat(mat.current_stock || 0) - qty));
          }
        }
      }

      const grandTotal = subtotal + taxAmount;
      const debitNoteId = 'dn_' + Date.now();

      const debitNoteRecord = {
        id: debitNoteId,
        debit_note_no: dnNo,
        date: date,
        created_at: new Date().toISOString(),
        vendor_name: vendorName,
        vendor_gstin: vendorGstin,
        vendor_address: vendorAddress,
        original_invoice_ref: invRef,
        reason: reason,
        items: formattedItems,
        subtotal: subtotal,
        tax_amount: taxAmount,
        grand_total: grandTotal,
        deduct_stock: deductStock,
        notes: notes
      };

      if (!this.db.debit_notes) this.db.debit_notes = [];
      this.db.debit_notes.unshift(debitNoteRecord);

      // Cloud sync with Supabase if online
      if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
        try {
          await this.supabase.from('debit_notes').insert([debitNoteRecord]);
        } catch (cloudErr) {
          console.error("Cloud sync error inserting debit note:", cloudErr);
        }
      }

      this.saveDb();
      this.closeModal('modal-create-debit-note');
      this.renderDebitNotesTable();
      this.refreshAllViews();

      // Open the signed slip right away
      this.openDesktopDebitSlip(debitNoteId);
    } catch (err) {
      console.error("Error creating debit note:", err);
      alert("Failed to issue debit note: " + err.message);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<i class="fa-solid fa-check"></i> Issue & Generate Signed Debit Note`;
      }
    }
  }

  renderDebitNotesTable() {
    const tbody = document.getElementById('debit-notes-table-body');
    if (!tbody) return;

    const searchInput = document.getElementById('dn-desktop-search');
    const q = searchInput ? searchInput.value.trim().toLowerCase() : '';

    const list = this.db.debit_notes || [];
    const filtered = list.filter(dn => {
      if (!q) return true;
      const dnNo = (dn.debit_note_no || '').toLowerCase();
      const vendor = (dn.vendor_name || '').toLowerCase();
      const reason = (dn.reason || '').toLowerCase();
      return dnNo.includes(q) || vendor.includes(q) || reason.includes(q);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="empty-list-text">
            ${q ? 'No debit notes match your search query.' : 'No vendor debit notes recorded yet. Issue one from the Daily Mobile Console.'}
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.map(dn => {
      let itemsSummary = '';
      if (Array.isArray(dn.items) && dn.items.length > 0) {
        itemsSummary = dn.items.map(it => `${this.escapeHtml(it.material_name || it.item_name || 'Item')} (${it.quantity} ${it.unit || 'pcs'})`).join(', ');
      } else {
        itemsSummary = 'Defective Goods Return';
      }

      const amt = parseFloat(dn.grand_total || dn.total_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
      return `
        <tr>
          <td>${dn.date || (dn.created_at ? dn.created_at.split('T')[0] : 'N/A')}</td>
          <td><strong style="color:var(--color-danger);">${this.escapeHtml(dn.debit_note_no || 'DN')}</strong></td>
          <td>
            <strong>${this.escapeHtml(dn.vendor_name || 'Vendor')}</strong>
            ${dn.vendor_gstin ? `<div class="td-muted font-xs">GSTIN: ${this.escapeHtml(dn.vendor_gstin)}</div>` : ''}
          </td>
          <td>${this.escapeHtml(dn.reason || 'Defective material')}</td>
          <td>${itemsSummary}</td>
          <td><strong style="color:var(--color-danger);">Rs. ${amt}</strong></td>
          <td style="text-align: right; white-space: nowrap;">
            <button class="btn btn-secondary btn-sm" onclick="app.openDesktopDebitSlip('${dn.id}')" title="View & Download Official Signed PDF">
              <i class="fa-solid fa-file-pdf" style="color:var(--color-primary);"></i> View Slip
            </button>
            <button class="btn btn-danger-sm btn-sm" onclick="app.deleteDesktopDebitNote('${dn.id}')" title="Delete Debit Note" style="margin-left:4px;">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  async openDesktopDebitSlip(id) {
    const dn = (this.db.debit_notes || []).find(d => d.id === id);
    if (!dn) {
      alert("Debit Note record not found.");
      return;
    }

    this.activeDesktopDebitSlip = dn;
    const body = document.getElementById('desktop-debit-slip-body');
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
        <div class="invoice-sheet" id="desktop-debit-slip-sheet">
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
            <div class="inv-grid-cell" style="flex: 1.5; border-right: 1px solid #000000; padding: 6px;">
              <div style="font-weight: bold; font-size: 13px;">MORELLA FARMPRO LLP</div>
              <div style="font-size: 11.5px; line-height: 1.35; margin-top: 4px;">
                Survey No 544 Dahad village, Umbergaon, Valsad, Gujarat Pin code 396170<br>
                <strong>Email:</strong> info@mfpco.in
              </div>
            </div>
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

    this.openModal('modal-desktop-debit-slip');
  }

  async downloadDesktopDebitSlipPdf() {
    const btn = document.querySelector('#modal-desktop-debit-slip .btn-primary');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Generating PDF...`;
    }

    try {
      const el = document.getElementById('desktop-debit-slip-sheet');
      if (!el) {
        alert("Slip sheet element not found.");
        return;
      }
      const dnNo = (this.activeDesktopDebitSlip && this.activeDesktopDebitSlip.debit_note_no) ? this.activeDesktopDebitSlip.debit_note_no : 'Debit_Note';
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

  async deleteDesktopDebitNote(id) {
    if (!confirm("Are you sure you want to delete this Debit Note? This action cannot be undone.")) return;

    try {
      if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
        await this.supabase.from('debit_notes').delete().eq('id', id);
      }
    } catch (e) {
      console.error("Error deleting debit note in cloud:", e);
    }

    this.db.debit_notes = (this.db.debit_notes || []).filter(d => d.id !== id);
    this.db.transactions = (this.db.transactions || []).filter(t => t.id !== 'tx_dn_' + id);
    this.saveDb();
    this.renderDebitNotesTable();
    this.renderHistory();
    alert("Debit Note deleted.");
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

  // ==========================================
  // EXCEL / CSV VARIABLE RANGE EXPORT ENGINE
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

    // Reset selects
    prodSelect.innerHTML = '<option value="all">All Products / Materials</option>';
    secSelect.innerHTML = '<option value="all">All Records</option>';
    if (partyInput) partyInput.value = '';

    if (module === 'raw_materials') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Raw Material Range';
      prodSelect.innerHTML = '<option value="all">All Raw Materials</option>' +
        (this.db.raw_materials || []).map(m => `<option value="${m.id || m.code}">${this.escapeHtml(m.name)} (${m.code || 'No Code'})</option>`).join('');

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
        (this.db.products || []).map(p => `<option value="${p.id || p.sku}">${this.escapeHtml(p.name)} (${p.sku || 'No SKU'})</option>`).join('');

      if (secLabel) secLabel.textContent = 'Packaging Filter';
      const uniquePack = Array.from(new Set((this.db.products || []).map(p => p.packaging).filter(Boolean)));
      secSelect.innerHTML = '<option value="all">All Packaging Types</option>' +
        uniquePack.map(pkg => `<option value="${this.escapeHtml(pkg)}">${this.escapeHtml(pkg)}</option>`).join('');

      if (partyGroup) partyGroup.style.display = 'none';

    } else if (module === 'finished_goods') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Finished Product Range';
      prodSelect.innerHTML = '<option value="all">All Finished Goods</option>' +
        (this.db.products || []).map(p => `<option value="${p.id || p.sku}">${this.escapeHtml(p.name)} (${p.sku || 'No SKU'})</option>`).join('');

      if (secLabel) secLabel.textContent = 'Category Filter';
      const uniqueCats = Array.from(new Set((this.db.products || []).map(p => p.category).filter(Boolean)));
      secSelect.innerHTML = '<option value="all">All Categories</option>' +
        uniqueCats.map(cat => `<option value="${this.escapeHtml(cat)}">${this.escapeHtml(cat)}</option>`).join('') +
        '<option value="low_stock">Low Stock / Reorder Needed</option>';

      if (partyGroup) partyGroup.style.display = 'none';

    } else if (module === 'purchase_inwards') {
      if (dateContainer) dateContainer.style.display = 'block';
      if (prodLabel) prodLabel.textContent = 'Raw Material Range';
      prodSelect.innerHTML = '<option value="all">All Inward Materials</option>' +
        (this.db.raw_materials || []).map(m => `<option value="${m.id || m.code}">${this.escapeHtml(m.name)} (${m.code || 'No Code'})</option>`).join('');

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
        (this.db.products || []).map(p => `<option value="${p.id || p.sku}">${this.escapeHtml(p.name)} (${p.sku || 'No SKU'})</option>`).join('');

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
        (this.db.raw_materials || []).map(m => `<option value="${m.id || m.code}">${this.escapeHtml(m.name)} (${m.code || 'No Code'})</option>`).join('');

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

    const dateSuffix = fromDate || toDate 
      ? `_${fromDate || 'Start'}_to_${toDate || 'Present'}`
      : `_${new Date().toISOString().split('T')[0]}`;

    // Helper for date filtering
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

      let rawList = (this.db.raw_materials || []).slice();

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

      const rawProds = (this.db.productions || []).slice();
      const txProds = (this.db.transactions || []).filter(t => t.type === 'production');

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

      let prodList = (this.db.products || []).slice();

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

      let inwList = (this.db.inwards || []).slice();

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

        const mat = (this.db.raw_materials || []).find(m => m.id === inw.material_id || m.name === inw.material_name);

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

      let outwList = (this.db.outwards || []).slice();

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

        const prod = (this.db.products || []).find(p => p.id === outw.product_id || p.name === outw.product_name);

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

      let dnList = (this.db.debit_notes || []).slice();

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

        // Auto-fit column widths
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

    // CSV Fallback or explicit CSV export
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

  // ==========================================
  // INVENTORY RECONCILIATION & CUTOVER ENGINE
  // ==========================================

  initReconciliationView() {
    const cutDateInput = document.getElementById('rec-cutover-date');
    if (cutDateInput) {
      cutDateInput.value = this.reconciliation.cutoverDate || '2026-04-01';
    }
    const wastageDisplay = document.getElementById('rec-wastage-display');
    if (wastageDisplay) {
      wastageDisplay.textContent = `${this.db.settings?.default_wastage || 1.5}%`;
    }

    this.computeReconciliationMatrix();
  }

  saveReconciliationDraft() {
    try {
      localStorage.setItem('erp_reconciliation_draft', JSON.stringify(this.reconciliation));
    } catch (e) {
      console.warn("Could not save reconciliation draft to localStorage:", e);
    }
  }

  switchReconciliationSubtab(tabKey) {
    this.reconciliation.activeSubtab = tabKey;
    const tabs = ['rm', 'fg', 'purchases', 'sales'];
    tabs.forEach(t => {
      const btn = document.getElementById(`rec-subtab-btn-${t}`);
      const pane = document.getElementById(`rec-subtab-pane-${t}`);
      if (btn) btn.classList.toggle('active', t === tabKey);
      if (pane) pane.style.display = (t === tabKey) ? 'block' : 'none';
    });
    this.renderReconciliationMatrixTables();
  }

  setReconciliationZeroOpening() {
    this.reconciliation.openingStockRM = {};
    this.reconciliation.openingStockFG = {};
    (this.db.raw_materials || []).forEach(m => {
      this.reconciliation.openingStockRM[m.id || m.code] = { qty: 0, rate: m.average_price || 0 };
    });
    (this.db.products || []).forEach(p => {
      this.reconciliation.openingStockFG[p.sku || p.id] = { qty: 0, rate: p.selling_price || 0 };
    });
    this.saveReconciliationDraft();
    this.computeReconciliationMatrix();
    alert("Opening Stock set to 0 as of 1st April 2026. All inventory will be derived strictly from subsequent purchases and sales.");
  }

  loadExistingPurchasesSinceDate() {
    const cutDate = document.getElementById('rec-cutover-date')?.value || this.reconciliation.cutoverDate || '2026-04-01';
    const matching = (this.db.inwards || []).filter(inw => inw.date >= cutDate);
    if (matching.length === 0) {
      alert(`No inward purchase bills found in live database on or after ${cutDate}.`);
      return;
    }

    const seen = new Set((this.reconciliation.purchases || []).map(p => `${p.invoice_no}_${p.material_id}_${p.date}`));
    let added = 0;

    matching.forEach(inw => {
      const key = `${inw.invoice_no || inw.bill_no}_${inw.material_id}_${inw.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        this.reconciliation.purchases.push({
          date: inw.date,
          invoice_no: inw.invoice_no || inw.bill_no || 'PUR-LIVE',
          supplier: inw.supplier || inw.vendor || 'Supplier',
          material_id: inw.material_id,
          material_code: inw.material_code,
          material_name: inw.material_name,
          quantity: parseFloat(inw.quantity) || 0,
          unit: inw.unit || 'kg',
          rate: parseFloat(inw.rate || inw.price) || 0,
          total: parseFloat(inw.total_amount) || ((parseFloat(inw.quantity)||0) * (parseFloat(inw.rate)||0))
        });
        added++;
      }
    });

    this.saveReconciliationDraft();
    this.computeReconciliationMatrix();
    alert(`Loaded ${added} purchase bill records from live database since ${cutDate}!`);
  }

  loadExistingSalesSinceDate() {
    const cutDate = document.getElementById('rec-cutover-date')?.value || this.reconciliation.cutoverDate || '2026-04-01';
    const matching = (this.db.outwards || []).filter(outw => outw.date >= cutDate);
    if (matching.length === 0) {
      alert(`No sales dispatches found in live database on or after ${cutDate}.`);
      return;
    }

    const seen = new Set((this.reconciliation.sales || []).map(s => `${s.invoice_no}_${s.product_id}_${s.date}`));
    let added = 0;

    matching.forEach(outw => {
      const key = `${outw.invoice_no || outw.dispatch_no}_${outw.product_id}_${outw.date}`;
      if (!seen.has(key)) {
        seen.add(key);
        this.reconciliation.sales.push({
          date: outw.date,
          invoice_no: outw.invoice_no || outw.dispatch_no || 'SAL-LIVE',
          customer: outw.customer || outw.client || 'Customer',
          product_id: outw.product_id,
          sku: outw.product_sku,
          product_name: outw.product_name,
          packaging: outw.packaging || 'Standard',
          quantity: parseFloat(outw.quantity) || 0,
          rate: parseFloat(outw.rate || outw.selling_price) || 0,
          total: parseFloat(outw.total_amount) || ((parseFloat(outw.quantity)||0) * (parseFloat(outw.rate)||0))
        });
        added++;
      }
    });

    this.saveReconciliationDraft();
    this.computeReconciliationMatrix();
    alert(`Loaded ${added} sales invoice records from live database since ${cutDate}!`);
  }

  loadLiveStockAsPhysical() {
    (this.db.products || []).forEach(p => {
      this.reconciliation.physicalCountsFG[p.sku || p.id] = parseFloat(p.current_stock) || 0;
    });
    (this.db.raw_materials || []).forEach(m => {
      this.reconciliation.physicalCountsRM[m.id || m.code] = parseFloat(m.current_stock) || 0;
    });

    this.saveReconciliationDraft();
    this.computeReconciliationMatrix();
    alert("Current live ERP stock figures copied into Physical Count columns as a baseline.");
  }

  async handleReconciliationFileUpload(type, fileOrFileList) {
    if (!fileOrFileList) return;
    const fileList = (fileOrFileList instanceof FileList || Array.isArray(fileOrFileList)) 
      ? Array.from(fileOrFileList) 
      : [fileOrFileList];

    if (fileList.length === 0) return;

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const name = file.name.toLowerCase();

      if (name.endsWith('.pdf')) {
        await this.parseReconciliationPDF(type, file);
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
        await this.parseReconciliationExcel(type, file);
      } else {
        alert(`Unsupported file format for ${file.name}. Please upload .xlsx, .xls, .csv, or .pdf`);
      }
    }

    this.saveReconciliationDraft();
    this.computeReconciliationMatrix();
  }

  async parseReconciliationPDF(type, file) {
    try {
      const rawText = await this.parsePDFText(file);
      if (type === 'purchases') {
        const ext = this.heuristicsExtractPurchase(rawText);
        (ext.items || []).forEach(it => {
          this.reconciliation.purchases.push({
            date: ext.date || new Date().toISOString().split('T')[0],
            invoice_no: ext.invoice_no || file.name.replace(/\.pdf$/i, ''),
            supplier: 'Supplier (' + file.name.replace(/\.pdf$/i, '') + ')',
            material_id: '',
            material_code: '',
            material_name: it.name || 'Purchased Material',
            quantity: it.qty || 1,
            unit: 'kg',
            rate: it.rate || 0,
            total: (it.qty || 1) * (it.rate || 0)
          });
        });
      } else if (type === 'sales') {
        const ext = this.heuristicsExtractSale(rawText, file.name);
        (ext.products || []).forEach(pr => {
          this.reconciliation.sales.push({
            date: ext.date || new Date().toISOString().split('T')[0],
            invoice_no: ext.invoice_no || file.name.replace(/\.pdf$/i, ''),
            customer: ext.customer || 'Customer',
            product_id: pr.id || '',
            sku: pr.sku || '',
            product_name: pr.name || 'Finished Product',
            packaging: pr.packaging || 'Standard',
            quantity: pr.quantity || 1,
            rate: pr.rate || pr.selling_price || 0,
            total: (pr.quantity || 1) * (pr.rate || 0)
          });
        });
      }
    } catch (e) {
      console.error("PDF parse error:", e);
      alert(`Could not parse ${file.name}: ` + e.message);
    }
  }

  async parseReconciliationExcel(type, file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          
          workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const json = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
            if (json.length === 0) return;

            json.forEach(row => {
              // Normalize keys
              const nRow = {};
              Object.keys(row).forEach(k => {
                nRow[k.trim().toLowerCase()] = row[k];
              });

              const getVal = (aliases) => {
                for (let a of aliases) {
                  if (nRow[a] !== undefined && nRow[a] !== '') return nRow[a];
                }
                return '';
              };

              const code = String(getVal(['material code', 'code', 'product sku', 'sku', 'item code', 'rm code'])).trim();
              const name = String(getVal(['material name', 'name', 'product name', 'item name', 'description', 'item'])).trim();
              const qty = parseFloat(getVal(['quantity', 'qty', 'opening stock', 'opening stock qty', 'physical count', 'physical stock', 'quantity sold', 'inward qty'])) || 0;
              const rate = parseFloat(getVal(['rate', 'price', 'unit rate', 'unit price', 'avg price', 'average rate', 'selling rate'])) || 0;
              const total = parseFloat(getVal(['total', 'amount', 'total amount', 'net amount'])) || (qty * rate);
              const invoiceNo = String(getVal(['invoice', 'invoice no', 'bill', 'bill no', 'inv no', 'dispatch no', 'ref'])).trim();
              const party = String(getVal(['supplier', 'supplier name', 'vendor', 'vendor name', 'customer', 'customer name', 'party'])).trim();
              const dateVal = String(getVal(['date', 'invoice date', 'bill date', 'dispatch date'])).trim();
              const packaging = String(getVal(['packaging', 'pack', 'type', 'packaging type'])).trim();
              const unit = String(getVal(['unit', 'uom'])).trim() || 'kg';

              if (type === 'opening') {
                const isProd = /sku|product|bottle|pouch|sachet/i.test(sheetName) || (code && code.startsWith('FG-')) || (this.db.products || []).some(p => p.sku === code || p.name.toLowerCase() === name.toLowerCase());
                if (isProd) {
                  const key = code || name;
                  if (key) this.reconciliation.openingStockFG[key] = { qty, rate };
                } else {
                  const key = code || name;
                  if (key) this.reconciliation.openingStockRM[key] = { qty, rate };
                }
              } else if (type === 'purchases') {
                if (qty > 0 || total > 0) {
                  this.reconciliation.purchases.push({
                    date: dateVal || new Date().toISOString().split('T')[0],
                    invoice_no: invoiceNo || 'PUR-IMP',
                    supplier: party || 'Supplier',
                    material_code: code,
                    material_name: name || code,
                    quantity: qty,
                    unit: unit,
                    rate: rate,
                    total: total
                  });
                }
              } else if (type === 'sales') {
                if (qty > 0 || total > 0) {
                  this.reconciliation.sales.push({
                    date: dateVal || new Date().toISOString().split('T')[0],
                    invoice_no: invoiceNo || 'SAL-IMP',
                    customer: party || 'Customer',
                    sku: code,
                    product_name: name || code,
                    packaging: packaging || 'Standard',
                    quantity: qty,
                    rate: rate,
                    total: total
                  });
                }
              } else if (type === 'physical') {
                const isProd = /finished|fg|product/i.test(sheetName) || (code && code.startsWith('FG-')) || (this.db.products || []).some(p => p.sku === code || p.name.toLowerCase() === name.toLowerCase());
                const key = code || name;
                if (key) {
                  if (isProd) {
                    this.reconciliation.physicalCountsFG[key] = qty;
                  } else {
                    this.reconciliation.physicalCountsRM[key] = qty;
                  }
                }
              }
            });
          });
          resolve();
        } catch (err) {
          console.error("Excel parse error:", err);
          alert(`Error reading Excel file ${file.name}: ` + err.message);
          resolve();
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  computeReconciliationMatrix() {
    const cutoverDate = document.getElementById('rec-cutover-date')?.value || this.reconciliation.cutoverDate || '2026-04-01';
    this.reconciliation.cutoverDate = cutoverDate;
    const wastage = parseFloat(this.db.settings?.default_wastage) || 1.5;
    const wasteFactor = 1 + (wastage / 100);

    // 1. Raw Materials Master Map
    const rmMap = {};
    (this.db.raw_materials || []).forEach(m => {
      const key = m.id || m.code;
      rmMap[key] = {
        id: m.id,
        code: m.code || '',
        name: m.name || '',
        unit: m.unit || 'kg',
        avgPrice: parseFloat(m.average_price || m.last_price || 0),
        openingQty: 0,
        purchasedQty: 0,
        purchasedVal: 0,
        consumedInSales: 0,
        consumedInFG: 0,
        calculatedStock: 0,
        physicalCount: null,
        variance: null,
        finalStock: 0
      };
    });

    // Opening Stock RM Map
    Object.keys(this.reconciliation.openingStockRM || {}).forEach(k => {
      const op = this.reconciliation.openingStockRM[k];
      const mat = (this.db.raw_materials || []).find(m => m.id === k || m.code === k || m.name.toLowerCase() === k.toLowerCase());
      if (mat) {
        const key = mat.id || mat.code;
        if (rmMap[key]) {
          rmMap[key].openingQty = op.qty || 0;
          if (op.rate) rmMap[key].avgPrice = op.rate;
        }
      }
    });

    // Purchases Inward Aggregation
    let totalPurchasesVal = 0;
    (this.reconciliation.purchases || []).forEach(pur => {
      const qty = parseFloat(pur.quantity) || 0;
      const rate = parseFloat(pur.rate) || 0;
      const total = parseFloat(pur.total) || (qty * rate);
      totalPurchasesVal += total;

      const mat = (this.db.raw_materials || []).find(m => 
        (pur.material_id && m.id === pur.material_id) || 
        (pur.material_code && m.code === pur.material_code) || 
        (pur.material_name && m.name.toLowerCase() === pur.material_name.toLowerCase())
      );

      if (mat) {
        const key = mat.id || mat.code;
        if (rmMap[key]) {
          rmMap[key].purchasedQty += qty;
          rmMap[key].purchasedVal += total;
          if (rate > 0) rmMap[key].avgPrice = rate;
        }
      }
    });

    // 2. Finished Goods Master Map
    const fgMap = {};
    (this.db.products || []).forEach(p => {
      const key = p.sku || p.id;
      fgMap[key] = {
        id: p.id,
        sku: p.sku || '',
        name: p.name || '',
        packaging: p.packaging || '',
        sellingPrice: parseFloat(p.selling_price || 0),
        openingQty: 0,
        soldQty: 0,
        physicalCount: null,
        calculatedStock: 0,
        finalStock: 0,
        bom: p.bom || []
      };
    });

    // Opening Stock FG Map
    Object.keys(this.reconciliation.openingStockFG || {}).forEach(k => {
      const op = this.reconciliation.openingStockFG[k];
      const prod = (this.db.products || []).find(p => p.sku === k || p.id === k || p.name.toLowerCase() === k.toLowerCase());
      if (prod) {
        const key = prod.sku || prod.id;
        if (fgMap[key]) {
          fgMap[key].openingQty = op.qty || 0;
          if (op.rate) fgMap[key].sellingPrice = op.rate;
        }
      }
    });

    // Sales Aggregation & BOM Explosion
    let totalSalesVal = 0;
    let totalSalesUnits = 0;
    (this.reconciliation.sales || []).forEach(sal => {
      const qty = parseFloat(sal.quantity) || 0;
      const rate = parseFloat(sal.rate) || 0;
      const total = parseFloat(sal.total) || (qty * rate);
      totalSalesVal += total;
      totalSalesUnits += qty;

      const prod = (this.db.products || []).find(p => 
        (sal.sku && p.sku === sal.sku) || 
        (sal.product_id && p.id === sal.product_id) || 
        (sal.product_name && p.name.toLowerCase() === sal.product_name.toLowerCase())
      );

      if (prod) {
        const key = prod.sku || prod.id;
        if (fgMap[key]) {
          fgMap[key].soldQty += qty;
        }

        // BOM explosion for RM consumed in goods sold
        if (Array.isArray(prod.bom)) {
          prod.bom.forEach(recipe => {
            const mat = (this.db.raw_materials || []).find(m => m.id === recipe.material_id);
            if (mat) {
              const rKey = mat.id || mat.code;
              if (rmMap[rKey]) {
                const waste = 1 + ((parseFloat(recipe.wastage_percentage) || wastage) / 100);
                const consumed = qty * (parseFloat(recipe.quantity) || 0) * waste;
                rmMap[rKey].consumedInSales += consumed;
              }
            }
          });
        }
      }
    });

    // Physical Counts for Finished Goods
    Object.keys(this.reconciliation.physicalCountsFG || {}).forEach(k => {
      const cnt = parseFloat(this.reconciliation.physicalCountsFG[k]) || 0;
      const prod = (this.db.products || []).find(p => p.sku === k || p.id === k || p.name.toLowerCase() === k.toLowerCase());
      if (prod) {
        const key = prod.sku || prod.id;
        if (fgMap[key]) {
          fgMap[key].physicalCount = cnt;
        }
      }
    });

    // Physical Counts for Raw Materials
    Object.keys(this.reconciliation.physicalCountsRM || {}).forEach(k => {
      const cnt = parseFloat(this.reconciliation.physicalCountsRM[k]);
      const mat = (this.db.raw_materials || []).find(m => m.id === k || m.code === k || m.name.toLowerCase() === k.toLowerCase());
      if (mat) {
        const key = mat.id || mat.code;
        if (rmMap[key] && !isNaN(cnt)) {
          rmMap[key].physicalCount = cnt;
        }
      }
    });

    // Embodied RM in Current Finished Goods Stock on Hand
    Object.keys(fgMap).forEach(key => {
      const item = fgMap[key];
      const curFG = (item.physicalCount !== null) ? item.physicalCount : 0;
      if (curFG > 0 && Array.isArray(item.bom)) {
        item.bom.forEach(recipe => {
          const mat = (this.db.raw_materials || []).find(m => m.id === recipe.material_id);
          if (mat) {
            const rKey = mat.id || mat.code;
            if (rmMap[rKey]) {
              const waste = 1 + ((parseFloat(recipe.wastage_percentage) || wastage) / 100);
              const embodied = curFG * (parseFloat(recipe.quantity) || 0) * waste;
              rmMap[rKey].consumedInFG += embodied;
            }
          }
        });
      }
    });

    // Compute Net Calculated Balances
    let totalRMValuation = 0;
    let totalRMCount = 0;
    let totalRMConsumedVal = 0;

    Object.keys(rmMap).forEach(key => {
      const m = rmMap[key];
      m.consumedInSales = Math.round(m.consumedInSales * 1000) / 1000;
      m.consumedInFG = Math.round(m.consumedInFG * 1000) / 1000;
      
      // User formula: Balance Purchase - less current stock and sold stock = Current Inventory in Hand
      m.calculatedStock = Math.round((m.openingQty + m.purchasedQty - m.consumedInSales - m.consumedInFG) * 1000) / 1000;

      if (this.reconciliation.finalOverridesRM && this.reconciliation.finalOverridesRM[key] !== undefined) {
        m.finalStock = parseFloat(this.reconciliation.finalOverridesRM[key]);
      } else {
        m.finalStock = m.calculatedStock;
      }

      if (m.physicalCount !== null) {
        m.variance = Math.round((m.physicalCount - m.calculatedStock) * 1000) / 1000;
      }

      if (m.finalStock > 0) {
        totalRMCount++;
        totalRMValuation += m.finalStock * m.avgPrice;
      }
      totalRMConsumedVal += (m.consumedInSales + m.consumedInFG) * m.avgPrice;
    });

    let totalFGUnitsInHand = 0;
    let totalFGValuation = 0;
    Object.keys(fgMap).forEach(key => {
      const p = fgMap[key];
      p.calculatedStock = Math.round((p.openingQty - p.soldQty) * 100) / 100;

      if (this.reconciliation.finalOverridesFG && this.reconciliation.finalOverridesFG[key] !== undefined) {
        p.finalStock = parseFloat(this.reconciliation.finalOverridesFG[key]);
      } else {
        p.finalStock = (p.physicalCount !== null && p.physicalCount !== undefined) ? p.physicalCount : 0;
      }

      totalFGUnitsInHand += p.finalStock;
      totalFGValuation += p.finalStock * p.sellingPrice;
    });

    // Store in state cache for rendering and export
    this.reconciliation.rmCalculated = rmMap;
    this.reconciliation.fgCalculated = fgMap;
    this.reconciliation.kpis = {
      purchasesVal: totalPurchasesVal,
      purchasesQty: this.reconciliation.purchases.length,
      salesVal: totalSalesVal,
      salesQty: totalSalesUnits,
      consumedVal: totalRMConsumedVal,
      rmBalanceVal: totalRMValuation,
      rmCount: totalRMCount,
      fgUnitsInHand: totalFGUnitsInHand,
      fgValuation: totalFGValuation
    };

    this.renderReconciliationUI();
  }

  renderReconciliationUI() {
    const kpis = this.reconciliation.kpis || {};
    
    // 1. KPI Badges
    const elPurVal = document.getElementById('rec-kpi-purchases-val');
    const elPurQty = document.getElementById('rec-kpi-purchases-qty');
    if (elPurVal) elPurVal.textContent = `Rs. ${(kpis.purchasesVal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elPurQty) elPurQty.textContent = `${kpis.purchasesQty || 0} bill entries`;

    const elSalVal = document.getElementById('rec-kpi-sales-val');
    const elSalQty = document.getElementById('rec-kpi-sales-qty');
    if (elSalVal) elSalVal.textContent = `Rs. ${(kpis.salesVal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elSalQty) elSalQty.textContent = `${(kpis.salesQty || 0).toLocaleString('en-IN')} units sold`;

    const elConVal = document.getElementById('rec-kpi-consumed-val');
    if (elConVal) elConVal.textContent = `Rs. ${(kpis.consumedVal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const elRmVal = document.getElementById('rec-kpi-rm-balance-val');
    const elRmCnt = document.getElementById('rec-kpi-rm-count');
    if (elRmVal) elRmVal.textContent = `Rs. ${(kpis.rmBalanceVal || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (elRmCnt) elRmCnt.textContent = `${kpis.rmCount || 0} materials in hand`;

    const elFgVal = document.getElementById('rec-kpi-fg-balance-val');
    const elFgValuation = document.getElementById('rec-kpi-fg-valuation');
    if (elFgVal) elFgVal.textContent = `${(kpis.fgUnitsInHand || 0).toLocaleString('en-IN')} units`;
    if (elFgValuation) elFgValuation.textContent = `Valuation: Rs. ${(kpis.fgValuation || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // 2. Feed Badges
    const opCnt = Object.keys(this.reconciliation.openingStockRM || {}).length + Object.keys(this.reconciliation.openingStockFG || {}).length;
    const badgeOp = document.getElementById('rec-opening-badge');
    if (badgeOp) {
      badgeOp.textContent = `${opCnt} items loaded`;
      badgeOp.classList.toggle('active', opCnt > 0);
    }

    const purCnt = (this.reconciliation.purchases || []).length;
    const badgePur = document.getElementById('rec-purchases-badge');
    if (badgePur) {
      badgePur.textContent = `${purCnt} bills loaded`;
      badgePur.classList.toggle('active', purCnt > 0);
    }

    const salCnt = (this.reconciliation.sales || []).length;
    const badgeSal = document.getElementById('rec-sales-badge');
    if (badgeSal) {
      badgeSal.textContent = `${salCnt} invoices loaded`;
      badgeSal.classList.toggle('active', salCnt > 0);
    }

    const phyCnt = Object.keys(this.reconciliation.physicalCountsFG || {}).length + Object.keys(this.reconciliation.physicalCountsRM || {}).length;
    const badgePhy = document.getElementById('rec-physical-badge');
    if (badgePhy) {
      badgePhy.textContent = `${phyCnt} items counted`;
      badgePhy.classList.toggle('active', phyCnt > 0);
    }

    // 3. Tab Counter Labels
    const rmTotal = Object.keys(this.reconciliation.rmCalculated || {}).length;
    const fgTotal = Object.keys(this.reconciliation.fgCalculated || {}).length;
    const elTabRm = document.getElementById('rec-tab-rm-count');
    const elTabFg = document.getElementById('rec-tab-fg-count');
    const elTabPur = document.getElementById('rec-tab-pur-count');
    const elTabSal = document.getElementById('rec-tab-sal-count');
    if (elTabRm) elTabRm.textContent = rmTotal;
    if (elTabFg) elTabFg.textContent = fgTotal;
    if (elTabPur) elTabPur.textContent = purCnt;
    if (elTabSal) elTabSal.textContent = salCnt;

    this.renderReconciliationMatrixTables();
  }

  renderReconciliationMatrixTables() {
    const filter = (document.getElementById('rec-matrix-search')?.value || '').trim().toLowerCase();
    const activeTab = this.reconciliation.activeSubtab || 'rm';

    if (activeTab === 'rm') {
      const tbody = document.getElementById('rec-matrix-rm-tbody');
      if (!tbody) return;
      const rmMap = this.reconciliation.rmCalculated || {};
      const keys = Object.keys(rmMap);

      if (keys.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="empty-list-text" style="text-align:center; padding:2rem;">No Raw Materials found in database. Add materials in Raw Materials tab.</td></tr>`;
        return;
      }

      const rowsHtml = keys.filter(k => {
        if (!filter) return true;
        const m = rmMap[k];
        return m.code.toLowerCase().includes(filter) || m.name.toLowerCase().includes(filter);
      }).map(k => {
        const m = rmMap[k];
        const isNegative = m.calculatedStock < 0;
        const varColor = (m.variance === null) ? 'var(--text-muted)' : (m.variance === 0 ? '#10b981' : (m.variance > 0 ? '#38bdf8' : '#ef4444'));

        return `
          <tr style="${isNegative ? 'background: rgba(239, 68, 68, 0.05);' : ''}">
            <td><strong>${this.escapeHtml(m.code || 'RM')}</strong></td>
            <td>${this.escapeHtml(m.name)}</td>
            <td><span class="badge" style="font-size:0.75rem;">${this.escapeHtml(m.unit)}</span></td>
            <td style="text-align:right;">${m.openingQty.toFixed(3)}</td>
            <td style="text-align:right; color:#10b981; font-weight:600;">+${m.purchasedQty.toFixed(3)}</td>
            <td style="text-align:right; color:#f59e0b;">-${m.consumedInSales.toFixed(3)}</td>
            <td style="text-align:right; color:#8b5cf6;">-${m.consumedInFG.toFixed(3)}</td>
            <td style="text-align:right; font-weight:700; color:${isNegative ? '#ef4444' : '#38bdf8'}; font-size:0.9rem;">
              ${m.calculatedStock.toFixed(3)} ${isNegative ? '⚠️ Deficit' : ''}
            </td>
            <td style="text-align:right;">${m.physicalCount !== null ? m.physicalCount.toFixed(3) : '<span class="td-muted">-</span>'}</td>
            <td style="text-align:right; font-weight:600; color:${varColor};">
              ${m.variance !== null ? (m.variance > 0 ? '+' + m.variance.toFixed(3) : m.variance.toFixed(3)) : '<span class="td-muted">-</span>'}
            </td>
            <td style="text-align:center;">
              <input type="number" step="0.001" class="rec-input-override" value="${m.finalStock}" 
                     onchange="app.updateReconciliationFinalOverride('rm', '${k}', this.value)"
                     title="Target cutover stock to set for this raw material">
            </td>
          </tr>
        `;
      }).join('');

      tbody.innerHTML = rowsHtml || `<tr><td colspan="11" class="empty-list-text" style="text-align:center; padding:1.5rem;">No raw materials matching "${this.escapeHtml(filter)}".</td></tr>`;

    } else if (activeTab === 'fg') {
      const tbody = document.getElementById('rec-matrix-fg-tbody');
      if (!tbody) return;
      const fgMap = this.reconciliation.fgCalculated || {};
      const keys = Object.keys(fgMap);

      if (keys.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-list-text" style="text-align:center; padding:2rem;">No Finished Goods found in database. Add products in Products & BOM tab.</td></tr>`;
        return;
      }

      const rowsHtml = keys.filter(k => {
        if (!filter) return true;
        const p = fgMap[k];
        return p.sku.toLowerCase().includes(filter) || p.name.toLowerCase().includes(filter);
      }).map(k => {
        const p = fgMap[k];
        const val = p.finalStock * p.sellingPrice;

        return `
          <tr>
            <td><strong>${this.escapeHtml(p.sku || 'SKU')}</strong></td>
            <td>${this.escapeHtml(p.name)}</td>
            <td><span class="badge" style="font-size:0.75rem;">${this.escapeHtml(p.packaging || 'Standard')}</span></td>
            <td style="text-align:right;">${p.openingQty}</td>
            <td style="text-align:right; color:#f59e0b;">-${p.soldQty}</td>
            <td style="text-align:right; font-weight:600; color:#8b5cf6;">
              ${p.physicalCount !== null ? p.physicalCount : '<span class="td-muted">0</span>'}
            </td>
            <td style="text-align:right;">Rs. ${p.sellingPrice.toFixed(2)}</td>
            <td style="text-align:right; font-weight:700; color:#10b981;">Rs. ${val.toFixed(2)}</td>
            <td style="text-align:center;">
              <input type="number" step="1" min="0" class="rec-input-override" value="${p.finalStock}" 
                     onchange="app.updateReconciliationFinalOverride('fg', '${k}', this.value)"
                     title="Target cutover stock to set for this finished product">
            </td>
          </tr>
        `;
      }).join('');

      tbody.innerHTML = rowsHtml || `<tr><td colspan="9" class="empty-list-text" style="text-align:center; padding:1.5rem;">No products matching "${this.escapeHtml(filter)}".</td></tr>`;

    } else if (activeTab === 'purchases') {
      const tbody = document.getElementById('rec-matrix-purchases-tbody');
      if (!tbody) return;
      const list = this.reconciliation.purchases || [];

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-list-text" style="text-align:center; padding:2rem;">No purchase bills loaded. Upload an Excel sheet or PDF invoices above.</td></tr>`;
        return;
      }

      const rowsHtml = list.filter(p => {
        if (!filter) return true;
        return (p.invoice_no && p.invoice_no.toLowerCase().includes(filter)) || 
               (p.supplier && p.supplier.toLowerCase().includes(filter)) || 
               (p.material_name && p.material_name.toLowerCase().includes(filter));
      }).map(p => `
        <tr>
          <td>${p.date || 'N/A'}</td>
          <td><strong>${this.escapeHtml(p.invoice_no)}</strong></td>
          <td>${this.escapeHtml(p.supplier)}</td>
          <td>${this.escapeHtml(p.material_name || p.material_code || 'Item')}</td>
          <td style="text-align:right; font-weight:600; color:#10b981;">${p.quantity}</td>
          <td>${this.escapeHtml(p.unit || 'kg')}</td>
          <td style="text-align:right;">Rs. ${(p.rate || 0).toFixed(2)}</td>
          <td style="text-align:right; font-weight:700;">Rs. ${(p.total || 0).toFixed(2)}</td>
        </tr>
      `).join('');

      tbody.innerHTML = rowsHtml || `<tr><td colspan="8" class="empty-list-text" style="text-align:center; padding:1.5rem;">No purchases matching "${this.escapeHtml(filter)}".</td></tr>`;

    } else if (activeTab === 'sales') {
      const tbody = document.getElementById('rec-matrix-sales-tbody');
      if (!tbody) return;
      const list = this.reconciliation.sales || [];

      if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-list-text" style="text-align:center; padding:2rem;">No sales invoices loaded. Upload an Excel sheet or PDF invoices above.</td></tr>`;
        return;
      }

      const rowsHtml = list.filter(s => {
        if (!filter) return true;
        return (s.invoice_no && s.invoice_no.toLowerCase().includes(filter)) || 
               (s.customer && s.customer.toLowerCase().includes(filter)) || 
               (s.product_name && s.product_name.toLowerCase().includes(filter));
      }).map(s => `
        <tr>
          <td>${s.date || 'N/A'}</td>
          <td><strong>${this.escapeHtml(s.invoice_no)}</strong></td>
          <td>${this.escapeHtml(s.customer)}</td>
          <td>${this.escapeHtml(s.product_name || s.sku || 'Product')}</td>
          <td style="text-align:right; font-weight:600; color:#f59e0b;">${s.quantity}</td>
          <td>${this.escapeHtml(s.packaging || 'Standard')}</td>
          <td style="text-align:right;">Rs. ${(s.rate || 0).toFixed(2)}</td>
          <td style="text-align:right; font-weight:700;">Rs. ${(s.total || 0).toFixed(2)}</td>
        </tr>
      `).join('');

      tbody.innerHTML = rowsHtml || `<tr><td colspan="8" class="empty-list-text" style="text-align:center; padding:1.5rem;">No sales matching "${this.escapeHtml(filter)}".</td></tr>`;
    }
  }

  updateReconciliationFinalOverride(type, key, value) {
    const num = parseFloat(value);
    if (isNaN(num)) return;

    if (type === 'rm') {
      if (!this.reconciliation.finalOverridesRM) this.reconciliation.finalOverridesRM = {};
      this.reconciliation.finalOverridesRM[key] = num;
    } else if (type === 'fg') {
      if (!this.reconciliation.finalOverridesFG) this.reconciliation.finalOverridesFG = {};
      this.reconciliation.finalOverridesFG[key] = num;
    }

    this.saveReconciliationDraft();
    this.computeReconciliationMatrix();
  }

  resetReconciliationWorkspace() {
    if (!confirm("Are you sure you want to reset the reconciliation workspace? All draft uploads will be cleared.")) {
      return;
    }

    this.reconciliation = {
      cutoverDate: '2026-04-01',
      openingStockRM: {},
      openingStockFG: {},
      purchases: [],
      sales: [],
      physicalCountsRM: {},
      physicalCountsFG: {},
      finalOverridesRM: {},
      finalOverridesFG: {},
      activeSubtab: 'rm'
    };

    localStorage.removeItem('erp_reconciliation_draft');
    this.computeReconciliationMatrix();
    alert("Reconciliation workspace reset.");
  }

  downloadReconciliationTemplate(type) {
    if (typeof XLSX === 'undefined') {
      alert("SheetJS library is still initializing. Please try again in a moment.");
      return;
    }

    const wb = XLSX.utils.book_new();

    if (type === 'opening') {
      const rmRows = (this.db.raw_materials || []).map(m => ({
        'Type': 'Raw Material',
        'Material Code': m.code || '',
        'Material Name': m.name || '',
        'Unit': m.unit || 'kg',
        'Opening Stock (01-Apr-2026)': 0,
        'Average Purchase Rate (Rs)': m.average_price || 0
      }));
      const fgRows = (this.db.products || []).map(p => ({
        'Type': 'Finished Good',
        'Product SKU': p.sku || '',
        'Product Name': p.name || '',
        'Packaging': p.packaging || '',
        'Opening Stock (01-Apr-2026)': 0,
        'Selling Rate (Rs)': p.selling_price || 0
      }));

      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rmRows), "Raw_Materials_Opening");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fgRows), "Finished_Goods_Opening");
      XLSX.writeFile(wb, "MFP_Opening_Stock_Template_01Apr2026.xlsx");

    } else if (type === 'purchases') {
      const sampleRows = [
        {
          'Date': '2026-04-05',
          'Invoice / Bill No': 'INV-2026-01',
          'Supplier Name': 'Agro Ingredients Ltd',
          'Material Code': (this.db.raw_materials[0] && this.db.raw_materials[0].code) || 'RM-PERIPERI',
          'Material Name': (this.db.raw_materials[0] && this.db.raw_materials[0].name) || 'Peri Peri Spice',
          'Quantity': 25.0,
          'Unit': 'kg',
          'Rate (Rs)': 350.0,
          'GST %': 18,
          'Total Amount (Rs)': 10325.0
        }
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sampleRows), "Purchases_From_01Apr2026");
      XLSX.writeFile(wb, "MFP_Purchases_Template_FY2627.xlsx");

    } else if (type === 'sales') {
      const sampleRows = [
        {
          'Date': '2026-04-10',
          'Invoice / Dispatch No': 'DISP-2026-101',
          'Customer Name': 'Reliance Retail',
          'Product SKU': (this.db.products[0] && this.db.products[0].sku) || 'FG-PERI-200ML',
          'Product Name': (this.db.products[0] && this.db.products[0].name) || 'Peri Peri Sauce 200ml',
          'Quantity Sold': 150,
          'Packaging': 'Bottles',
          'Rate (Rs)': 120.0,
          'Total Amount (Rs)': 18000.0
        }
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sampleRows), "Sales_From_01Apr2026");
      XLSX.writeFile(wb, "MFP_Sales_Template_FY2627.xlsx");

    } else if (type === 'physical') {
      const fgRows = (this.db.products || []).map(p => ({
        'Product SKU': p.sku || '',
        'Product Name': p.name || '',
        'Packaging': p.packaging || '',
        'Physical Count on Floor (pcs)': 0,
        'Count Date': new Date().toISOString().split('T')[0],
        'Notes': 'Physical inventory count'
      }));
      const rmRows = (this.db.raw_materials || []).map(m => ({
        'Material Code': m.code || '',
        'Material Name': m.name || '',
        'Unit': m.unit || 'kg',
        'Physical Count in Warehouse': 0,
        'Count Date': new Date().toISOString().split('T')[0],
        'Notes': 'Physical inventory count'
      }));

      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fgRows), "Current_FG_Count");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rmRows), "Current_RM_Count");
      XLSX.writeFile(wb, "MFP_Physical_Count_Template.xlsx");
    }
  }

  downloadAllReconciliationTemplates() {
    if (typeof XLSX === 'undefined') {
      alert("SheetJS library is still initializing. Please try again in a moment.");
      return;
    }

    const wb = XLSX.utils.book_new();

    // 1. Opening Raw Materials
    const rmOpen = (this.db.raw_materials || []).map(m => ({
      'Material Code': m.code || '',
      'Material Name': m.name || '',
      'Unit': m.unit || 'kg',
      'Opening Stock Qty (01-Apr-2026)': 0,
      'Average Rate (Rs)': m.average_price || 0
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rmOpen), "1_Opening_Stock_RM");

    // 2. Opening Finished Goods
    const fgOpen = (this.db.products || []).map(p => ({
      'Product SKU': p.sku || '',
      'Product Name': p.name || '',
      'Packaging': p.packaging || '',
      'Opening Stock Qty (01-Apr-2026)': 0,
      'Selling Rate (Rs)': p.selling_price || 0
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fgOpen), "1_Opening_Stock_FG");

    // 3. Purchases
    const samplePurchases = [
      {
        'Date': '2026-04-05',
        'Invoice / Bill No': 'INV-2026-01',
        'Supplier Name': 'Supplier Name',
        'Material Code': (this.db.raw_materials[0] && this.db.raw_materials[0].code) || 'RM-CODE',
        'Material Name': (this.db.raw_materials[0] && this.db.raw_materials[0].name) || 'Material Name',
        'Quantity': 100.0,
        'Unit': 'kg',
        'Rate (Rs)': 150.0,
        'GST %': 18,
        'Total Amount (Rs)': 17700.0
      }
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(samplePurchases), "2_Purchases_From_01Apr2026");

    // 4. Sales
    const sampleSales = [
      {
        'Date': '2026-04-10',
        'Invoice / Dispatch No': 'DISP-2026-01',
        'Customer Name': 'Customer Name',
        'Product SKU': (this.db.products[0] && this.db.products[0].sku) || 'FG-SKU',
        'Product Name': (this.db.products[0] && this.db.products[0].name) || 'Product Name',
        'Quantity Sold': 50,
        'Packaging': 'Bottles',
        'Rate (Rs)': 120.0,
        'Total Amount (Rs)': 6000.0
      }
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sampleSales), "3_Sales_From_01Apr2026");

    // 5. Current Physical Stock Count
    const fgCount = (this.db.products || []).map(p => ({
      'Product SKU': p.sku || '',
      'Product Name': p.name || '',
      'Packaging': p.packaging || '',
      'Physical Count on Floor (pcs)': 0,
      'Count Date': new Date().toISOString().split('T')[0]
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fgCount), "4_Physical_Count_FG");

    const rmCount = (this.db.raw_materials || []).map(m => ({
      'Material Code': m.code || '',
      'Material Name': m.name || '',
      'Unit': m.unit || 'kg',
      'Physical Count in Warehouse': 0,
      'Count Date': new Date().toISOString().split('T')[0]
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rmCount), "4_Physical_Count_RM");

    XLSX.writeFile(wb, "MFP_Inventory_Cutover_Master_Templates.xlsx");
  }

  exportReconciliationReport() {
    if (typeof XLSX === 'undefined') {
      alert("SheetJS library is still initializing.");
      return;
    }

    const rmMap = this.reconciliation.rmCalculated || {};
    const fgMap = this.reconciliation.fgCalculated || {};

    const rmRows = Object.keys(rmMap).map(k => {
      const m = rmMap[k];
      return {
        'Material Code': m.code,
        'Material Name': m.name,
        'Unit': m.unit,
        'Opening Stock (1-Apr)': m.openingQty,
        'Purchases (+)': m.purchasedQty,
        'Consumed in Sales (-)': m.consumedInSales,
        'Embodied in Current FG (-)': m.consumedInFG,
        'Calculated Balance In Hand (=)': m.calculatedStock,
        'Physical Floor Count': m.physicalCount !== null ? m.physicalCount : '',
        'Variance (Physical - Calc)': m.variance !== null ? m.variance : '',
        'Final Target Stock Applied': m.finalStock,
        'Unit Valuation Rate (Rs)': m.avgPrice,
        'Total Reconciled Valuation (Rs)': Math.round(m.finalStock * m.avgPrice * 100) / 100
      };
    });

    const fgRows = Object.keys(fgMap).map(k => {
      const p = fgMap[k];
      return {
        'Product SKU': p.sku,
        'Product Name': p.name,
        'Packaging': p.packaging,
        'Opening Stock (1-Apr)': p.openingQty,
        'Sales Invoiced (-)': p.soldQty,
        'Current Physical Count': p.physicalCount !== null ? p.physicalCount : '',
        'Final Target Stock Applied': p.finalStock,
        'Selling Rate (Rs)': p.sellingPrice,
        'Total FG Valuation (Rs)': Math.round(p.finalStock * p.sellingPrice * 100) / 100
      };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rmRows), "Raw_Materials_Reconciled");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fgRows), "Finished_Goods_Reconciled");

    if (this.reconciliation.purchases && this.reconciliation.purchases.length > 0) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(this.reconciliation.purchases), "Purchases_Ledger");
    }
    if (this.reconciliation.sales && this.reconciliation.sales.length > 0) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(this.reconciliation.sales), "Sales_Ledger");
    }

    const dateStr = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `MFP_Inventory_Reconciliation_Report_${dateStr}.xlsx`);
  }

  executeInventoryCutover() {
    this.computeReconciliationMatrix();

    const rmMap = this.reconciliation.rmCalculated || {};
    const fgMap = this.reconciliation.fgCalculated || {};
    const purList = this.reconciliation.purchases || [];
    const salList = this.reconciliation.sales || [];

    const cutDate = document.getElementById('rec-cutover-date')?.value || this.reconciliation.cutoverDate || '2026-04-01';

    const rmKeys = Object.keys(rmMap);
    const fgKeys = Object.keys(fgMap);

    const confirmMsg = 
      `⚠️ CONFIRM SYSTEM CUTOVER TO CURRENT POSITION:\n\n` +
      `• Effective Cutover Starting Date: ${cutDate}\n` +
      `• ${rmKeys.length} Raw Materials will be updated with calculated in-hand balances\n` +
      `• ${fgKeys.length} Finished Goods will be updated with verified floor counts\n` +
      `• ${purList.length} Purchase Inward Bills from ${cutDate} will populate the Inward Register\n` +
      `• ${salList.length} Sales Dispatches from ${cutDate} will populate the Outward Register\n` +
      `• Pre-cutover backup JSON will download automatically to your computer.\n\n` +
      `Are you sure you want to proceed and set these figures as your live ERP inventory?`;

    if (!confirm(confirmMsg)) {
      return;
    }

    // 1. Mandatory Auto-Backup
    try {
      this.exportDatabase();
    } catch (e) {
      console.warn("Auto-backup prompt:", e);
    }

    // 2. Set Raw Material Warehouse Stocks
    rmKeys.forEach(k => {
      const mCalc = rmMap[k];
      const mat = (this.db.raw_materials || []).find(m => m.id === mCalc.id || m.code === mCalc.code);
      if (mat) {
        mat.current_stock = Math.max(0, mCalc.finalStock);
        if (mCalc.avgPrice > 0) {
          mat.average_price = mCalc.avgPrice;
        }
      }
    });

    // 3. Set Finished Goods Warehouse Stocks
    fgKeys.forEach(k => {
      const pCalc = fgMap[k];
      const prod = (this.db.products || []).find(p => p.sku === pCalc.sku || p.id === pCalc.id);
      if (prod) {
        prod.current_stock = Math.max(0, pCalc.finalStock);
        if (pCalc.sellingPrice > 0) {
          prod.selling_price = pCalc.sellingPrice;
        }
      }
    });

    // 4. Populate Live Inwards Register with Verified Purchases
    if (purList.length > 0) {
      this.db.inwards = (this.db.inwards || []).filter(inw => inw.date < cutDate);

      purList.forEach(pur => {
        const mat = (this.db.raw_materials || []).find(m => m.id === pur.material_id || m.code === pur.material_code || (pur.material_name && m.name.toLowerCase() === pur.material_name.toLowerCase()));
        this.db.inwards.push({
          id: 'inw_cutover_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
          date: pur.date || cutDate,
          invoice_no: pur.invoice_no || 'CUTOVER-INW',
          supplier: pur.supplier || 'Supplier',
          material_id: mat ? mat.id : (pur.material_id || ''),
          material_code: mat ? mat.code : (pur.material_code || ''),
          material_name: mat ? mat.name : (pur.material_name || ''),
          quantity: pur.quantity,
          unit: pur.unit || (mat ? mat.unit : 'kg'),
          rate: pur.rate,
          total_amount: pur.total,
          linked_order_id: null
        });
      });
    }

    // 5. Populate Live Outwards Register with Verified Sales
    if (salList.length > 0) {
      this.db.outwards = (this.db.outwards || []).filter(outw => outw.date < cutDate);

      salList.forEach(sal => {
        const prod = (this.db.products || []).find(p => (sal.sku && p.sku === sal.sku) || (sal.product_id && p.id === sal.product_id) || (sal.product_name && p.name.toLowerCase() === sal.product_name.toLowerCase()));
        this.db.outwards.push({
          id: 'outw_cutover_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
          date: sal.date || cutDate,
          invoice_no: sal.invoice_no || 'CUTOVER-SAL',
          customer: sal.customer || 'Customer',
          product_id: prod ? prod.id : (sal.product_id || ''),
          product_sku: prod ? prod.sku : (sal.sku || ''),
          product_name: prod ? prod.name : (sal.product_name || ''),
          packaging: sal.packaging || (prod ? prod.packaging : 'Standard'),
          quantity: sal.quantity,
          rate: sal.rate,
          total_amount: sal.total,
          is_sample: false,
          courier_ref: 'Cutover Reconciled',
          notes: 'FY 2026-27 Cutover Sale'
        });
      });
    }

    // 6. Create Initial Cutover Snapshot Entries in Material Stock Ledgers
    rmKeys.forEach(k => {
      const mCalc = rmMap[k];
      const mat = (this.db.raw_materials || []).find(m => m.id === mCalc.id || m.code === mCalc.code);
      if (mat) {
        if (!this.db.transactions) this.db.transactions = [];
        this.db.transactions.push({
          id: 'tx_rec_cutover_' + mat.id,
          date: cutDate,
          type: 'inward',
          ref: 'REC-CUTOVER-2026',
          title: `Cutover Reconciled Balance: ${mat.name}`,
          description: `Established starting inventory position (Balance purchases less sales & physical counts)`,
          quantities: `+${mat.current_stock.toFixed(3)} ${mat.unit || 'kg'}`,
          quantity: mat.current_stock,
          material_id: mat.id,
          material_name: mat.name,
          unit: mat.unit || 'kg',
          rate: mat.average_price || 0,
          status: 'Reconciled Cutover'
        });
      }
    });

    // 7. Save Database
    this.saveDb();

    // 8. Sync with Cloud Database if Online
    if (this.supabase && this.supabaseConfig && this.supabaseConfig.isOnline) {
      try {
        console.log("Syncing cutover updates to Supabase...");
        (this.db.raw_materials || []).forEach(async (m) => {
          await this.supabase.from('raw_materials').upsert({
            id: m.id,
            code: m.code,
            name: m.name,
            current_stock: m.current_stock,
            unit: m.unit,
            average_price: m.average_price,
            min_stock: m.min_stock
          });
        });
        (this.db.products || []).forEach(async (p) => {
          await this.supabase.from('products').upsert({
            id: p.id,
            sku: p.sku,
            name: p.name,
            packaging: p.packaging,
            current_stock: p.current_stock,
            selling_price: p.selling_price
          });
        });
      } catch (err) {
        console.warn("Supabase cutover sync error:", err);
      }
    }

    // 9. Refresh All ERP Views
    this.refreshAllViews();

    // 10. Switch to Raw Materials View
    this.switchView('raw-materials-view');

    alert(
      `🎉 INVENTORY CUTOVER COMPLETED SUCCESSFULLY!\n\n` +
      `Your ERP inventory balances have been updated to the reconciled current position.\n` +
      `• Raw Materials warehouse stock set to calculated in-hand inventory\n` +
      `• Finished Goods stock set to verified floor counts\n` +
      `• Verified purchase & sales registers active from 1-April-2026 onwards\n` +
      `• All systems are now aligned for live day-to-day operations!`
    );
  }
}

// Initialize Application Globals
window.app = new MFPERP();
