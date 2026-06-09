if (typeof navigator === 'undefined') {
  global.navigator = { platform: '', userAgent: '' };
}

const api = require('@actual-app/api');
const { google } = require('googleapis');

async function connectToActualBudget() {
  await api.init({
    dataDir: '/tmp',
    serverURL: process.env.ACTUAL_BUDGET_SERVER_URL,
    password: process.env.ACTUAL_BUDGET_PASSWORD,
  });

  const budgetId = process.env.ACTUAL_BUDGET_ID;
  const encryptionPass = process.env.ACTUAL_BUDGET_ENCRYPTION_PASSWORD;

  if (!encryptionPass) {
    await api.downloadBudget(budgetId);
  } else {
    await api.downloadBudget(budgetId, { password: encryptionPass });
  }
}

async function getAccountBalance(accountId) {
  const { data } = await api.runQuery(
    api.q('transactions')
      .filter({ account: accountId, tombstone: false })
      .calculate({ $sum: '$amount' })
      .options({ splits: 'inline' })
  );
  // Actual Budget stores amounts as integer milliunits (100 = $1.00)
  return (data || 0) / 100;
}

async function getAccountBalances() {
  const accounts = await api.getAccounts();
  const results = [];

  for (const account of accounts) {
    const balance = await getAccountBalance(account.id);
    results.push({
      id: account.id,
      name: account.name,
      balance,
      closed: account.closed,
    });
  }

  return results;
}

function buildSheetsAuth() {
  const rawJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    const credentials = JSON.parse(rawJson);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  // Fall back to GOOGLE_APPLICATION_CREDENTIALS file path (standard GCP env var)
  return new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function updateGoogleSheets(accountBalances, dryRun = false) {
  const auth = buildSheetsAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const sheetTab = process.env.GOOGLE_SHEETS_SHEET_NAME || 'Sheet1';

  // Read current sheet rows to find which row each account is on
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTab}!A:C`,
  });

  const rows = response.data.values || [];

  // Build map: lowercase bank name -> 1-based row index
  const rowByName = {};
  rows.forEach((row, i) => {
    if (i === 0) return; // skip header
    const cellName = (row[0] || '').trim();
    if (cellName) rowByName[cellName.toLowerCase()] = i + 1;
  });

  // accountMapping: { "Actual Budget Name": "Sheet Row Name" }
  const accountMapping = JSON.parse(process.env.NETWORTH_ACCOUNT_MAPPING || '{}');

  const updates = [];

  for (const account of accountBalances) {
    if (account.closed) continue;

    const sheetRowName = accountMapping[account.name] || account.name;
    const rowNum = rowByName[sheetRowName.toLowerCase()];

    if (!rowNum) {
      console.log(`  (no sheet row) ${account.name}`);
      continue;
    }

    console.log(`  ${account.name} -> row ${rowNum} "${sheetRowName}": $${account.balance.toFixed(2)}`);
    updates.push({
      range: `${sheetTab}!C${rowNum}`,
      values: [[account.balance]],
    });
  }

  if (updates.length === 0) {
    console.log('No matching accounts found to update.');
    return 0;
  }

  if (!dryRun) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates,
      },
    });
  } else {
    console.log('  (dry run — sheet not written)');
  }

  return updates.length;
}

async function syncNetWorth({ dryRun = false, listOnly = false } = {}) {
  console.log('Connecting to Actual Budget...');
  await connectToActualBudget();

  console.log('Fetching account balances...');
  const accountBalances = await getAccountBalances();

  console.log(`\nAccounts in Actual Budget (${accountBalances.length}):`);
  for (const a of accountBalances) {
    const tag = a.closed ? ' [closed]' : '';
    console.log(`  ${a.name}${tag}: $${a.balance.toFixed(2)}`);
  }

  if (listOnly) {
    await api.shutdown();
    return;
  }

  console.log('\nUpdating Google Sheets...');
  const updatedCount = await updateGoogleSheets(accountBalances, dryRun);

  await api.shutdown();

  const action = dryRun ? 'Would update' : 'Updated';
  console.log(`\n${action} ${updatedCount} account(s) in the sheet.`);
}

module.exports = { syncNetWorth };
