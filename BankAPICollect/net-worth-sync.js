require('dotenv').config();

const { syncNetWorth } = require('./src/functions/SyncNetWorth');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const listOnly = args.includes('--list-accounts');

if (dryRun) console.log('[DRY RUN] Sheet will not be written.\n');
if (listOnly) console.log('[LIST ONLY] Showing Actual Budget accounts then exiting.\n');

syncNetWorth({ dryRun, listOnly })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err.message || err);
    process.exit(1);
  });
