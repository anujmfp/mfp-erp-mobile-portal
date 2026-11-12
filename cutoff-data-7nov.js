/**
 * MFP ERP - Cutoff Starting Inventory Dataset
 * Effective Cutoff Date: 7th November 2026 (07-Nov-2026)
 * Total Items: 100 (78 Raw Materials & Packaging Items, 22 Finished Goods SKUs)
 */

const MFP_CUTOFF_DATA_7NOV = {
  cutoffDate: '2026-11-07',
  version: '2026-11-07-v2',

  raw_materials: [
    // 1-14: Spices & Agricultural Raw Materials
    { id: 'rm_chilli_reg', code: 'RM-CHILLI-REG', name: 'Chilli Regular', category: 'Raw material', unit: 'Kgs', current_stock: 47.5, average_price: 265.0, buffer: 50.0, min_stock: 50.0, description: 'Regular grade dried red chilli flakes/powder' },
    { id: 'rm_chilli_deluxe', code: 'RM-CHILLI-DLX', name: 'Chilli Deluxe', category: 'Raw material', unit: 'Kgs', current_stock: 18.0, average_price: 295.0, buffer: 25.0, min_stock: 25.0, description: 'Deluxe grade premium dried red chilli' },
    { id: 'rm_oregano_flakes', code: 'RM-OREGANO-FLK', name: 'Oregano Flakes', category: 'Raw material', unit: 'Kgs', current_stock: 40.0, average_price: 210.0, buffer: 20.0, min_stock: 20.0, description: 'Aromatic dried oregano leaves' },
    { id: 'rm_oregano_powder', code: 'RM-OREGANO-PWD', name: 'Oregano Powder', category: 'Raw material', unit: 'Kgs', current_stock: 0.0, average_price: 210.0, buffer: 10.0, min_stock: 10.0, description: 'Ground dried oregano powder' },
    { id: 'rm_mint', code: 'RM-MINT', name: 'Mint', category: 'Raw material', unit: 'Kgs', current_stock: 9.5, average_price: 325.0, buffer: 5.0, min_stock: 5.0, description: 'Dried culinary mint leaves' },
    { id: 'rm_peri_peri', code: 'RM-PERI-PERI', name: 'Peri peri', category: 'Raw material', unit: 'Kgs', current_stock: 106.0, average_price: 325.0, buffer: 25.0, min_stock: 25.0, description: 'Spicy African Peri Peri blend spice' },
    { id: 'rm_peri_nong', code: 'RM-PERI-NONG', name: 'Peri peri NONG', category: 'Raw material', unit: 'Kgs', current_stock: 4.5, average_price: 300.0, buffer: 10.0, min_stock: 10.0, description: 'Peri Peri blend (No Onion No Garlic)' },
    { id: 'rm_rosemary', code: 'RM-ROSEMARY', name: 'Rosemary', category: 'Raw material', unit: 'Kgs', current_stock: 5.5, average_price: 475.0, buffer: 3.0, min_stock: 3.0, description: 'Aromatic whole dried rosemary needles' },
    { id: 'rm_thyme', code: 'RM-THYME', name: 'Thyme', category: 'Raw material', unit: 'Kgs', current_stock: 3.0, average_price: 350.0, buffer: 3.0, min_stock: 3.0, description: 'Dried culinary thyme leaves' },
    { id: 'rm_black_pepper', code: 'RM-BLK-PEPPER', name: 'Black Pepper', category: 'Raw material', unit: 'Kgs', current_stock: 2.0, average_price: 900.0, buffer: 1.0, min_stock: 1.0, description: 'Coarse ground black peppercorns' },
    { id: 'rm_salt', code: 'RM-SALT', name: 'Salt', category: 'Raw material', unit: 'Kgs', current_stock: 13.5, average_price: 30.0, buffer: 7.0, min_stock: 7.0, description: 'Food grade refined iodized salt' },
    { id: 'rm_cheese', code: 'RM-CHEESE', name: 'Cheese', category: 'Raw material', unit: 'Kgs', current_stock: 50.5, average_price: 275.0, buffer: 10.0, min_stock: 10.0, description: 'Dehydrated cheese powder seasoning' },
    { id: 'rm_chat_masala', code: 'RM-CHAT-MASALA', name: 'Chat Masala', category: 'Raw material', unit: 'Kgs', current_stock: 50.0, average_price: 140.0, buffer: 20.0, min_stock: 20.0, description: 'Tangy Indian chat seasoning mix' },
    { id: 'rm_roasted_garlic', code: 'RM-GARLIC-GRAN', name: 'Roasted Garlic Granules', category: 'Raw material', unit: 'Kgs', current_stock: 12.0, average_price: 230.0, buffer: 7.0, min_stock: 7.0, description: 'Toasted aromatic garlic granules' },

    // 35-47: Bottle Stickers (13 items)
    { id: 'pkg_btl_stk_oregano', code: 'STK-BTL-OREGANO', name: 'Bottle Stickers - Oregano', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 110, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Oregano bottle' },
    { id: 'pkg_btl_stk_mint', code: 'STK-BTL-MINT', name: 'Bottle Stickers - Mint', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 220, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Mint bottle' },
    { id: 'pkg_btl_stk_bombay', code: 'STK-BTL-BOMBAY-SW', name: 'Bottle Stickers - Bombay Sandwich Mix', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 330, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Bombay Sandwich bottle' },
    { id: 'pkg_btl_stk_chz_peri', code: 'STK-BTL-CHZ-PERI', name: 'Bottle Stickers - Cheese peri peri', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 242, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Cheese Peri Peri bottle' },
    { id: 'pkg_btl_stk_peri', code: 'STK-BTL-PERI-PERI', name: 'Bottle Stickers - Peri peri', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 242, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Peri Peri bottle' },
    { id: 'pkg_btl_stk_peri_nong', code: 'STK-BTL-PERI-NONG', name: 'Bottle Stickers - Peri Peri NONG', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 308, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Peri Peri NONG bottle' },
    { id: 'pkg_btl_stk_chz_nong', code: 'STK-BTL-CHZ-NONG', name: 'Bottle Stickers - Cheese Peri Peri NONG', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 396, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Cheese Peri Peri NONG bottle' },
    { id: 'pkg_btl_stk_chz_garlic', code: 'STK-BTL-CHZ-GARLIC', name: 'Bottle Stickers - Cheese Garlic Mix', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 308, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Cheese Garlic Mix bottle' },
    { id: 'pkg_btl_stk_basil', code: 'STK-BTL-BASIL', name: 'Bottle Stickers - Basil', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 231, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Basil bottle' },
    { id: 'pkg_btl_stk_italian', code: 'STK-BTL-ITALIAN-MIX', name: 'Bottle Stickers - Italian Masala Mix', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 220, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Italian Masala Mix bottle' },
    { id: 'pkg_btl_stk_herb', code: 'STK-BTL-HERB-MIX', name: 'Bottle Stickers - Herb Mix', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 187, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Herb Mix bottle' },
    { id: 'pkg_btl_stk_chilli', code: 'STK-BTL-CHILLI-FLK', name: 'Bottle Stickers - Chilli Flakes', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 198, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Chilli Flakes bottle' },
    { id: 'pkg_btl_stk_oregano_pz', code: 'STK-BTL-OREGANO-PZ', name: 'Bottle Stickers - Oregano pizza seasoning', category: 'Bottle Stickers', unit: 'Pcs', current_stock: 176, average_price: 2.7, buffer: 72, min_stock: 72, description: 'Front printed sticker for Oregano Pizza Seasoning bottle' },

    // 48-54: Material (Packaging Materials & Boxes) (7 items)
    { id: 'pkg_mat_pouch_box', code: 'BOX-POUCH', name: 'Pouch Box', category: 'Material', unit: 'Pcs', current_stock: 8, average_price: 50.0, buffer: 50, min_stock: 50, description: 'Master shipper corrugated box for pouches' },
    { id: 'pkg_mat_btl_outer_box', code: 'BOX-BTL-OUTER', name: 'Bottle Outer Box', category: 'Material', unit: 'Pcs', current_stock: 23, average_price: 50.0, buffer: 50, min_stock: 50, description: 'Master shipper outer corrugated box for bottles' },
    { id: 'pkg_mat_btl_inner_box', code: 'BOX-BTL-INNER', name: 'Bottle Inner Box', category: 'Material', unit: 'Pcs', current_stock: 300, average_price: 7.0, buffer: 50, min_stock: 50, description: 'Inner carton divider box for bottle sets' },
    { id: 'pkg_mat_box_holes', code: 'BOX-HOLES', name: 'Box with Holes', category: 'Material', unit: 'Pcs', current_stock: 540, average_price: 50.0, buffer: 50, min_stock: 50, description: 'Ventilated perforated display carton box' },
    { id: 'pkg_mat_alu_pouch', code: 'PCH-ALUMINIUM', name: 'Aluminimum Pouch', category: 'Material', unit: 'Pcs', current_stock: 690, average_price: 7.0, buffer: 50, min_stock: 50, description: 'Silver foil barrier pouches for bulk storage' },
    { id: 'pkg_mat_wads', code: 'MAT-WADS', name: 'Wads', category: 'Material', unit: 'Pcs', current_stock: 4550, average_price: 0.52, buffer: 1000, min_stock: 1000, description: 'Induction sealing cap liners / wads' },
    { id: 'pkg_mat_shrink', code: 'MAT-SHRINK-SLV', name: 'Shrink Sleeve', category: 'Material', unit: 'Pcs', current_stock: 3500, average_price: 0.023263, buffer: 1000, min_stock: 1000, description: 'Tamper evident transparent neck shrink sleeves' },

    // 55-68: Cap Stickers (14 items)
    { id: 'pkg_cap_stk_oregano', code: 'STK-CAP-OREGANO', name: 'Cap Stickers - Oregano', category: 'Cap Stickers', unit: 'Pcs', current_stock: 560, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Oregano' },
    { id: 'pkg_cap_stk_mint', code: 'STK-CAP-MINT', name: 'Cap Stickers - Mint', category: 'Cap Stickers', unit: 'Pcs', current_stock: 560, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Mint' },
    { id: 'pkg_cap_stk_bombay', code: 'STK-CAP-BOMBAY-SW', name: 'Cap Stickers - Bombay Sandwich Mix', category: 'Cap Stickers', unit: 'Pcs', current_stock: 630, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Bombay Sandwich' },
    { id: 'pkg_cap_stk_chz_peri', code: 'STK-CAP-CHZ-PERI', name: 'Cap Stickers - Cheese peri peri', category: 'Cap Stickers', unit: 'Pcs', current_stock: 700, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Cheese Peri Peri' },
    { id: 'pkg_cap_stk_peri', code: 'STK-CAP-PERI-PERI', name: 'Cap Stickers - Peri peri', category: 'Cap Stickers', unit: 'Pcs', current_stock: 490, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Peri Peri' },
    { id: 'pkg_cap_stk_peri_nong', code: 'STK-CAP-PERI-NONG', name: 'Cap Stickers - Peri Peri NONG', category: 'Cap Stickers', unit: 'Pcs', current_stock: 630, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Peri Peri NONG' },
    { id: 'pkg_cap_stk_chz_nong', code: 'STK-CAP-CHZ-NONG', name: 'Cap Stickers - Cheese Peri Peri NONG', category: 'Cap Stickers', unit: 'Pcs', current_stock: 910, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Cheese Peri Peri NONG' },
    { id: 'pkg_cap_stk_chz_garlic', code: 'STK-CAP-CHZ-GARLIC', name: 'Cap Stickers - Cheese Garlic Mix', category: 'Cap Stickers', unit: 'Pcs', current_stock: 350, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Cheese Garlic Mix' },
    { id: 'pkg_cap_stk_basil', code: 'STK-CAP-BASIL', name: 'Cap Stickers - Basil', category: 'Cap Stickers', unit: 'Pcs', current_stock: 420, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Basil' },
    { id: 'pkg_cap_stk_italian', code: 'STK-CAP-ITALIAN-MIX', name: 'Cap Stickers - Italian Masala Mix', category: 'Cap Stickers', unit: 'Pcs', current_stock: 910, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Italian Masala Mix' },
    { id: 'pkg_cap_stk_herb_mix', code: 'STK-CAP-HERB-MIX', name: 'Cap Stickers - Italian Herb Mix', category: 'Cap Stickers', unit: 'Pcs', current_stock: 630, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Italian Herb Mix' },
    { id: 'pkg_cap_stk_chilli', code: 'STK-CAP-CHILLI-FLK', name: 'Cap Stickers - Chilli Flakes', category: 'Cap Stickers', unit: 'Pcs', current_stock: 420, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Chilli Flakes' },
    { id: 'pkg_cap_stk_oregano_pz', code: 'STK-CAP-OREGANO-PZ', name: 'Cap Stickers - Oregano pizza seasoning', category: 'Cap Stickers', unit: 'Pcs', current_stock: 630, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Oregano Pizza Seasoning' },
    { id: 'pkg_cap_stk_mix_herb', code: 'STK-CAP-MIX-HERB', name: 'Cap Stickers - Mix Herb', category: 'Cap Stickers', unit: 'Pcs', current_stock: 280, average_price: 0.4214, buffer: 140, min_stock: 140, description: 'Top round cap sticker for Mix Herb' },

    // 71-83: Horeca Stickers (13 items)
    { id: 'pkg_hrc_stk_oregano', code: 'STK-HRC-OREGANO', name: 'Horeca Stickers - Oregano', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 56, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Oregano' },
    { id: 'pkg_hrc_stk_mint', code: 'STK-HRC-MINT', name: 'Horeca Stickers - Mint', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 24, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Mint' },
    { id: 'pkg_hrc_stk_bombay', code: 'STK-HRC-BOMBAY-SW', name: 'Horeca Stickers - Bombay Sandwich Mix', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 20, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Bombay Sandwich' },
    { id: 'pkg_hrc_stk_chz_peri', code: 'STK-HRC-CHZ-PERI', name: 'Horeca Stickers - Cheese peri peri', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 28, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Cheese Peri Peri' },
    { id: 'pkg_hrc_stk_peri', code: 'STK-HRC-PERI-PERI', name: 'Horeca Stickers - Peri peri', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 32, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Peri Peri' },
    { id: 'pkg_hrc_stk_peri_nong', code: 'STK-HRC-PERI-NONG', name: 'Horeca Stickers - Peri Peri NONG', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 16, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Peri Peri NONG' },
    { id: 'pkg_hrc_stk_chz_nong', code: 'STK-HRC-CHZ-NONG', name: 'Horeca Stickers - Cheese Peri Peri NONG', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 20, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Cheese Peri Peri NONG' },
    { id: 'pkg_hrc_stk_chz_garlic', code: 'STK-HRC-CHZ-GARLIC', name: 'Horeca Stickers - Cheese Garlic Mix', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 20, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Cheese Garlic Mix' },
    { id: 'pkg_hrc_stk_basil', code: 'STK-HRC-BASIL', name: 'Horeca Stickers - Basil', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 12, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Basil' },
    { id: 'pkg_hrc_stk_italian', code: 'STK-HRC-ITALIAN-MIX', name: 'Horeca Stickers - Italian Masala Mix', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 8, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Italian Masala Mix' },
    { id: 'pkg_hrc_stk_herb_mix', code: 'STK-HRC-HERB-MIX', name: 'Horeca Stickers - Italian Herb Mix', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 8, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Italian Herb Mix' },
    { id: 'pkg_hrc_stk_chilli', code: 'STK-HRC-CHILLI-FLK', name: 'Horeca Stickers - Chilli Flakes', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 40, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Chilli Flakes' },
    { id: 'pkg_hrc_stk_oregano_pz', code: 'STK-HRC-OREGANO-PZ', name: 'Horeca Stickers - Oregano pizza seasoning', category: 'Horeca Stickers', unit: 'Pcs', current_stock: 12, average_price: 7.375, buffer: 12, min_stock: 12, description: 'Horeca bulk pack label for Oregano Pizza Seasoning' },

    // 84-87: Caps (4 items)
    { id: 'pkg_caps_red', code: 'CAP-RED', name: 'Caps - Red', category: 'Caps', unit: 'Pcs', current_stock: 1910, average_price: 2.832, buffer: 500, min_stock: 500, description: 'Red plastic shaker flip cap for spice bottles' },
    { id: 'pkg_caps_black', code: 'CAP-BLACK', name: 'Caps - Black', category: 'Caps', unit: 'Pcs', current_stock: 2080, average_price: 2.832, buffer: 500, min_stock: 500, description: 'Black plastic shaker flip cap for spice bottles' },
    { id: 'pkg_caps_orange', code: 'CAP-ORANGE', name: 'Caps - Orange', category: 'Caps', unit: 'Pcs', current_stock: 1250, average_price: 2.832, buffer: 500, min_stock: 500, description: 'Orange plastic shaker flip cap for spice bottles' },
    { id: 'pkg_caps_green', code: 'CAP-GREEN', name: 'Caps - Green', category: 'Caps', unit: 'Pcs', current_stock: 1000, average_price: 2.832, buffer: 500, min_stock: 500, description: 'Green plastic shaker flip cap for spice bottles' },

    // 88-94: Pouch Roll (7 items)
    { id: 'pkg_pch_roll_chilli', code: 'ROL-PCH-CHILLI', name: 'Pouch Roll - Chilli Flakes', category: 'Pouch Roll', unit: 'Pcs', current_stock: 92000, average_price: 0.531, buffer: 15000, min_stock: 15000, description: 'Printed laminated film roll for Chilli Flakes pouches' },
    { id: 'pkg_pch_roll_oregano', code: 'ROL-PCH-OREGANO', name: 'Pouch Roll - Oregano', category: 'Pouch Roll', unit: 'Pcs', current_stock: 35600, average_price: 0.531, buffer: 10000, min_stock: 10000, description: 'Printed laminated film roll for Oregano pouches' },
    { id: 'pkg_pch_roll_bombay', code: 'ROL-PCH-BOMBAY-SW', name: 'Pouch Roll - Bombay Sandwich Mix', category: 'Pouch Roll', unit: 'Pcs', current_stock: 20000, average_price: 0.531, buffer: 5000, min_stock: 5000, description: 'Printed laminated film roll for Bombay Sandwich pouches' },
    { id: 'pkg_pch_roll_italian', code: 'ROL-PCH-ITALIAN', name: 'Pouch Roll - Italian Masala Mix', category: 'Pouch Roll', unit: 'Pcs', current_stock: 120000, average_price: 0.531, buffer: 5000, min_stock: 5000, description: 'Printed laminated film roll for Italian Masala Mix pouches' },
    { id: 'pkg_pch_roll_peri', code: 'ROL-PCH-PERI', name: 'Pouch Roll - Peri peri', category: 'Pouch Roll', unit: 'Pcs', current_stock: 40000, average_price: 0.531, buffer: 5000, min_stock: 5000, description: 'Printed laminated film roll for Peri Peri pouches' },
    { id: 'pkg_pch_roll_chz_peri', code: 'ROL-PCH-CHZ-PERI', name: 'Pouch Roll - Cheese Peri Peri', category: 'Pouch Roll', unit: 'Pcs', current_stock: 75000, average_price: 0.531, buffer: 5000, min_stock: 5000, description: 'Printed laminated film roll for Cheese Peri Peri pouches' },
    { id: 'pkg_pch_roll_oregano_pz', code: 'ROL-PCH-OREGANO-PZ', name: 'Pouch Roll - Oregano pizza seasoning', category: 'Pouch Roll', unit: 'Pcs', current_stock: 300, average_price: 0.531, buffer: 10000, min_stock: 10000, description: 'Printed laminated film roll for Oregano Pizza Seasoning pouches' },

    // 95-96: Sachet Roll (2 items)
    { id: 'pkg_sch_roll_italian', code: 'ROL-SCH-ITALIAN-1G', name: 'Sachet Roll - Italian Seasoning - 1 gm', category: 'Sachet Roll', unit: 'Pcs', current_stock: 111750, average_price: 0.07965, buffer: 20000, min_stock: 20000, description: 'Form-fill-seal barrier roll for 1gm Italian Seasoning sachets' },
    { id: 'pkg_sch_roll_chilli', code: 'ROL-SCH-CHILLI-1G', name: 'Sachet Roll - Chilli Flakes - 1 gm', category: 'Sachet Roll', unit: 'Pcs', current_stock: 111250, average_price: 0.07965, buffer: 20000, min_stock: 20000, description: 'Form-fill-seal barrier roll for 1gm Chilli Flakes sachets' },

    // 97-100: Miscellaneous Consumables & Marketing (4 items)
    { id: 'pkg_tape_truflavr', code: 'MAT-TAPE-TRU', name: 'Cello tape - truFLAVR tape', category: 'Cello tape', unit: 'Pcs', current_stock: 400, average_price: 10.0, buffer: 50, min_stock: 50, description: 'Custom printed branded packing tape rolls' },
    { id: 'pkg_sample_box', code: 'BOX-SAMPLE-TRU', name: 'Sample Box - truflavr sample box', category: 'Sample Box', unit: 'Pcs', current_stock: 50, average_price: 25.0, buffer: 10, min_stock: 10, description: 'Rigid presentation sample kit boxes' },
    { id: 'pkg_hangers', code: 'MKT-HANGERS', name: 'Hangers - truflavr pouch hangers', category: 'Hangers', unit: 'Pcs', current_stock: 500, average_price: 15.0, buffer: 50, min_stock: 50, description: 'Retail strip hanging display strips for pouches' },
    { id: 'pkg_posters', code: 'MKT-POSTERS', name: 'Posters - truflavr store posters', category: 'Posters', unit: 'Pcs', current_stock: 50, average_price: 15.0, buffer: 20, min_stock: 20, description: 'A3 laminated retail store promotional posters' }
  ],

  products: [
    // 15-21: FG - Pouches (7 items)
    {
      id: 'fg_pch_oregano',
      code: 'FG-PCH-OREGANO',
      name: 'Oregano Pouch',
      packaging_type: 'Pouches',
      current_stock: 4000,
      price: 5.0,
      selling_price: 5.0,
      buffer: 2000,
      min_stock: 2000,
      description: 'truFLAVR Oregano packed in airtight pouch',
      bom: [
        { material_id: 'rm_oregano_flakes', quantity: 0.010, wastage_percentage: 1.5 },
        { material_id: 'pkg_pch_roll_oregano', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_pch_periperi',
      code: 'FG-PCH-PERIPERI',
      name: 'Peri peri Pouch',
      packaging_type: 'Pouches',
      current_stock: 400,
      price: 5.0,
      selling_price: 5.0,
      buffer: 1000,
      min_stock: 1000,
      description: 'truFLAVR Peri Peri blend pouch',
      bom: [
        { material_id: 'rm_peri_peri', quantity: 0.008, wastage_percentage: 1.5 },
        { material_id: 'rm_salt', quantity: 0.002, wastage_percentage: 0.5 },
        { material_id: 'pkg_pch_roll_peri', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_pch_cheese_peri',
      code: 'FG-PCH-CHZ-PERI',
      name: 'Cheese peri peri Pouch',
      packaging_type: 'Pouches',
      current_stock: 1000,
      price: 5.0,
      selling_price: 5.0,
      buffer: 1000,
      min_stock: 1000,
      description: 'truFLAVR Cheese Peri Peri seasoning pouch',
      bom: [
        { material_id: 'rm_cheese', quantity: 0.005, wastage_percentage: 1.5 },
        { material_id: 'rm_peri_peri', quantity: 0.004, wastage_percentage: 1.5 },
        { material_id: 'rm_salt', quantity: 0.001, wastage_percentage: 0.5 },
        { material_id: 'pkg_pch_roll_chz_peri', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_pch_chilli_flakes',
      code: 'FG-PCH-CHILLI-FLK',
      name: 'Chilli Flakes Pouch',
      packaging_type: 'Pouches',
      current_stock: 1700,
      price: 5.0,
      selling_price: 5.0,
      buffer: 2000,
      min_stock: 2000,
      description: 'truFLAVR Red Chilli Flakes Pouch (uses Chilli Regular)',
      bom: [
        // Rule: chilli flakes in pouch and sachet the regular to be used!
        { material_id: 'rm_chilli_reg', quantity: 0.010, wastage_percentage: 1.5 },
        { material_id: 'pkg_pch_roll_chilli', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_pch_bombay_sw',
      code: 'FG-PCH-BOMBAY-SW',
      name: 'Bombay Sandwich Mix Pouch',
      packaging_type: 'Pouches',
      current_stock: 2900,
      price: 5.0,
      selling_price: 5.0,
      buffer: 1000,
      min_stock: 1000,
      description: 'truFLAVR Bombay Sandwich masala pouch',
      bom: [
        { material_id: 'rm_chat_masala', quantity: 0.005, wastage_percentage: 1.5 },
        { material_id: 'rm_chilli_reg', quantity: 0.002, wastage_percentage: 1.0 },
        { material_id: 'rm_salt', quantity: 0.003, wastage_percentage: 0.5 },
        { material_id: 'pkg_pch_roll_bombay', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_pch_italian_mix',
      code: 'FG-PCH-ITALIAN-MIX',
      name: 'Italian Masala Mix Pouch',
      packaging_type: 'Pouches',
      current_stock: 2000,
      price: 5.0,
      selling_price: 5.0,
      buffer: 1000,
      min_stock: 1000,
      description: 'truFLAVR Italian masala mix pouch (uses Chilli Regular)',
      bom: [
        // Rule: in italian seasoning / oregano seasoning etc regular to be used!
        { material_id: 'rm_oregano_flakes', quantity: 0.004, wastage_percentage: 1.5 },
        { material_id: 'rm_chilli_reg', quantity: 0.003, wastage_percentage: 1.0 },
        { material_id: 'rm_thyme', quantity: 0.001, wastage_percentage: 1.0 },
        { material_id: 'rm_salt', quantity: 0.002, wastage_percentage: 0.5 },
        { material_id: 'pkg_pch_roll_italian', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_pch_oregano_pizza',
      code: 'FG-PCH-OREGANO-PZ',
      name: 'Oregano pizza seasoning Pouch',
      packaging_type: 'Pouches',
      current_stock: 3000,
      price: 5.0,
      selling_price: 5.0,
      buffer: 2000,
      min_stock: 2000,
      description: 'truFLAVR Oregano Pizza Seasoning pouch (uses Chilli Regular)',
      bom: [
        // Rule: in italian seasoning / oregano seasoning etc regular to be used!
        { material_id: 'rm_oregano_flakes', quantity: 0.005, wastage_percentage: 1.5 },
        { material_id: 'rm_chilli_reg', quantity: 0.003, wastage_percentage: 1.0 },
        { material_id: 'rm_salt', quantity: 0.002, wastage_percentage: 0.5 },
        { material_id: 'pkg_pch_roll_oregano_pz', quantity: 1, wastage_percentage: 0 }
      ]
    },

    // 22-34: FG - Bottle (13 items)
    {
      id: 'fg_btl_oregano',
      code: 'FG-BTL-OREGANO',
      name: 'Oregano Bottle',
      packaging_type: 'Bottles',
      current_stock: 7,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Oregano glass shaker bottle',
      bom: [
        { material_id: 'rm_oregano_flakes', quantity: 0.025, wastage_percentage: 1.5 },
        { material_id: 'pkg_btl_stk_oregano', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_oregano', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_green', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_mint',
      code: 'FG-BTL-MINT',
      name: 'Mint Bottle',
      packaging_type: 'Bottles',
      current_stock: 62,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Mint glass shaker bottle',
      bom: [
        { material_id: 'rm_mint', quantity: 0.030, wastage_percentage: 1.5 },
        { material_id: 'pkg_btl_stk_mint', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_mint', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_green', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_bombay_sw',
      code: 'FG-BTL-BOMBAY-SW',
      name: 'Bombay Sandwich Mix Bottle',
      packaging_type: 'Bottles',
      current_stock: 33,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Bombay Sandwich masala shaker bottle',
      bom: [
        { material_id: 'rm_chat_masala', quantity: 0.025, wastage_percentage: 1.5 },
        { material_id: 'rm_chilli_reg', quantity: 0.010, wastage_percentage: 1.0 },
        { material_id: 'rm_salt', quantity: 0.015, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_bombay', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_bombay', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_orange', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_cheese_peri',
      code: 'FG-BTL-CHZ-PERI',
      name: 'Cheese peri peri Bottle',
      packaging_type: 'Bottles',
      current_stock: 39,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Cheese Peri Peri shaker bottle',
      bom: [
        { material_id: 'rm_cheese', quantity: 0.025, wastage_percentage: 1.5 },
        { material_id: 'rm_peri_peri', quantity: 0.020, wastage_percentage: 1.5 },
        { material_id: 'rm_salt', quantity: 0.005, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_chz_peri', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_chz_peri', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_orange', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_peri_peri',
      code: 'FG-BTL-PERI-PERI',
      name: 'Peri peri Bottle',
      packaging_type: 'Bottles',
      current_stock: 38,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Peri Peri blend shaker bottle',
      bom: [
        { material_id: 'rm_peri_peri', quantity: 0.040, wastage_percentage: 1.5 },
        { material_id: 'rm_salt', quantity: 0.010, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_peri', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_peri', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_orange', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_peri_nong',
      code: 'FG-BTL-PERI-NONG',
      name: 'Peri Peri NONG Bottle',
      packaging_type: 'Bottles',
      current_stock: 8,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Peri Peri (No Onion No Garlic) bottle',
      bom: [
        { material_id: 'rm_peri_nong', quantity: 0.040, wastage_percentage: 1.5 },
        { material_id: 'rm_salt', quantity: 0.010, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_peri_nong', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_peri_nong', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_orange', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_cheese_peri_nong',
      code: 'FG-BTL-CHZ-PERI-NONG',
      name: 'Cheese Peri Peri NONG Bottle',
      packaging_type: 'Bottles',
      current_stock: 24,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Cheese Peri Peri (No Onion No Garlic) bottle',
      bom: [
        { material_id: 'rm_cheese', quantity: 0.025, wastage_percentage: 1.5 },
        { material_id: 'rm_peri_nong', quantity: 0.020, wastage_percentage: 1.5 },
        { material_id: 'rm_salt', quantity: 0.005, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_chz_nong', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_chz_nong', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_orange', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_cheese_garlic',
      code: 'FG-BTL-CHZ-GARLIC',
      name: 'Cheese Garlic Mix Bottle',
      packaging_type: 'Bottles',
      current_stock: 19,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Cheese Garlic seasoning shaker bottle',
      bom: [
        { material_id: 'rm_cheese', quantity: 0.025, wastage_percentage: 1.5 },
        { material_id: 'rm_roasted_garlic', quantity: 0.015, wastage_percentage: 1.5 },
        { material_id: 'rm_salt', quantity: 0.010, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_chz_garlic', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_chz_garlic', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_orange', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_basil',
      code: 'FG-BTL-BASIL',
      name: 'Basil Bottle',
      packaging_type: 'Bottles',
      current_stock: 50,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Sweet Basil shaker bottle',
      bom: [
        { material_id: 'rm_oregano_flakes', quantity: 0.025, wastage_percentage: 1.5 },
        { material_id: 'pkg_btl_stk_basil', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_basil', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_green', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_italian_mix',
      code: 'FG-BTL-ITALIAN-MIX',
      name: 'Italian Masala Mix Bottle',
      packaging_type: 'Bottles',
      current_stock: 30,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Italian Masala seasoning shaker bottle (uses Chilli Regular)',
      bom: [
        // Rule: in italian seasoning / oregano seasoning etc regular to be used!
        { material_id: 'rm_oregano_flakes', quantity: 0.020, wastage_percentage: 1.5 },
        { material_id: 'rm_chilli_reg', quantity: 0.015, wastage_percentage: 1.0 },
        { material_id: 'rm_thyme', quantity: 0.005, wastage_percentage: 1.0 },
        { material_id: 'rm_salt', quantity: 0.010, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_italian', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_italian', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_green', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_herb_mix',
      code: 'FG-BTL-HERB-MIX',
      name: 'Herb Mix Bottle',
      packaging_type: 'Bottles',
      current_stock: 47,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Mixed Herbs culinary seasoning shaker bottle',
      bom: [
        { material_id: 'rm_oregano_flakes', quantity: 0.020, wastage_percentage: 1.5 },
        { material_id: 'rm_thyme', quantity: 0.015, wastage_percentage: 1.0 },
        { material_id: 'rm_rosemary', quantity: 0.010, wastage_percentage: 1.0 },
        { material_id: 'rm_black_pepper', quantity: 0.005, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_herb', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_herb', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_green', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_chilli_flakes',
      code: 'FG-BTL-CHILLI-FLK',
      name: 'Chilli Flakes Bottle',
      packaging_type: 'Bottles',
      current_stock: 19,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Chilli Flakes glass shaker bottle (uses Chilli Deluxe)',
      bom: [
        // Rule: in bottle and horeca the deluxe to be used!
        { material_id: 'rm_chilli_deluxe', quantity: 0.045, wastage_percentage: 1.5 },
        { material_id: 'pkg_btl_stk_chilli', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_chilli', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_red', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_btl_oregano_pizza',
      code: 'FG-BTL-OREGANO-PZ',
      name: 'Oregano pizza seasoning Bottle',
      packaging_type: 'Bottles',
      current_stock: 6,
      price: 50.0,
      selling_price: 50.0,
      buffer: 36,
      min_stock: 36,
      description: 'truFLAVR Oregano Pizza Seasoning bottle (uses Chilli Regular)',
      bom: [
        // Rule: in italian seasoning / oregano seasoning etc regular to be used!
        { material_id: 'rm_oregano_flakes', quantity: 0.025, wastage_percentage: 1.5 },
        { material_id: 'rm_chilli_reg', quantity: 0.015, wastage_percentage: 1.0 },
        { material_id: 'rm_salt', quantity: 0.010, wastage_percentage: 0.5 },
        { material_id: 'pkg_btl_stk_oregano_pz', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_cap_stk_oregano_pz', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_caps_green', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_wads', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_shrink', quantity: 1, wastage_percentage: 0 }
      ]
    },

    // 69-70: FG- Sachets (2 items)
    {
      id: 'fg_sachet_chilli_flakes',
      code: 'FG-SCH-CHILLI-1G',
      name: 'Chilli Flakes - 1 gm Sachet',
      packaging_type: 'Sachets',
      current_stock: 2600,
      price: 0.47,
      selling_price: 0.47,
      buffer: 2000,
      min_stock: 2000,
      description: 'truFLAVR 1 gm individual portion sachet (uses Chilli Regular)',
      bom: [
        // Rule: chilli flakes in pouch and sachet the regular to be used!
        { material_id: 'rm_chilli_reg', quantity: 0.001, wastage_percentage: 1.0 },
        { material_id: 'pkg_sch_roll_chilli', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_sachet_italian_seasoning',
      code: 'FG-SCH-ITALIAN-1G',
      name: 'Italian Seasoning - 1 gm Sachet',
      packaging_type: 'Sachets',
      current_stock: 2600,
      price: 0.47,
      selling_price: 0.47,
      buffer: 2000,
      min_stock: 2000,
      description: 'truFLAVR 1 gm Italian Seasoning sachet (uses Chilli Regular)',
      bom: [
        // Rule: in italian seasoning / oregano seasoning etc regular to be used!
        { material_id: 'rm_oregano_flakes', quantity: 0.0006, wastage_percentage: 1.0 },
        { material_id: 'rm_chilli_reg', quantity: 0.0003, wastage_percentage: 1.0 },
        { material_id: 'rm_salt', quantity: 0.0001, wastage_percentage: 0.5 },
        { material_id: 'pkg_sch_roll_italian', quantity: 1, wastage_percentage: 0 }
      ]
    },

    // Horeca standard SKUs
    {
      id: 'fg_hrc_chilli_flakes',
      code: 'FG-HRC-CHILLI-500G',
      name: 'Chilli Flakes Horeca 500g',
      packaging_type: 'Horeca',
      current_stock: 0,
      price: 180.0,
      selling_price: 180.0,
      buffer: 10,
      min_stock: 10,
      description: 'truFLAVR 500g bulk Horeca food-service pack (uses Chilli Deluxe)',
      bom: [
        // Rule: in bottle and horeca the deluxe to be used!
        { material_id: 'rm_chilli_deluxe', quantity: 0.500, wastage_percentage: 1.5 },
        { material_id: 'pkg_hrc_stk_chilli', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_alu_pouch', quantity: 1, wastage_percentage: 0 }
      ]
    },
    {
      id: 'fg_hrc_oregano',
      code: 'FG-HRC-OREGANO-500G',
      name: 'Oregano Horeca 500g',
      packaging_type: 'Horeca',
      current_stock: 0,
      price: 140.0,
      selling_price: 140.0,
      buffer: 10,
      min_stock: 10,
      description: 'truFLAVR 500g bulk Horeca food-service pack',
      bom: [
        { material_id: 'rm_oregano_flakes', quantity: 0.500, wastage_percentage: 1.5 },
        { material_id: 'pkg_hrc_stk_oregano', quantity: 1, wastage_percentage: 0 },
        { material_id: 'pkg_mat_alu_pouch', quantity: 1, wastage_percentage: 0 }
      ]
    }
  ]
};

// Export for Node or Browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MFP_CUTOFF_DATA_7NOV;
}
if (typeof window !== 'undefined') {
  window.MFP_CUTOFF_DATA_7NOV = MFP_CUTOFF_DATA_7NOV;
}
