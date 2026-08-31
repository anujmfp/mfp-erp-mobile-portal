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

    this.init();
  }

  init() {
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
        if (!this.db.transactions) this.db.transactions = [];
        if (!this.db.finance_transactions) this.db.finance_transactions = [];
        if (!this.db.employees) this.db.employees = [];
      } catch (e) {
        console.error("Failed to parse local storage DB, resetting.", e);
        this.saveDb();
      }
    } else {
      this.saveDb();
    }

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
    this.setupDropzone('sale-dropzone', 'sale-file-input', (file) => this.handleSaleUpload(file));

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
    } else if (viewId === 'history-view') {
      this.renderHistory();
    }
  }

  refreshAllViews() {
    this.renderFinanceDashboard();
    this.renderMonthlyLedger();
    this.renderEmployeeDirectory();
    this.renderOperationalDashboard();
    this.renderMaterials();
    this.renderFinishedGoods();
    this.renderProducts();
    this.renderHistory();
  }

  // Format currencies in Indian Standard Format (Rupees, Lakhs, Crores)
  formatCurrency(val) {
    return 'Rs. ' + (val || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
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
  setupDropzone(zoneId, inputId, onFileSelected) {
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
      
      const file = e.dataTransfer.files[0];
      if (file) onFileSelected(file);
    });

    if (inputId) {
      const input = document.getElementById(inputId);
      if (input) {
        input.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) onFileSelected(file);
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
      // Check remarks for "loan to mfp" case-insensitive
      const searchTxt = (detailsVal + ' ' + expDetailsVal).toLowerCase();
      let tabCategory = 'Uncategorized';
      let subCategory = '';

      if (searchTxt.includes('loan to mfp')) {
        tabCategory = 'Capital Infusion';
      } else if (finalCredit > 0) {
        tabCategory = 'Sale';
      } else if (debitVal > 0) {
        // Run heuristic auto-categorizer matching expense heads
        if (searchTxt.includes('salary') || searchTxt.includes('wage') || searchTxt.includes('payroll') || searchTxt.includes('employee')) {
          tabCategory = 'salary and wages';
        } else if (searchTxt.includes('lease') || searchTxt.includes('rent')) {
          tabCategory = 'lease';
        } else if (searchTxt.includes('electric') || searchTxt.includes('power') || searchTxt.includes('utility')) {
          tabCategory = 'electricity';
        } else if (searchTxt.includes('bank') || searchTxt.includes('interest') || searchTxt.includes('finance') || searchTxt.includes('loan')) {
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
      const monthKey = t.date.substring(0, 7); // YYYY-MM
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { month: monthKey, sales: 0, expenses: 0 };
      }

      if (t.category === 'Capital Infusion') {
        infusions += t.credit; // capital infusion (Excluded from profit/loss sales)
      } else if (t.category === 'Sale') {
        sales += t.credit;
        monthlyData[monthKey].sales += t.credit;
      } else {
        // Expense debit
        expenses += t.debit;
        monthlyData[monthKey].expenses += t.debit;
        
        const cat = t.category || 'Uncategorized';
        if (breakdown[cat] !== undefined) {
          breakdown[cat] += t.debit;
        } else {
          breakdown['Uncategorized'] += t.debit;
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

  // Render the Monthly Ledger Table with Dynamic Selectors
  renderMonthlyLedger() {
    const tbody = document.getElementById('ledger-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    const searchQuery = document.getElementById('ledger-search').value.toLowerCase().trim();
    const categoryFilter = document.getElementById('ledger-filter-category').value;

    // Apply filters
    let filtered = this.db.finance_transactions.filter(t => {
      const matchSearch = t.details.toLowerCase().includes(searchQuery) || 
                          (t.category || '').toLowerCase().includes(searchQuery) ||
                          (t.subCategory || '').toLowerCase().includes(searchQuery) ||
                          t.date.includes(searchQuery);
      
      const matchCat = !categoryFilter || t.category === categoryFilter;

      return matchSearch && matchCat;
    });

    // Apply sorting
    const col = this.ledgerSort.column;
    const dir = this.ledgerSort.direction === 'asc' ? 1 : -1;
    filtered.sort((a, b) => {
      if (col === 'date') {
        return (new Date(a.date) - new Date(b.date)) * dir;
      } else if (col === 'debit') {
        return (a.debit - b.debit) * dir;
      } else if (col === 'credit') {
        return (a.credit - b.credit) * dir;
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

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-list-text">No transaction lines found. Upload an Excel cash sheet to start!</td></tr>`;
      return;
    }

    filtered.forEach(t => {
      const tr = document.createElement('tr');

      // Category selector
      const categories = [
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

      const catSelectOptions = categories.map(cat => {
        const selected = t.category === cat.value ? 'selected' : '';
        return `<option value="${cat.value}" ${selected}>${cat.label}</option>`;
      }).join('');

      let subCategoryHtml = '';
      if (t.category === 'growing-expenses' || t.category === 'growing expenses') {
        const growingSubHeads = ['nutrients', 'labour', 'saplings', 'seeds'];
        subCategoryHtml = `
          <select class="table-select-category" style="font-size:0.75rem; padding:0.25rem;" onchange="app.updateTransactionSubCategory('${t.id}', this.value)">
            <option value="" disabled selected>-- Select sub-head --</option>
            ${growingSubHeads.map(sub => `<option value="${sub}" ${t.subCategory === sub ? 'selected' : ''}>${sub.charAt(0).toUpperCase() + sub.slice(1)}</option>`).join('')}
          </select>
        `;
      } else if (t.category === 'processing') {
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
            <option value="" disabled selected>-- Select sub-head --</option>
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

  // Render recent activities
  renderDashboardActivities() {
    const container = document.getElementById('dashboard-activity-list');
    container.innerHTML = '';

    const recents = [...this.db.transactions]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 4);

    if (recents.length === 0) {
      container.innerHTML = `<div class="empty-list-text">No recent transactions recorded.</div>`;
      return;
    }

    recents.forEach(tx => {
      const isPurchase = tx.type === 'purchase';
      const isSale = tx.type === 'sale';
      
      let badgeColor = 'info';
      let titlePrefix = 'Production run';
      if (isPurchase) {
        badgeColor = 'success';
        titlePrefix = 'Stock Inward';
      } else if (isSale) {
        badgeColor = 'primary';
        titlePrefix = 'Stock Outward';
      }
      
      const div = document.createElement('div');
      div.className = 'activity-item';
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';
      div.style.padding = '0.75rem';
      div.style.borderBottom = '1px solid var(--border-light)';
      
      div.innerHTML = `
        <div>
          <div class="td-bold" style="font-size:0.9rem;">${tx.description}</div>
          <div class="td-muted" style="font-size:0.75rem; margin-top:0.15rem;">Ref: ${tx.invoice_no || 'N/A'} • ${tx.date}</div>
        </div>
        <span class="badge badge-${badgeColor}">${titlePrefix}</span>
      `;
      container.appendChild(div);
    });
  }

  // Render Raw Materials view table
  renderMaterials() {
    const tbody = document.getElementById('materials-table-body');
    tbody.innerHTML = '';

    const search = document.getElementById('material-search').value.toLowerCase().trim();

    const filtered = this.db.raw_materials.filter(m => {
      return m.name.toLowerCase().includes(search) || 
             m.code.toLowerCase().includes(search) || 
             (m.description || '').toLowerCase().includes(search);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-list-text">No raw materials found. Define materials or load demo data.</td></tr>`;
      return;
    }

    filtered.forEach(item => {
      const stock = parseFloat(item.current_stock || 0);
      const minStock = parseFloat(item.min_stock || 0);
      const rate = parseFloat(item.average_price || 0);
      const asset = stock * rate;

      let stockColor = 'inherit';
      if (stock === 0) stockColor = 'var(--color-danger)';
      else if (stock <= minStock) stockColor = 'var(--color-warning)';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-bold">${item.code}</td>
        <td>${item.name}</td>
        <td class="td-muted" style="max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.description || '-'}</td>
        <td class="td-bold" style="color:${stockColor}">${stock.toFixed(3)}</td>
        <td class="td-muted">${item.unit}</td>
        <td>${this.formatCurrency(rate)}</td>
        <td class="td-bold">${this.formatCurrency(asset)}</td>
        <td class="td-actions" style="text-align: right;">
          <button class="btn btn-secondary btn-sm" onclick="app.openEditMaterialModal('${item.id}')">
            <i class="fa-solid fa-pen"></i>
          </button>
          <button class="btn btn-danger btn-sm" onclick="app.deleteMaterial('${item.id}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
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
    this.closeModal('material-modal');
    this.refreshAllViews();
  }

  deleteMaterial(id) {
    if (!confirm("Are you sure you want to delete this raw material? Linkages in BOMs will break.")) return;
    this.db.raw_materials = this.db.raw_materials.filter(m => m.id !== id);
    this.saveDb();
    this.refreshAllViews();
  }

  // Render Finished Goods view table
  renderFinishedGoods() {
    const tbody = document.getElementById('finished-goods-table-body');
    tbody.innerHTML = '';

    const search = document.getElementById('fg-search').value.toLowerCase().trim();

    const filtered = this.db.products.filter(p => {
      return p.name.toLowerCase().includes(search) || 
             p.code.toLowerCase().includes(search) || 
             (p.description || '').toLowerCase().includes(search);
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-list-text">No products in Finished Goods warehouse. Configure products under 'Products & BOM' first.</td></tr>`;
      return;
    }

    filtered.forEach(p => {
      const stock = parseFloat(p.current_stock || 0);
      const minStock = parseFloat(p.min_stock || 0);
      const mrp = parseFloat(p.price || 0);
      const sellingPrice = parseFloat(p.selling_price || mrp);
      const asset = stock * sellingPrice;

      let status = `<span class="badge badge-success">Sufficient</span>`;
      if (stock === 0) {
        status = `<span class="badge badge-danger">Out of Stock</span>`;
      } else if (stock <= minStock) {
        status = `<span class="badge badge-warning">Low Cover</span>`;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="td-bold">${p.code}</td>
        <td><strong>${p.name}</strong></td>
        <td><span class="badge badge-primary">${p.packaging_type || 'General'}</span></td>
        <td class="td-muted" style="max-width: 180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.description || '-'}</td>
        <td class="td-bold">${stock.toFixed(0)} pcs</td>
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
    this.closeModal('product-modal');
    this.refreshAllViews();
  }

  deleteProduct(id) {
    if (!confirm("Are you sure you want to delete this product catalog?")) return;
    this.db.products = this.db.products.filter(p => p.id !== id);
    this.saveDb();
    this.refreshAllViews();
  }


  /* ==========================================================================
     INVENTORY UPLOADS: PDF PURCHASE / SALE EXTRACTORS (FROM ERP)
     ========================================================================== */

  // Document Text Parsers
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


  // --- SALE PDF INWARD DEDUCTIONS ---
  
  async handleSaleUpload(file) {
    if (!file || file.type !== 'application/pdf') {
      alert("Please upload a PDF sales invoice.");
      return;
    }

    try {
      const rawText = await this.parsePDFText(file);
      const extracted = this.heuristicsExtractSale(rawText);

      this.currentVerifySaleItems = extracted.products;
      
      document.getElementById('verify-sale-invoice').value = extracted.invoice_no;
      document.getElementById('verify-sale-date').value = extracted.date;

      this.renderVerifySaleTable();
      this.calculateBOMDeductions();
      this.openModal('sale-verify-modal');
    } catch (e) {
      console.error(e);
      alert("Error parsing PDF invoice: " + e.message);
    }
  }

  openManualSaleModal() {
    this.currentVerifySaleItems = [{ product_id: '', quantity_sold: 1, rate: 0 }];
    document.getElementById('verify-sale-invoice').value = 'MNS-' + Math.floor(1000 + Math.random() * 9000);
    document.getElementById('verify-sale-date').value = new Date().toISOString().split('T')[0];

    this.renderVerifySaleTable();
    this.calculateBOMDeductions();
    this.openModal('sale-verify-modal');
  }

  heuristicsExtractSale(text) {
    const result = {
      invoice_no: 'SAL-' + Math.floor(1000 + Math.random() * 9000),
      date: new Date().toISOString().split('T')[0],
      products: []
    };

    // Date regex
    const dateMatch = text.match(/(?:invoice\s*date|date|dated)\s*[:\-]?\s*(\d{1,2}[-\/.]\d{1,2}[-\/.]\d{2,4})/i) ||
                      text.match(/(\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2})/);
    if (dateMatch) {
      result.date = new Date(Date.parse(dateMatch[1])).toISOString().split('T')[0];
    }

    const invMatch = text.match(/(?:invoice|inv|bill)\s*(?:no|number)?\s*[:\-#]?\s*([A-Za-z0-9\-]+)/i);
    if (invMatch) result.invoice_no = invMatch[1];

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
          const mappedId = this.autoMapProduct(desc);
          result.products.push({
            raw_text_name: desc,
            product_id: mappedId,
            quantity_sold: Math.round(qty),
            rate: rate
          });
        }
      }
    });

    if (result.products.length === 0) {
      result.products.push({ raw_text_name: 'Manual Dispatch Line', product_id: '', quantity_sold: 1, rate: 0 });
    }

    return result;
  }

  autoMapProduct(name) {
    const clean = name.toLowerCase();
    const match = this.db.products.find(p => {
      return clean.includes(p.name.toLowerCase()) || 
             p.name.toLowerCase().includes(clean) ||
             clean.includes(p.code.toLowerCase());
    });
    return match ? match.id : '';
  }

  renderVerifySaleTable() {
    const tbody = document.getElementById('verify-sale-table-body');
    tbody.innerHTML = '';

    this.currentVerifySaleItems.forEach((item, index) => {
      const tr = document.createElement('tr');
      
      let options = '<option value="" disabled selected>-- Select Product --</option>';
      this.db.products.forEach(p => {
        options += `<option value="${p.id}" ${item.product_id === p.id ? 'selected' : ''}>${p.name} (${p.code})</option>`;
      });

      tr.innerHTML = `
        <td>
          <div class="td-bold" style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.25rem;">Extracted: "${item.raw_text_name || 'Manual'}"</div>
          <select class="form-control" style="padding:0.4rem;" onchange="app.updateVerifySaleItem(${index}, 'product_id', this.value)">
            ${options}
          </select>
        </td>
        <td>
          <input type="number" min="1" class="form-control" style="padding:0.4rem;" value="${item.quantity_sold}" oninput="app.updateVerifySaleItem(${index}, 'quantity_sold', this.value)">
        </td>
        <td>
          <input type="number" min="0" step="0.01" class="form-control" style="padding:0.4rem;" value="${item.rate || 0}" oninput="app.updateVerifySaleItem(${index}, 'rate', this.value)">
        </td>
        <td class="text-center">
          <button type="button" class="btn btn-danger btn-sm" onclick="app.removeVerifySaleRow(${index})">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  }

  updateVerifySaleItem(index, key, val) {
    if (this.currentVerifySaleItems[index]) {
      if (key === 'product_id') {
        this.currentVerifySaleItems[index].product_id = val;
        // set default rate from product
        const p = this.db.products.find(prod => prod.id === val);
        if (p) this.currentVerifySaleItems[index].rate = p.selling_price || p.price;
      } else if (key === 'rate') {
        this.currentVerifySaleItems[index].rate = parseFloat(val) || 0;
      } else {
        this.currentVerifySaleItems[index][key] = parseInt(val, 10) || 0;
      }
      this.calculateBOMDeductions();
    }
  }

  addVerifySaleRow() {
    this.currentVerifySaleItems.push({ product_id: '', quantity_sold: 1, rate: 0 });
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

    list.innerHTML = '';
    warning.innerHTML = '';
    commitBtn.disabled = false;

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
      list.innerHTML = `<div class="empty-list-text" style="padding:1rem;">Select a mapped product to view warehouse stock covers.</div>`;
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
      div.style.padding = '0.5rem 0';
      div.style.borderBottom = '1px solid var(--border-light)';

      div.innerHTML = `
        <div>
          <div class="td-bold">${req.name} <span class="td-muted" style="font-size:0.75rem;">(${req.code})</span></div>
          <div class="td-muted" style="font-size:0.8rem;">Current Stock: ${req.stock.toFixed(0)} pcs</div>
        </div>
        <div style="text-align:right;">
          <div class="td-bold" style="color:${isShort ? 'var(--color-danger)' : 'var(--color-success)'};">${req.needed} pcs</div>
          <span class="badge badge-${isShort ? 'danger' : 'success'}">${isShort ? 'Shortage: -' + diff : 'Available'}</span>
        </div>
      `;
      list.appendChild(div);
    });

    if (deficit) {
      warning.innerHTML = `
        <div class="alert-banner danger" style="padding: 0.5rem 0.75rem; font-size:0.8rem; margin-bottom: 0.75rem;">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <div><strong>Stock Outward Shortage!</strong> You are selling more finished goods than currently available in warehouse stock.</div>
        </div>
      `;
    }
  }

  postVerifySale() {
    const invNo = document.getElementById('verify-sale-invoice').value.trim();
    const dateStr = document.getElementById('verify-sale-date').value;

    if (!invNo || !dateStr) {
      alert("Invoice No and Date are required.");
      return;
    }

    if (this.currentVerifySaleItems.some(i => !i.product_id)) {
      alert("Please map all products on invoice.");
      return;
    }

    const txItems = [];
    const productChanges = [];

    this.currentVerifySaleItems.forEach(item => {
      const prod = this.db.products.find(p => p.id === item.product_id);
      if (!prod) return;

      const qty = item.quantity_sold;
      const rate = item.rate || prod.selling_price;

      prod.current_stock = parseFloat(prod.current_stock || 0) - qty;

      txItems.push({ name: prod.name, qty, rate, total: qty * rate });
      productChanges.push({
        product_id: prod.id,
        product_name: prod.name,
        qty_change: -qty,
        direction: 'out'
      });
    });

    this.db.transactions.push({
      id: 'tx_' + Date.now(),
      type: 'sale',
      date: dateStr,
      invoice_no: invNo,
      description: `Sales Dispatch Outward: dispatched ${txItems.length} products.`,
      items: txItems,
      raw_material_changes: [],
      product_changes: productChanges
    });

    this.saveDb();
    this.closeModal('sale-verify-modal');
    this.refreshAllViews();
    
    alert("Outward committed! Finished goods warehouse balances updated.");
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
    const sorted = [...this.db.transactions].sort((a, b) => new Date(b.date) - new Date(a.date));

    if (sorted.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-list-text">No operational activities recorded yet. Use the daily mobile console or upload PDFs to log events.</td></tr>`;
      return;
    }

    sorted.forEach(tx => {
      const isPurchase = tx.type === 'purchase';
      const isSale = tx.type === 'sale';
      
      let typeBadge = `<span class="badge badge-info">Production run</span>`;
      if (isPurchase) typeBadge = `<span class="badge badge-success">Inward Purchase</span>`;
      else if (isSale) typeBadge = `<span class="badge badge-primary">Outward Sales</span>`;

      // Render details of adjustments
      let adjText = '';
      if (tx.raw_material_changes) {
        tx.raw_material_changes.forEach(c => {
          const sign = c.qty_change > 0 ? '+' : '';
          const color = c.qty_change > 0 ? 'var(--color-success)' : 'var(--color-danger)';
          adjText += `
            <div style="font-size:0.8rem; margin-bottom:0.15rem;">
              <strong>${c.material_name}:</strong> <span style="color:${color}; font-weight:600;">${sign}${c.qty_change.toFixed(3)}</span>
            </div>
          `;
        });
      }

      if (tx.product_changes) {
        tx.product_changes.forEach(c => {
          const sign = c.qty_change > 0 ? '+' : '';
          const color = c.qty_change > 0 ? 'var(--color-success)' : 'var(--color-danger)';
          adjText += `
            <div style="font-size:0.8rem; margin-bottom:0.15rem; color: var(--color-info);">
              <strong>[FG] ${c.product_name}:</strong> <span style="color:${color}; font-weight:600;">${sign}${c.qty_change.toFixed(0)} pcs</span>
            </div>
          `;
        });
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${tx.date}</td>
        <td>${typeBadge}</td>
        <td class="td-bold">${tx.invoice_no || 'N/A'}</td>
        <td class="td-muted" style="max-width:250px;">${tx.description}</td>
        <td>${adjText || '<span class="td-muted">-</span>'}</td>
        <td style="text-align: right;">${isSale ? '<span class="badge badge-warning">YES</span>' : '<span class="badge badge-success">N/A</span>'}</td>
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
}

// Initialize Application Globals
window.app = new MFPERP();
