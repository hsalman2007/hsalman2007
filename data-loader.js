// Fetches the 4 published Google Sheets CSVs at runtime and builds window.SALES_DATA.
// Optimized for low memory: CSV rows are parsed as plain arrays (not per-row objects with
// every column as a key), which matters a lot for the ~66k-row transactions sheet on phones.
(function () {
  var URLS = {
    transactions: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR9InwQaae4ZY9fienoHTSPOMH97qAKhshPnwGK8qLcfVEK2RLDTd_mF7EvK7V82oTp1l5tcBH9BinG/pub?gid=1654824527&single=true&output=csv',
    stores: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR9InwQaae4ZY9fienoHTSPOMH97qAKhshPnwGK8qLcfVEK2RLDTd_mF7EvK7V82oTp1l5tcBH9BinG/pub?gid=880231275&single=true&output=csv',
    images: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vR9InwQaae4ZY9fienoHTSPOMH97qAKhshPnwGK8qLcfVEK2RLDTd_mF7EvK7V82oTp1l5tcBH9BinG/pub?gid=523844261&single=true&output=csv',
    inventory: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTXoJBhBVTrrYf_xlQJRl_976rljaBcsdy2I9EElIxBmSJIuq8dgmkWggqJ4-irRW1jPoPzRvBSTsMr/pub?gid=246571141&single=true&output=csv',
    master: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRYhc7C74NFacTqzPcbnXoRrEM-t7VTaWhuaxnOU-hcQ6SfCL_7f0SuNjsoenNHX7gXhUpvsh1b8ndI/pub?gid=2038053133&single=true&output=csv',
    clearance: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRCKIvh74Wgh9SmrdqGMN6Jmo6fz0xoYLukZZtGb5ZdGlDWWzg213kcaPp504-VQAQR-aZtc8_nbtxD/pub?gid=1407655889&single=true&output=csv',
  };
  var CACHE_KEY = 'transSalesData_v1';

  // Parses CSV into {headers, rows}: rows are plain arrays (no per-row objects), which is
  // far lighter on memory for large sheets. Only picks the columns named in `want` (array of
  // header names) — every other column is dropped immediately instead of being retained.
  function parseCsvPicked(text, want) {
    var headers = null;
    var wantIdx = null; // positions in the source row we care about, in `want` order
    var out = [];
    var field = '';
    var row = [];
    var inQuotes = false;
    var rowNum = 0;

    function endField() { row.push(field); field = ''; }
    function endRow() {
      endField();
      if (rowNum === 0) {
        headers = row.map(function (h) { return h.trim(); });
        wantIdx = want.map(function (w) { return headers.indexOf(w); });
      } else if (row.length > 1 || row[0]) {
        var picked = new Array(want.length);
        for (var k = 0; k < want.length; k++) {
          var idx = wantIdx[k];
          picked[k] = idx >= 0 && row[idx] !== undefined ? row[idx].trim() : '';
        }
        out.push(picked);
      }
      rowNum++;
      row = [];
    }

    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') endField();
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') endRow();
      else field += c;
    }
    if (field.length || row.length) endRow();
    return out; // array of arrays, columns in `want` order
  }

  function parseDateStr(s) {
    if (!s) return null;
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    var day = m[1].length < 2 ? '0' + m[1] : m[1];
    var month = m[2].length < 2 ? '0' + m[2] : m[2];
    return m[3] + '-' + month + '-' + day;
  }

  var TX_COLS = ['Store No.', 'Item No.', 'Barcode No.', 'Date', 'Quantity', 'Net Amount', 'Item Category Code', 'Item Description'];
  var STORE_COLS = ['STORE C', 'Short Name', 'Region', 'Arabic Name'];
  var IMG_COLS = ['SKU', 'Part#', 'img links'];
  var INV_COLS = ['Item No.', 'StoreEN', 'Sum of SOH', 'Description 2'];
  var MASTER_COLS = ['No.', 'No. 2', 'Description', 'Description 2', 'Unit Price Including VAT'];
  var CLEARANCE_COLS = ['No.', 'Offer Price Including VAT'];

  var EXCLUDED_LABELS = ['3p online', 'al saif gallery', 'b&q', 'carrefour', 'exhibition', 'ho', 'jahezwh', 'photoshoot', 'sadhan', 'samples', 'tailor workshop', 'wholesale', 'wholesale transfers'];
  function isExcludedLabel(s) { return !!s && EXCLUDED_LABELS.indexOf(String(s).trim().toLowerCase()) !== -1; }

  function build(txRows, storeRows, imgRows, invRows, masterRows, clearanceRows) {
    var storeMap = {};
    var regionSet = {};
    var excludedCodes = {};
    var excludedNames = {};
    var nameToRegion = {};
    var codeByName = {};
    storeRows.forEach(function (r) {
      var code = r[0], shortName = r[1], region = r[2] || '', nameAr = r[3] || '';
      if (isExcludedLabel(region) || isExcludedLabel(shortName)) {
        if (code) excludedCodes[code] = true;
        if (shortName) excludedNames[shortName] = true;
        return;
      }
      if (code) storeMap[code] = { name: shortName || code, region: region, nameAr: nameAr };
      if (region) regionSet[region] = true;
      nameToRegion[shortName || code] = region;
      codeByName[shortName || code] = code;
    });
    var regions = Object.keys(regionSet).sort();

    var imageMap = {};
    imgRows.forEach(function (r) {
      var sku = r[0];
      if (!sku) return;
      imageMap[sku] = { partNo: r[1], image: r[2] };
    });

    var stockMap = {};
    var invDescMap = {};
    invRows.forEach(function (r) {
      var itemNo = r[0], storeEN = r[1], soh = parseFloat(r[2]) || 0, invDesc = r[3];
      if (!itemNo || !storeEN) return;
      if (excludedNames[storeEN]) return;
      if (!stockMap[itemNo]) stockMap[itemNo] = {};
      stockMap[itemNo][storeEN] = (stockMap[itemNo][storeEN] || 0) + soh;
      if (invDesc && !invDescMap[itemNo]) invDescMap[itemNo] = invDesc;
    });

    var masterMap = {};
    masterRows.forEach(function (r) {
      var itemNo = r[0];
      if (!itemNo) return;
      masterMap[itemNo] = { no2: r[1] || '', descAr: r[2] || '', descEn: r[3] || '', rsp: parseFloat(String(r[4]).replace(/,/g, '')) };
    });

    var clearanceMap = {};
    clearanceRows.forEach(function (r) {
      var itemNo = r[0];
      if (!itemNo) return;
      var p = parseFloat(String(r[1]).replace(/,/g, ''));
      if (!isNaN(p)) clearanceMap[itemNo] = p;
    });

    var itemsMap = {};
    var storeCodesUsed = {};
    var minDate = null, maxDate = null;
    for (var i = 0; i < txRows.length; i++) {
      var r = txRows[i];
      var storeCode = r[0], item = r[1], barcode = r[2];
      var dateStr = parseDateStr(r[3]);
      var qty = parseFloat(r[4]) || 0;
      var net = parseFloat(r[5]) || 0;
      var cat = r[6], desc = r[7];
      if (!item || !storeCode || !dateStr) continue;
      if (excludedCodes[storeCode]) continue;
      storeCodesUsed[storeCode] = true;
      if (!minDate || dateStr < minDate) minDate = dateStr;
      if (!maxDate || dateStr > maxDate) maxDate = dateStr;
      var it = itemsMap[item];
      if (!it) { it = itemsMap[item] = { no: item, desc: '', cat: '', barcode: '', keyMap: {} }; }
      if (desc) it.desc = desc;
      if (cat) it.cat = cat;
      if (barcode) it.barcode = barcode;
      var key = storeCode + '|' + dateStr;
      var entry = it.keyMap[key];
      if (!entry) { entry = it.keyMap[key] = { storeCode: storeCode, date: dateStr, qty: 0, net: 0 }; }
      entry.qty += qty;
      entry.net += net;
    }

    var itemsArr = [];
    var allItemNos = {};
    for (var no0 in itemsMap) allItemNos[no0] = true;
    for (var no1 in stockMap) allItemNos[no1] = true;
    for (var no in allItemNos) {
      var it2 = itemsMap[no] || { no: no, desc: '', cat: '', barcode: '', keyMap: {} };
      var img = imageMap[no];
      var rows = [];
      var seenStores = {};
      for (var k in it2.keyMap) {
        var v = it2.keyMap[k];
        var si = storeMap[v.storeCode];
        if (!si) continue;
        rows.push({
          store: si.name, storeAr: si.nameAr || '', storeCode: v.storeCode, region: si.region, date: v.date,
          qty: -v.qty, net: Math.round(-v.net * 100) / 100,
        });
        seenStores[si.name] = true;
      }
      var stockForItem = stockMap[no] || {};
      for (var storeName in stockForItem) {
        if (seenStores[storeName]) continue;
        rows.push({ store: storeName, storeAr: '', storeCode: codeByName[storeName] || '', region: nameToRegion[storeName] || '', date: null, qty: 0, net: 0 });
      }
      var mst = masterMap[no];
      itemsArr.push({
        no: it2.no,
        desc: (mst && mst.descEn) || invDescMap[no] || it2.desc || '',
        descAr: (mst && mst.descAr) || '',
        cat: it2.cat, barcode: (mst && mst.no2) || it2.barcode,
        partNo: (mst && mst.no2) || (img ? img.partNo : ''),
        rsp: (mst && !isNaN(mst.rsp)) ? mst.rsp : null,
        clearancePrice: clearanceMap[no] !== undefined ? clearanceMap[no] : null,
        image: img ? img.image : '',
        stock: stockForItem, rows: rows,
      });
    }
    itemsArr.sort(function (a, b) { return a.no.localeCompare(b.no); });

    return {
      updatedAt: new Date().toISOString().slice(0, 10),
      dateMin: minDate, dateMax: maxDate,
      storeCount: Object.keys(storeCodesUsed).length,
      itemCount: itemsArr.length,
      regions: regions,
      items: itemsArr,
    };
  }

  function fetchCsv(url, want, retries) {
    retries = retries === undefined ? 2 : retries;
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) { return parseCsvPicked(text, want); }).catch(function (err) {
      if (retries > 0) {
        return new Promise(function (resolve) { setTimeout(resolve, 1200); }).then(function () {
          return fetchCsv(url, want, retries - 1);
        });
      }
      throw err;
    });
  }

  function loadSource(key, url, want) {
    var cacheKey = CACHE_KEY + '_raw_' + key;
    return fetchCsv(url, want).then(function (rows) {
      try { localStorage.setItem(cacheKey, JSON.stringify(rows)); } catch (e) {}
      return { rows: rows, stale: false };
    }).catch(function (err) {
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch (e) {}
      if (cached) return { rows: cached, stale: true };
      throw err;
    });
  }

  window.SALES_DATA_STATUS = { state: 'loading' };

  Promise.all([
    loadSource('transactions', URLS.transactions, TX_COLS),
    loadSource('stores', URLS.stores, STORE_COLS),
    loadSource('images', URLS.images, IMG_COLS),
    loadSource('inventory', URLS.inventory, INV_COLS),
    loadSource('master', URLS.master, MASTER_COLS),
    loadSource('clearance', URLS.clearance, CLEARANCE_COLS),
  ])
    .then(function (results) {
      var data = build(results[0].rows, results[1].rows, results[2].rows, results[3].rows, results[4].rows, results[5].rows);
      var anyStale = results.some(function (r) { return r.stale; });
      window.SALES_DATA = data;
      window.SALES_DATA_STATUS = anyStale
        ? { state: 'cached', error: 'Some data could not be refreshed from Google Sheets \u2014 showing last saved copy for that part.' }
        : { state: 'live' };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {}
    })
    .catch(function (err) {
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
      if (cached) {
        window.SALES_DATA = cached;
        window.SALES_DATA_STATUS = { state: 'cached', error: String(err) };
      } else {
        window.SALES_DATA_STATUS = { state: 'error', error: String(err) };
      }
    });
})();
